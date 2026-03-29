# Case 7 — Prompt & Skills Q&A

---

## Q1：Case 7 的 Skills 運作方式是什麼？請對照程式說明整個流程。

### 整體架構

Case 7 的 Skills 系統由三層組成：**資料庫定義層**、**技能執行層（LangGraph）**、**前端介面層**。

```
使用者輸入
    ↓
classify_node（LLM 意圖分類，temperature=0）
    ↓ route_by_skill（條件邊）
    ├── email_node        →  registry.compose_system_prompt("email")
    ├── code_review_node  →  registry.compose_system_prompt("code_review")
    ├── summarizer_node   →  registry.compose_system_prompt("summarizer")
    ├── translator_node   →  registry.compose_system_prompt("translator")
    └── generic_node      →  registry.compose_system_prompt("unknown")
    ↓
  LLM 呼叫（以組合好的 system prompt）
    ↓
  SSE 串流輸出至前端
```

---

### Step 1：資料庫定義技能（database.py）

技能的所有設定都存在 SQLite，共三張核心表：

```
skills              → 技能主檔（name、display_name、description、icon、is_active）
prompt_versions     → 每個技能可有多版本 prompt（v1、v2；含 ab_weight 控制 A/B 流量）
few_shot_examples   → 每個技能的少樣本範例（user_input / expected_output）
```

`seed_data.py` 在啟動前預先寫入 4 個技能，每個技能有 2 個 prompt 版本（A/B 權重各不同）與 1-2 個 few-shot 範例。

---

### Step 2：技能分類（agent.py — classify_node）

```python
# 若 skill_override 存在（使用者手動選擇）→ 直接使用，跳過 LLM
override = state.get("skill_override", "")
if override:
    return {"detected_skill": override, "active_skill": override}

# 否則用 temperature=0 的 LLM 做意圖分類
classify_llm = ChatOpenAI(..., temperature=0)
response = await classify_llm.ainvoke([
    SystemMessage(
        "你是意圖分類助手。根據使用者的輸入，判斷最適合的技能。\n"
        f"可用技能：\n{skill_descriptions}\n\n"
        f"只輸出技能名稱，必須是以下選項之一：{skill_names_str}、unknown"
    ),
    HumanMessage(state["user_input"]),
])
```

**關鍵設計**：分類 LLM 獨立於執行 LLM，固定使用 `temperature=0`，確保同樣的輸入每次路由到相同節點，避免路由結果不穩定。

---

### Step 3：條件邊路由（agent.py — route_by_skill）

```python
def route_by_skill(state: SkillAgentState) -> str:
    skill = state.get("active_skill", "unknown")
    mapping = {
        "email":       "email_node",
        "code_review": "code_review_node",
        "summarizer":  "summarizer_node",
        "translator":  "translator_node",
    }
    return mapping.get(skill, "generic_node")  # 未知意圖 → fallback

graph.add_conditional_edges(
    "classify_node",
    route_by_skill,
    ["email_node", "code_review_node", "summarizer_node", "translator_node", "generic_node"],
)
```

`add_conditional_edges` 的第三個參數是所有可能的目標節點列表，LangGraph 用這份清單做靜態圖驗證。

---

### Step 4：技能執行與 Prompt 組合（agent.py — _execute + registry.py）

每個技能節點（`email_node`、`code_review_node` 等）都呼叫同一個 `_execute` 函式：

```python
async def _execute(state: SkillAgentState, skill_name: str) -> dict:
    # 從 registry 取得組合好的 system prompt
    system_prompt, version_id = registry.compose_system_prompt(skill_name)

    messages_for_llm = [SystemMessage(system_prompt)] + list(state["messages"])
    response = await self.llm.ainvoke(messages_for_llm)

    return {
        "active_skill": skill_name,
        "prompt_version_id": version_id,  # 記錄用哪個版本，供評分分析
        "response": response.content,
        "messages": [AIMessage(response.content)],
    }
```

`registry.compose_system_prompt()` 做三件事：

