# Case 7: Prompt & Skills 設計

## 前置知識

建議先完成：
- **Case 1**：StateGraph 基礎、SSE 串流
- **Case 2**：條件路由（`add_conditional_edges`）

---

## 概念說明

### 核心問題

單一 LLM 助手很難同時擅長所有任務。Email 需要正式語氣與固定格式；程式碼審查需要技術深度；翻譯需要語言切換指令……每種任務都有各自最適合的 system prompt。

**解決方案：技能（Skill）系統**

將每個任務域封裝為獨立技能，每個技能有自己的 system prompt 與 few-shot 範例，再由意圖分類節點自動選擇正確技能。

### SKILL.md 檔案格式

每個技能放在獨立目錄，以純文字定義：

```
skills/
  email/
    SKILL.md
  code_review/
    SKILL.md
  summarizer/
    SKILL.md
  translator/
    SKILL.md
```

SKILL.md 結構：

```markdown
---
display_name: Email 撰寫
description: 協助撰寫各類商業信件
icon: ✉️
---

（system prompt 本文）

## Examples

### User
（使用者輸入範例）

### Assistant
（期望輸出範例）
```

**為什麼用 .md 檔而非資料庫？**

| 方式 | 優點 | 缺點 |
|------|------|------|
| SKILL.md 檔案 | 可用 Git 版控、編輯器直接修改、人類可讀 | 無法熱更新（需重啟）、無法存多版本 |
| 資料庫 | 熱更新、版本歷史、可程式化管理 | 需要 migration、不易 Code Review |
| YAML/JSON 檔 | 有結構化驗證 | 需引入 pyyaml 等依賴、可讀性較差 |

SKILL.md 特別適合學習與中小型專案；生產環境若需 A/B 測試或多版本管理，才值得引入資料庫。

### 架構圖

```
使用者輸入
    │
    ▼
[classify_node]          ← temperature=0 的 LLM 判斷意圖
    │                       輸出：email / code_review / summarizer / translator / unknown
    │
    ├── email       ──▶ [email_node]
    ├── code_review ──▶ [code_review_node]
    ├── summarizer  ──▶ [summarizer_node]
    ├── translator  ──▶ [translator_node]
    └── unknown     ──▶ [generic_node]
                              │
                              ▼
                           [END]
```

---

## 實踐內容

### 資料夾結構

```
case7_prompt_skills/
  backend/
    agent.py              # SkillAgent：意圖分類 + 技能路由
    skills/
      registry.py         # SkillRegistry：解析 SKILL.md
      email/SKILL.md
      code_review/SKILL.md
      summarizer/SKILL.md
      translator/SKILL.md
    api.py                # FastAPI：/api/skills, /api/chat, /api/playground/test, /api/rating
    database.py           # conversations, messages, ratings 三張表
    models.py             # Pydantic schemas
    config.py
    seed_data.py          # 說明已不需要（技能改為 SKILL.md）
    requirements.txt
  frontend/
    src/
      App.tsx
      Chat.tsx            # 聊天介面 + Sidebar LLM 設定
      Chat.css
      SkillSelector.tsx   # 技能選擇側邊欄元件
      SkillSelector.css
      PromptPlayground.tsx # Prompt 測試場
      PromptPlayground.css
      main.tsx
  docker-compose.yaml
  Dockerfile.backend
  Dockerfile.frontend
  .env.example
  qa.md
```

---

## 程式碼導讀

### 1. SkillRegistry（`backend/skills/registry.py`）

負責載入與解析 SKILL.md，是整個技能系統的核心。

**`_parse_skill_md(skill_name)`**：

```python
def _parse_skill_md(self, skill_name: str) -> dict | None:
    skill_path = SKILLS_DIR / skill_name / "SKILL.md"
    content = skill_path.read_text(encoding="utf-8")

    # 解析 YAML frontmatter（--- 之間）
    end_fm = content.find("\n---\n", 4)
    fm_str = content[4:end_fm]
    body = content[end_fm + 5:]

    for line in fm_str.splitlines():
        key, _, val = line.partition(":")
        meta[key.strip()] = val.strip()

    # 分離 system prompt 與 ## Examples
    examples_match = re.search(r'^## Examples\s*$', body, re.MULTILINE)
    system_prompt = body[:examples_match.start()].strip()
    examples_section = body[examples_match.end():]

    # 解析 User/Assistant 配對
    blocks = re.split(r'^### (User|Assistant)\s*$', examples_section, flags=re.MULTILINE)
    # blocks = ['', 'User', 'text', 'Assistant', 'text', ...]
    i = 1
    while i < len(blocks) - 2:
        if blocks[i] == "User" and blocks[i + 2] == "Assistant":
            examples.append({...})
            i += 4
```

**`compose_system_prompt(skill_name)`**：

```python
def compose_system_prompt(self, skill_name: str) -> str:
    skill = self._parse_skill_md(skill_name)
    prompt = skill["system_prompt"]

    if skill["examples"]:
        block = "\n\n<examples>"
        for ex in skill["examples"]:
            block += f"\n<example>\n<user>{ex['user_input']}</user>\n<assistant>{ex['expected_output']}</assistant>\n</example>"
        block += "\n</examples>"
        prompt += block

    return prompt
```

Few-shot 範例以 XML 格式注入 system prompt 尾端，這是業界慣例（Anthropic 官方文件推薦格式）。

**`get_all_skills()`**：

