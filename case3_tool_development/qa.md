# Case 3: Tool Development — Q&A

---

## Q2：開源能力較弱的 LLM 可以做 ReAct Agent 嗎？如何補強到接近強模型的水準？

### 一、弱模型在 ReAct 哪些地方會出問題？

ReAct 對模型有三個隱性要求：

| 能力要求 | 具體行為 | 弱模型的常見失敗 |
|----------|----------|-----------------|
| **工具選擇** | 從多個工具中選出正確的 | 選錯工具、不呼叫工具而直接猜答案 |
| **參數提取** | 從上下文提取正確的參數值（如 product_id） | 亂填參數、忽略 schema 格式 |
| **迴圈終止** | 知道何時停止呼叫工具、直接回答 | 無限呼叫工具，或過早放棄 |

能力越弱的模型，在「工具 schema 複雜」或「需要跨工具傳遞結果」時越容易出問題。

---

### 二、補強策略

以下補強方法**不需要換模型**，全部可以在 Case 3 的架構內實作。

---

#### 策略 1：精化 System Prompt（最高 CP 值）

弱模型最怕「模糊指令」。在 `llm_node` 呼叫 LLM 前注入明確的 system prompt，直接告訴它：

```python
async def llm_node(state: AgentState):
    system = SystemMessage(content="""你是庫存管理助手，只能使用以下四個工具：
1. query_inventory  — 查詢產品清單與庫存數量
2. update_stock     — 修改庫存數量（需要 product_id，從 query_inventory 結果取得）
3. get_weather_forecast — 查詢天氣與出貨建議
4. calculate_reorder — 計算補貨量（需要 product_id，從 query_inventory 結果取得）

規則：
- 若需要 product_id，必須先呼叫 query_inventory 取得，不可自行猜測
- 取得足夠資訊後直接回答，不要重複呼叫同一工具
- 若工具回傳錯誤，根據錯誤訊息修正參數後重試""")

    response = await self.llm.ainvoke([system] + state["messages"])
    return {"messages": [response]}
```

**效果**：明確列出工具名稱與使用順序，消除選錯工具的機率。

---

#### 策略 2：在工具 docstring 加入 Few-Shot 範例

弱模型常看不懂抽象的 `Field(description)`，但能從**具體例子**學習。在每個工具的 docstring 補上輸入輸出範例：

```python
@tool(args_schema=QueryInventoryInput)
def query_inventory(keyword: str = "", ...) -> str:
    """
    查詢庫存中的產品資訊。

    範例輸入：{"keyword": "手機", "low_stock_only": false}
    範例輸出：[ID:2] 智慧型手機（電子產品） | 庫存：8 / 安全庫存：10 | 單價：NT$25,000 | ⚠️ 庫存不足

    注意：回傳的 [ID:X] 就是其他工具所需的 product_id。
    """
```

**效果**：模型看到「範例輸出中的 `[ID:2]` 就是 product_id」，大幅降低跨工具參數提取的失誤。

---

#### 策略 3：減少工具數量 / 拆分工具職責

工具越多，弱模型選錯的機率越高。若某兩個工具常被一起使用，可以直接**合併成一個工具**：

```python
@tool
def query_and_reorder(product_name: str, days_to_cover: int, daily_demand: float) -> str:
    """查詢產品庫存並直接計算補貨建議，一步完成。"""
    # 內部自己呼叫 query_inventory 邏輯，再呼叫 calculate_reorder 邏輯
```

**取捨**：合併工具減少了 LLM 的決策負擔，但降低了靈活性。適合「高頻固定組合」的工具對。

---

#### 策略 4：加入意圖前置分類節點

在 `llm_node` 之前加一個輕量的分類節點，**先判斷使用者意圖**，再限縮 LLM 可以使用的工具集：

```
使用者問題
    ↓
[intent_node]（只做分類，不呼叫工具）
    ↓ 判斷意圖（查詢/更新/天氣/補貨）
    ↓
[llm_node]（只拿到與意圖相關的 1-2 個工具）
```

```python
def intent_node(state: AgentState):
    """用關鍵字或小模型快速分類意圖，決定本次只開放哪些工具"""
    last_msg = state["messages"][-1].content.lower()
    if any(k in last_msg for k in ["庫存", "查詢", "有多少"]):
        return {"active_tools": ["query_inventory"]}
    elif any(k in last_msg for k in ["更新", "入庫", "出庫"]):
        return {"active_tools": ["query_inventory", "update_stock"]}
    elif any(k in last_msg for k in ["天氣", "出貨"]):
        return {"active_tools": ["get_weather_forecast"]}
    else:
        return {"active_tools": ALL_TOOLS}  # 不確定則全開
```

`llm_node` 依 `active_tools` 動態 `bind_tools()`，讓弱模型在更小的選項空間中做決定。

**效果**：從「4 選 1」變成「2 選 1」甚至「1 選 1」，大幅降低選錯工具機率。

---

#### 策略 5：讓工具輸出更「機器友好」

弱模型提取參數時依賴工具回傳的文字格式。將輸出改為**結構更明確**的格式：