```python
def compose_system_prompt(self, skill_name, version_id=None) -> tuple[str, int]:
    # 1. 選擇版本：指定 ID（Playground 用）或 A/B 加權隨機
    version = self.select_version(skill_name, version_id)

    # 2. 取得 base prompt
    base_prompt = version["system_prompt"]

    # 3. 注入 few-shot 範例（XML 格式，業界慣例）
    examples = self.get_examples(skill_name)
    if examples:
        examples_block = "\n\n<examples>"
        for ex in examples:
            examples_block += (
                f"\n<example>"
                f"\n<user>{ex['user_input']}</user>"
                f"\n<assistant>{ex['expected_output']}</assistant>"
                f"\n</example>"
            )
        examples_block += "\n</examples>"
        base_prompt += examples_block

    return (base_prompt, version["id"])
```

---

### Step 5：A/B 版本選擇（registry.py — select_version）

```python
versions = conn.execute(
    select(prompt_versions).where(
        prompt_versions.c.skill_id == skill.id,
        prompt_versions.c.is_active == True,
    )
).fetchall()

weights = [v["ab_weight"] for v in versions]
return random.choices(versions, weights=weights, k=1)[0]
```

例如 `email` 技能：v1 ab_weight=60、v2 ab_weight=40，則 60% 的請求使用 v1（正式版），40% 使用 v2（現代簡潔版）。

---

### Step 6：SSE 事件流（api.py）

```python
async for event in agent.astream_events(initial_state, config=config, version="v2"):
    # classify_node 完成 → 通知前端偵測到的技能
    if etype == "on_chain_end" and node_name == "classify_node":
        active_skill = output.get("active_skill", "")
        yield {"event": "skill_detected", "data": json.dumps({"skill": active_skill})}

    # 技能節點產出 token → 串流給前端
    if etype == "on_chat_model_stream":
        cur_node = event.get("metadata", {}).get("langgraph_node", "")
        if cur_node in SKILL_NODES:
            yield {"event": "token", "data": json.dumps({"content": chunk})}

    # 技能節點完成 → 取得使用的版本 ID
    if etype == "on_chain_end" and node_name in SKILL_NODES:
        version_id = output.get("prompt_version_id", -1)
```

SSE 事件順序：`skill_detected` → 多次 `token` → `done`

前端收到 `skill_detected` 後立即顯示技能標籤（在 token 開始之前），讓使用者知道 Agent 用了哪個技能。

---

### 資料流全覽

```
前端送出請求（含 message、skill_override、llm_config）
  ↓
api.py → 建立 / 取得 SkillAgent（依 llm_config 快取）
  ↓
classify_node
  ├── skill_override 已設定 → 直接使用
  └── 否則 → LLM 分類（temperature=0）→ detected_skill
  ↓
route_by_skill（條件邊）→ 路由到對應節點
  ↓
skill_node → registry.compose_system_prompt()
  ├── select_version（A/B 加權 or 指定 ID）
  ├── get_examples（few-shot）
  └── 組合最終 system prompt（base + XML examples）
  ↓
LLM 執行（含多輪對話歷史）
  ↓
astream_events → SSE: skill_detected / token / done
  ↓
儲存訊息至 DB（含 skill_name、prompt_version_id）
  ↓
前端可提交評分（message_id + rating）→ ratings 表
```

---

## Q2：Skills 的定義方式有哪些？DB 儲存 vs 檔案式 vs 其他，各自的差異是什麼？

### 目前 Case 7 的做法：DB 儲存式

技能的 prompt、版本、few-shot 範例全部儲存在 SQLite，透過 `SkillRegistry` 動態載入。

**適合情境**：
- 需要 A/B 測試（多版本同時上線，按比例分流）
- 需要評分與效果追蹤（每次使用記錄版本 ID，回收 rating）
- 需要 Admin UI 讓非工程師也能修改 prompt
- 多租戶場景（不同使用者組、不同 prompt 策略）

**缺點**：
- Prompt 不在版本控制（git）裡，diff / review 不方便
- 新增技能需要先跑 `seed_data.py` 或手動插入 DB
- DB 是隱式依賴，環境遷移需要匯出匯入資料

---

### 業界常見做法二：YAML / JSON 檔案式

許多開源框架（LangChain Hub、Semantic Kernel、AutoGen）的技能（prompt）以 YAML/JSON 檔案定義，放在專案目錄中：