```python
def get_all_skills(self) -> list[dict]:
    for path in sorted(SKILLS_DIR.iterdir()):
        if path.is_dir() and (path / "SKILL.md").exists():
            skill = self._parse_skill_md(path.name)
            result.append(skill)
```

掃描 `skills/` 目錄，找出所有含 `SKILL.md` 的子目錄，動態建立技能清單。新增技能只需建立新目錄 + SKILL.md，無需修改任何程式碼。

---

### 2. SkillAgent（`backend/agent.py`）

**State 設計**：

```python
class SkillAgentState(TypedDict):
    messages:       Annotated[list, add_messages]
    user_input:     str
    skill_override: str   # 前端手動選擇（空字串 = 自動偵測）
    detected_skill: str   # classify_node 輸出
    active_skill:   str   # 最終使用的技能（override 優先）
    response:       str
```

**classify_node**：

```python
async def classify_node(state):
    # 若前端已手動選擇，直接使用
    override = state.get("skill_override", "")
    if override:
        return {"detected_skill": override, "active_skill": override}

    # 否則呼叫 temperature=0 的 LLM 分類
    classify_llm = ChatOpenAI(..., temperature=0)
    response = await classify_llm.ainvoke([
        SystemMessage(
            "你是意圖分類助手...\n"
            f"可用技能：\n{skill_descriptions}\n\n"
            f"只輸出技能名稱，必須是：{skill_names_str}、unknown"
        ),
        HumanMessage(state["user_input"]),
    ])
    detected = response.content.strip().lower()
```

**為什麼 classify_node 用 temperature=0？**

分類是確定性任務，相同輸入應給出相同技能，避免同一句話偶爾路由到不同節點。

**共用執行邏輯 `_execute()`**：

```python
async def _execute(state, skill_name):
    system_prompt = registry.compose_system_prompt(skill_name)
    messages_for_llm = [SystemMessage(system_prompt)] + list(state["messages"])
    response = await self.llm.ainvoke(messages_for_llm)
    return {"active_skill": skill_name, "response": response.content, "messages": [AIMessage(response.content)]}
```

每個技能節點都呼叫 `_execute()`，差別只在傳入的 `skill_name`。

**路由函數與條件邊**：

```python
def route_by_skill(state) -> str:
    mapping = {
        "email":       "email_node",
        "code_review": "code_review_node",
        "summarizer":  "summarizer_node",
        "translator":  "translator_node",
    }
    return mapping.get(state["active_skill"], "generic_node")

graph.add_conditional_edges(
    "classify_node",
    route_by_skill,
    ["email_node", "code_review_node", "summarizer_node", "translator_node", "generic_node"],
)
```

---

### 3. SSE 事件流（`backend/api.py`）

Chat 端點發出三種事件：

```
event: skill_detected   ← classify_node 完成後，告知前端偵測到哪個技能
data: {"skill": "email"}

event: token            ← 技能節點 LLM 串流 token
data: {"content": "..."}

event: done             ← 完成
data: {"thread_id": "...", "skill": "email", "message_id": 42}
```

前端收到 `skill_detected` 後，更新 Sidebar 上的技能標示。

---

### 4. 前端元件

**SkillSelector.tsx**：顯示所有技能清單，「自動偵測」為預設選項；點擊技能後下一則訊息強制使用該技能；再次點擊已選技能恢復自動偵測。

**PromptPlayground.tsx**：獨立測試場，直接呼叫 `/api/playground/test`，不走 LangGraph，避免對話歷史干擾測試。可預覽 SKILL.md 的 system prompt 與 few-shot 範例（唯讀）。

---

## 執行方式

### 本地開發

```bash
# Backend
cd case7_prompt_skills/backend
pip install -r requirements.txt
python api.py

# Frontend（另一個終端）
cd case7_prompt_skills/frontend
npm install
npm run dev
```

前端開啟 `http://localhost:5173`，在 Sidebar 填入 API Key 後即可使用。

### Docker

```bash
docker network create aiagent-network   # 若尚未建立
cd case7_prompt_skills
cp .env.example .env                    # 設定 BACKEND_PORT / FRONTEND_PORT
docker-compose up -d
```

---

## 測試驗證

1. **自動偵測**：輸入「幫我寫一封詢價信」→ 左側 Sidebar 應顯示偵測到「Email 撰寫」
2. **手動覆蓋**：在 Sidebar 點選「程式碼審查」→ 輸入任何文字 → 應使用 code_review 技能回應
3. **Prompt Playground**：切換到 Playground 分頁 → 選擇「翻譯」→ 展開 System Prompt 確認內容 → 輸入測試文字 → 點擊執行，觀察串流輸出
4. **新增技能**：在 `backend/skills/` 新增目錄與 SKILL.md → 重啟後端 → 前端自動顯示新技能
5. **評分**：對 AI 回覆點擊 👍 / 👎 → 後端 `/api/rating` 記錄到 `ratings` 表

---

## 延伸挑戰

1. **新增技能**：新增一個「會議記錄整理」技能（SKILL.md）並撰寫 2 個 few-shot 範例
2. **改進分類**：classify_node 目前有時會將翻譯請求誤判為其他技能；嘗試改善 system prompt 或 few-shot 範例讓分類更穩定
3. **加入 unknown 技能**：目前 `unknown` 技能沒有對應的 SKILL.md，generic_node 用硬碼 fallback；嘗試新增 `skills/unknown/SKILL.md` 讓 generic_node 也走 registry
4. **CLI 測試工具**：撰寫 `test_skill.py`，從命令列呼叫 `registry.compose_system_prompt("email")` 並印出組合後的完整 prompt，方便除錯