```python
# 改前（弱模型容易漏掉 ID）
"[ID:2] 智慧型手機（電子產品） | 庫存：8 ..."

# 改後（明確標記「用此 ID 呼叫其他工具」）
"product_id=2 | 名稱=智慧型手機 | 庫存=8 | 安全庫存=10\n"
"→ 若要更新庫存或計算補貨，請使用 product_id=2"
```

或者直接在工具輸出末尾加提示語：

```python
return result + "\n（下一步：如需計算補貨量，請用上方的 product_id 呼叫 calculate_reorder）"
```

---

### 三、補強效果對照

| 補強策略 | 解決的問題 | 實作難度 |
|----------|-----------|---------|
| 精化 System Prompt | 選錯工具、不知道何時停止 | ⭐ 極低 |
| docstring 加 Few-Shot | 參數填錯、跨工具參數提取失敗 | ⭐ 極低 |
| 合併高頻工具 | 決策步驟太多、選錯工具 | ⭐⭐ 低 |
| 意圖前置分類節點 | 工具選錯、模型不知從何下手 | ⭐⭐⭐ 中 |
| 結構化工具輸出 | 跨工具參數提取失敗 | ⭐ 極低 |

---

---

## Q3：加了統計工具之後，是否每換一種統計需求就要再寫一個工具？有沒有更通用的做法？

### 一、核心限制

工具是「預先寫好的函式」，只能做設計時想到的那種計算。每種統計邏輯不同，就需要新工具或修改現有工具。這是預定義工具的根本限制。

---

### 二、三種應對方向

#### 方向一：繼續加工具（現在的做法）

每種統計需求寫一個工具。

- **優點**：結果精確、工具職責清楚、不依賴 LLM 生成邏輯
- **缺點**：使用者每問一個新統計，就要改程式

適合：**需求固定、統計邏輯確定** 的場景（如固定報表）

---

#### 方向二：加一個「任意 SQL 查詢」工具（Text-to-SQL）

```python
@tool
def run_inventory_query(sql: str) -> str:
    """執行 SELECT 查詢，回傳統計結果。
    LLM 自行根據使用者問題生成 SQL。"""
```

讓 LLM 自己生成 SQL，一個工具解決所有統計需求。

- **優點**：極度靈活，理論上能回答任意統計問題
- **缺點**：
  - LLM 寫的 SQL 不一定正確（尤其邏輯複雜時）
  - 直接開放 SQL 有安全疑慮（需限制為 SELECT only）
  - 表結構或欄位含有大量**專有名詞**時，LLM 生成品質明顯下降

Text-to-SQL 的實際表現取決於：表結構複雜度、問題語意與欄位名稱的對應程度。簡單表 + 通俗問題效果不錯；複雜邏輯 + 領域專有名詞效果很差。

適合：**需求不固定、統計邏輯多變** 的場景

---

#### 方向三：為 `get_inventory_stats` 加入更多參數

加入 `group_by`、`sort_by`、`filter_by` 等參數，讓同一個工具支援更多變體。

- **缺點**：參數一複雜，弱模型填錯的機率上升，等於把問題從「計算出錯」轉移為「參數填錯」

---

### 三、建議優先順序

```
1. 高頻固定需求 → 加專用工具（方向一）
2. 需求多變 → Text-to-SQL，但要做好 schema 說明與安全限制（方向二）
3. 需求固定但有少量變體 → 擴展現有工具參數（方向三）
```

---

### 四、建議的優先順序

若模型能力有限，建議依以下順序嘗試：

```
1. 先做：精化 System Prompt + docstring Few-Shot
   → 成本最低，效果最顯著

2. 再做：結構化工具輸出格式
   → 讓模型更容易「複製貼上」參數

3. 若仍不穩：加入意圖前置分類
   → 減少模型每次需要做的決策數量

4. 最後才考慮：合併工具
   → 會降低靈活性，是最後手段
```

大多數情況下，**1 + 2** 就能讓中等能力的開源模型（如 Llama-3、Qwen2.5、Mistral）在定義清晰的任務上達到接近 GPT-4o-mini 的效果。

---

## Q1：如果一個問題需要用到多個工具，Agent 如何設計讓它依序調用？參數怎麼來？工具間如何傳遞結果？

這三個問題的答案都指向同一個機制：**ReAct 迴圈 + LLM 的上下文推理**。沒有任何「串接工具」的特殊程式碼，全靠圖的循環設計與 LLM 的語言推理能力。

---

### 一、多工具調用靠「迴圈」而非「管線」

Agent 的圖結構是一個循環，不是線性的管線：

```
START → llm_node → should_continue → tools → 回到 llm_node → ...
```

每次 `llm_node` 執行完，`should_continue` 檢查：
- **有 `tool_calls`**：去執行工具，執行完**回到 `llm_node`**
- **沒有 `tool_calls`**：結束

這意味著 LLM 可以在一次對話中**多次進入 llm_node**，每次都帶著累積的完整對話歷史（包含所有工具的輸出），再決定下一步。沒有任何地方寫死「先呼叫 A 再呼叫 B」，完全由 LLM 在每個回合自行決定。