```
skills/
  email/
    skill.yaml          # prompt template、description、metadata
    examples.yaml       # few-shot examples
  code_review/
    skill.yaml
    examples.yaml
```

`skill.yaml` 範例：
```yaml
name: email
display_name: Email 撰寫
description: 根據情境撰寫正式或輕鬆的 email
system_prompt: |
  你是一位專業的商業寫作助手...
  請根據以下需求撰寫 email：
examples:
  - user: "寫一封感謝信給客戶"
    assistant: "親愛的..."
```

**適合情境**：
- Prompt 需要 git 版本控制（可 PR review、diff 看改動）
- 團隊協作，工程師直接改檔案部署
- 功能較固定、不需要 runtime 動態新增技能

**缺點**：
- 修改需要重新部署
- 沒有內建的 A/B 測試機制（需自己加）
- 難以收集 per-version 的評分資料

---

### 業界常見做法三：SKILL.md 檔案式（Claude / Anthropic 官方工具）

這是 Claude Code 的 `/skills` 設計風格（也叫 prompt files 或 instructions files）：

```
.claude/
  commands/
    review-pr.md     # 一個技能 = 一個 markdown 檔案
    commit.md
    deploy.md
```

每個 `.md` 檔案就是一個 skill 的完整定義，包含：
- 技能說明（人讀懂）
- 指令 / 規則
- 變數佔位符 `$ARGUMENTS`

**適合情境**：
- IDE 整合工具（Claude Code、GitHub Copilot 等）
- 一人或小團隊使用
- Prompt 本身就是 documentation（markdown 易讀）
- 用 git 管理即可，無需 DB

**缺點**：
- 無法做 A/B 測試
- 無 runtime 動態載入（需重啟或 reload）
- few-shot 範例要手動嵌在 markdown 裡，格式自訂

---

### 三種做法比較表

| 特性 | DB 儲存式（Case 7） | YAML/JSON 檔案式 | SKILL.md 式（Claude 風格） |
|------|-------------------|-----------------|--------------------------|
| **版本控制（git）** | ✗（DB 不在 git） | ✅ | ✅ |
| **A/B 測試** | ✅（ab_weight） | ✗（需自己實作） | ✗ |
| **評分追蹤** | ✅（ratings 表） | ✗ | ✗ |
| **Runtime 動態新增** | ✅ | ✗（需重啟） | ✗（需 reload） |
| **非工程師可修改** | ✅（Admin UI） | ✗ | 部分（改 md 後 PR） |
| **可讀性** | 低（需查 DB） | 高（YAML 清楚） | 高（markdown 易讀） |
| **部署複雜度** | 高（需 DB + 遷移） | 低（改檔即部署） | 低（改 md 即生效） |
| **多租戶支援** | ✅ | ✗ | ✗ |
| **適合規模** | 中大型系統 | 中型系統 | 個人 / 小工具 |

---

### 混合做法（Production 常見）

實務上，大型系統常結合兩種：

```
skills/
  email/
    skill.yaml        # 版本控制的「基礎設定」（description、metadata）
                      # 不含 system prompt（避免敏感 prompt 進 git）

DB:
  prompt_versions     # 實際 system prompt 存 DB（可 runtime 修改，A/B 測試）
  ratings             # 效果追蹤
```

- 技能**結構定義**放檔案（git 管理）
- 技能**prompt 內容**放 DB（runtime 調整、A/B 測試）
- 這樣可以 git 追蹤技能清單，但 prompt 本身可以靈活修改不需重新部署

Case 7 目前偏純 DB 方案，適合教學展示；若要上生產環境，建議考慮混合做法。

---

## Q3：為什麼 classify_node 要用獨立的 temperature=0 LLM，而不是直接用 self.llm？

`self.llm` 的 temperature 由使用者設定（通常是 0.5~1.0），目的是讓回覆有創意和變化。

但意圖分類是一個**分類任務（classification）**，不需要創意，需要的是穩定輸出：

- temperature=0 → 對同一輸入幾乎必然輸出相同結果
- temperature=0.7 → 同一輸入可能偶爾輸出 `email` 有時輸出 `unknown`，導致路由不穩

因此 `classify_node` 內部另建一個 `classify_llm = ChatOpenAI(..., temperature=0)`，確保路由穩定，不受使用者 temperature 設定影響。

---

## Q5：有參數的 Skill 是怎麼從後端傳到前端、再變成表單的？

這個問題追蹤一條「資料從定義到畫面」的完整路徑，共六站。

---

### 全程示意圖

```
SKILL.md（寫參數）
  ↓ registry.py 解析
  ↓ models.py 定義形狀
  ↓ GET /api/skills 回傳 JSON
  ↓ SkillSelector.tsx 定義 TypeScript 型別
  ↓ PromptPlayground.tsx 決定要不要顯示表單
  ↓ 使用者填表 → assembleParamInput() 組成文字 → 送出
```

---

### 第一站：在 SKILL.md 裡寫 `## Parameters`

```markdown
## Parameters

author     | 撰寫人   | text     | required
period     | 報告週期 | text     | required
highlights | 本週亮點 | textarea | required
blockers   | 阻礙事項 | textarea | optional
```

格式很簡單：每行一個欄位，用 `|` 分隔四個欄：`名稱 | 顯示標籤 | 輸入類型 | 是否必填`。

沒有 `## Parameters` 區段的技能（email、code_review 等）就是「沒有參數」，前端顯示普通 textarea。

---

### 第二站：registry.py 把那幾行文字解析成 list

```python
# registry.py — _parse_skill_md()

for line in params_section.splitlines():
    line = line.strip()
    if not line or '|' not in line:
        continue
    parts = [p.strip() for p in line.split('|')]
    # parts = ['author', '撰寫人', 'text', 'required']
    parameters.append({
        "name":     parts[0],   # 'author'
        "label":    parts[1],   # '撰寫人'
        "type":     parts[2],   # 'text'
        "required": parts[3].lower() == "required",  # True
    })
```

解析後，`parameters` 是一個 Python list，每個元素是一個 dict。這個 list 會被加進技能的整體資料裡，跟 `system_prompt`、`examples` 並排：

```python
return {
    "name": skill_name,
    "system_prompt": "...",
    "examples": [...],
    "parameters": [         # ← 剛解析出來的
        {"name": "author", "label": "撰寫人", "type": "text", "required": True},
        {"name": "period", "label": "報告週期", "type": "text", "required": True},
        ...
    ],
}
```

---

### 第三站：models.py 定義這份資料長什麼形狀

Python 的 list of dict 沒有型別保障。Pydantic model 的作用是「告訴 FastAPI：這份資料應該長這樣，幫我驗證並轉成 JSON」：

```python
# models.py

class SkillParameterInfo(BaseModel):
    name:     str
    label:    str
    type:     str      # "text" | "textarea"
    required: bool

class SkillInfo(BaseModel):
    name:         str
    display_name: str
    ...
    parameters: list[SkillParameterInfo] = []  # ← 預設空 list，舊技能不用改
```

`parameters: list[SkillParameterInfo] = []` 這行的意思：
- 如果技能沒有 `## Parameters`，registry 回傳的 `parameters` 是 `[]`，這裡也會是空 list
- 有參數的技能，這裡就會是有內容的 list

---

### 第四站：GET /api/skills 把整份資料傳給前端

```python
# api.py — GET /api/skills

return [
    SkillInfo(
        name=s["name"],
        ...
        parameters=[SkillParameterInfo(**p) for p in s.get("parameters", [])],
    )
    for s in skill_list
]
```

FastAPI 看到回傳值是 Pydantic model，自動把它序列化成 JSON。前端收到的 JSON 大概長這樣：

```json
[
  {
    "name": "email",
    "display_name": "Email 撰寫",
    "parameters": []
  },
  {
    "name": "weekly_report",
    "display_name": "週報生成",
    "parameters": [
      {"name": "author",  "label": "撰寫人",  "type": "text",     "required": true},
      {"name": "period",  "label": "報告週期", "type": "text",     "required": true},
      {"name": "highlights", "label": "本週工作亮點", "type": "textarea", "required": true},
      {"name": "blockers", "label": "阻礙事項", "type": "textarea", "required": false}
    ]
  }
]
```

---