**程式碼的關鍵在這兩行（`agent.py`）：**
```python
graph.add_conditional_edges("llm_node", should_continue, {"tools": "tools", END: END})
graph.add_edge("tools", "llm_node")  # 工具執行完 → 固定回到 LLM
```

---

### 二、LLM 怎麼知道要帶什麼參數？

靠兩個來源：**工具 schema（Field description）** 和 **對話歷史**。

**來源 1：`args_schema` 的 Field description**

Case 3 的工具用 Pydantic `BaseModel` 定義 schema，每個欄位都有 `Field(description="...")`：

```python
# tools/inventory.py
class UpdateStockInput(BaseModel):
    product_id: int = Field(
        description="要更新的產品 ID（可從 query_inventory 結果中取得）"
    )
    change_amount: int = Field(
        description="庫存異動數量。正數表示入庫（增加），負數表示出庫（減少）"
    )
    reason: str = Field(
        default="",
        description="異動原因，例如：進貨補充、銷售出庫、庫存盤點調整"
    )
```

`bind_tools(ALL_TOOLS)` 會將這些 schema 序列化後附進每次送給 LLM 的 API request。LLM 在生成 `tool_calls` 時，是在「閱讀這份說明書後填寫表單」。

**來源 2：對話歷史（上下文）**

`AgentState` 的 `messages` 串列儲存了完整的對話歷史，包含每一輪的 ToolMessage。當 LLM 需要填入來自上一個工具輸出的值，它直接從 `messages` 中讀取。

---

### 三、工具輸出如何成為下一個工具的輸入？

以「查詢庫存不足的產品，再計算補貨量」為例，`state["messages"]` 的演變：

```
第 1 輪 llm_node：
  看到使用者問題 → 決定先呼叫 query_inventory
  → AIMessage { tool_calls: [{ name:"query_inventory", args:{low_stock_only:true} }] }

ToolNode 執行 query_inventory：
  → ToolMessage { content: "[ID:2] 智慧型手機 | 庫存：8 / 安全庫存：10 ..." }
    （注意：回傳文字中明確包含了 ID:2）

第 2 輪 llm_node：
  此時 messages = [使用者問題, AIMessage(tool_calls), ToolMessage(query結果)]
  LLM 讀到 "ID:2 智慧型手機，庫存8" → 判斷要計算補貨量
  → AIMessage { tool_calls: [{ name:"calculate_reorder", args:{product_id:2, days_to_cover:30, daily_demand:2} }] }
  （product_id:2 就是從上一個 ToolMessage 的文字中提取的）

ToolNode 執行 calculate_reorder：
  → ToolMessage { content: "建議補貨量：54 件，預估成本：NT$1,350,000" }

第 3 輪 llm_node：
  messages 現在包含了全部 4 則 → LLM 整合所有資訊 → 生成最終文字回覆
  → AIMessage { content: "智慧型手機目前庫存不足，建議補貨 54 件..." }
  → tool_calls 為空 → should_continue 返回 END
```

**關鍵洞察**：工具不需要互相「認識」，也沒有任何程式碼在工具之間傳遞資料。`ToolMessage` 的輸出文字進入 `messages`，LLM 在下一輪閱讀這段文字時，像人類一樣「理解」其中的資訊（如 ID:2），然後自行決定填入哪個參數。

這就是為什麼工具的回傳字串要設計得夠清楚：

```python
# tools/inventory.py — query_inventory 回傳格式刻意包含 ID
results.append(
    f"[ID:{r.id}] {r.name}（{r.category}）"
    f" | 庫存：{r.quantity} / 安全庫存：{r.min_stock} ..."
)
```

如果回傳格式模糊（如只回傳 `"智慧型手機庫存不足"`，沒有 ID），LLM 就無法從中取得 `product_id`，下一個工具呼叫就會失敗。

---

### 四、流程圖總覽

```
使用者：「庫存不足的產品，幫我算 30 天補貨量」
          ↓
    [llm_node 第1輪]
    閱讀工具 schema → 決定先查庫存
    → tool_calls: query_inventory(low_stock_only=true)
          ↓
    [ToolNode]
    執行 query_inventory → ToolMessage 含產品清單（帶 ID）
          ↓
    [llm_node 第2輪]
    閱讀 ToolMessage → 從文字中取出 product_id
    → tool_calls: calculate_reorder(product_id=X, days_to_cover=30, ...)
          ↓
    [ToolNode]
    執行 calculate_reorder → ToolMessage 含補貨建議
          ↓
    [llm_node 第3輪]
    整合所有結果 → 生成最終回覆
    → tool_calls 為空 → END
```

---

### 五、小結

| 問題 | 答案 |
|------|------|
| 多工具如何依序調用？ | ReAct 迴圈：`tools → llm_node → tools → ...`，不是管線，每輪由 LLM 自行決定 |
| 參數從哪來？ | 來自 `Field(description)` 說明書 + 使用者原始問題 |
| 跨工具傳遞結果？ | ToolMessage 進入 `messages` 歷史，LLM 在下一輪從文字中提取需要的值 |
| 程式設計者要做什麼？ | 確保工具回傳文字包含足夠資訊（如 ID），並寫好 `Field(description)` |