### 第五站：SkillSelector.tsx 定義 TypeScript 型別

前端用 TypeScript，fetch 拿到 JSON 後，需要告訴 TypeScript 這份資料的形狀。否則 `skill.parameters` 對 TypeScript 來說是 `any`，沒有型別提示。

```typescript
// SkillSelector.tsx

export interface SkillParameterInfo {
  name: string
  label: string
  type: 'text' | 'textarea'
  required: boolean
}

export interface SkillInfo {
  name: string
  display_name: string
  ...
  parameters: SkillParameterInfo[]   // ← 這樣 TypeScript 就知道這個陣列裡有什麼
}
```

這個 interface 和後端的 Pydantic model 是「鏡像」關係——形狀相同，一個是 Python 定義，一個是 TypeScript 定義，中間靠 JSON 傳輸。

---

### 第六站：PromptPlayground.tsx 讀 `parameters` 決定要不要顯示表單

```typescript
// PromptPlayground.tsx

const hasParams = (currentSkill?.parameters?.length ?? 0) > 0

// 判斷「執行」按鈕能不能按：
// 有表單 → 所有 required 欄位都填了才能按
// 沒表單 → inputText 不為空才能按
const isRunDisabled = hasParams
  ? !currentSkill?.parameters.filter(p => p.required).every(p => paramValues[p.name]?.trim())
  : !inputText.trim()
```

渲染表單時，直接用 `.map()` 把 `parameters` 陣列畫成 UI：

```tsx
{currentSkill!.parameters.map(param => (
  <div key={param.name} className="pg-param-field">
    <label>{param.label} {param.required && <span>*</span>}</label>

    {param.type === 'textarea' ? (
      <textarea
        value={paramValues[param.name] ?? ''}
        onChange={e => setParamValues(prev => ({ ...prev, [param.name]: e.target.value }))}
      />
    ) : (
      <input
        type="text"
        value={paramValues[param.name] ?? ''}
        onChange={e => setParamValues(prev => ({ ...prev, [param.name]: e.target.value }))}
      />
    )}
  </div>
))}
```

這就是 SKILL.md 裡的 `type: text` / `type: textarea` 真正發揮作用的地方——渲染 `<input>` 還是 `<textarea>` 就靠它。

---

### 最後：送出前把表單值組成一段文字

點擊「執行」時，`assembleParamInput()` 把各欄位值拼成一段有結構的文字：

```typescript
function assembleParamInput(skill: SkillInfo, values: Record<string, string>): string {
  const lines = ['[週報資訊]']
  for (const p of skill.parameters) {
    const val = values[p.name]?.trim() ?? ''
    lines.push(`${p.label}：`)
    if (val) lines.push(val)
  }
  return lines.join('\n')
}
```

組合後的文字長這樣：
```
[週報資訊]
撰寫人：
Alice
報告週期：
2026-W13
本週工作亮點：
完成 API 重構
修復 3 個 bug
阻礙事項：
```

這段文字就直接當作 `input_text` 送到 `/api/playground/test`，後端看到的還是普通的 `HumanMessage`。

**關鍵理解**：後端完全不知道「這次輸入是從表單來的」。參數表單只是前端的 UI 輔助，讓使用者不用自己手動格式化輸入，最終還是轉成一段文字給 LLM。系統 prompt（SKILL.md 正文）裡有對應的指示，告訴 LLM 怎麼解讀 `[週報資訊]` 格式，這樣就閉環了。

---

## Q4：Playground 端點為什麼不使用 LangGraph Agent？

`/api/playground/test` 直接呼叫 `ChatOpenAI`，沒有走 LangGraph：

```python
async for chunk in llm.astream([
    SystemMessage(system_prompt),
    HumanMessage(req.input_text),
]):
    yield token...
```

原因：

1. **避免對話歷史干擾**：LangGraph agent 有 `MemorySaver`，會帶入前幾輪對話。Playground 每次都應該是獨立單次測試，不受歷史影響。
2. **指定版本**：Playground 需要測試特定版本（`prompt_version_id`），不走 A/B 隨機選擇。
3. **效能**：不需要走完整的分類 → 路由 → 執行流程，直接一次 LLM 呼叫即可。
