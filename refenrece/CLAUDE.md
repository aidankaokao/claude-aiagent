# CLAUDE.md

此檔案提供 Claude Code（claude.ai/code）在此專案中操作時的參考指引。

## 重要前提

**所有工具、套件、模型的選擇，必須以開源免費為原則。** 避免引入需要付費授權、或商業使用有爭議的工具（包含 npm 套件、二進位工具、AI 模型等）。如果有多個選項，優先選擇 Apache 2.0、MIT、GPL 等明確開源授權的方案。

**每次修改完成後，必須列出所有異動的檔案**，格式如下（依新增／修改／刪除分類）：

```
新增：src/Foo.tsx、src/Foo.css
修改：src/App.tsx、server.js
刪除：（無）
```

## 常用指令

```bash
npm run dev        # 啟動開發伺服器（Vite HMR）
npm run build      # tsc 型別檢查 + Vite 生產環境建置
npm run lint       # ESLint 檢查
npm run preview    # 本地預覽生產環境建置結果
npx tsc --noEmit   # 僅執行型別檢查，不產生輸出
```

## 架構說明

**路由** — 使用 `react-router-dom` v6 的 `BrowserRouter`。`App.tsx` 內部的 `AppRoutes` 元件定義所有路由，頁面對應如下：`/` → Home、`/link` → Link、`/chat` → Chat、`/tts` → Tts、`/celebrity` → Celebrity、`/learner` → Learner、`/ebook` → Ebook、`/paper` → PaperDoc、`/user-manage` → UserManage、`/admin-manage` → AdminManage、`/game` → Game、`/snake` → SnakeGame、`/tetris` → Tetris、`/breakout` → Breakout、`/flappy` → FlappyBird、`/invaders` → Invaders。頁面切換使用 `useNavigate`，子頁面返回首頁透過 `onBack` prop 傳入 `() => navigate('/')`；遊戲頁面（SnakeGame、Tetris、Breakout、FlappyBird、Invaders）的 `onBack` 傳入 `() => navigate('/game')` 返回遊戲中心。

**跨頁狀態** — `App.tsx` 以 `<AuthProvider>` 包住 `<AppRoutes>`，提供全域認證狀態。`AppRoutes` 另持有以下提升至 App 層的狀態：
- `root: TreeItem[]` — `Link.tsx` 的完整連結／資料夾樹狀結構
- `linksEtag: useRef<string>` — 目前 links.json 的 ETag，用於樂觀鎖並發控制
- `linkConflict: boolean` — 發生 409 衝突時顯示 toast 通知（5 秒後自動消失）

其餘頁面（`Chat.tsx`、`Tts.tsx` 等）的所有狀態均由元件自身管理。

**各頁說明**

| 檔案 | 功能 |
|---|---|
| `Home.tsx` | 卡片式導覽頁。`NAV_ITEMS` 陣列驅動卡片格線（`auto-fit minmax(230px,270px)` + `justify-content:center`，`max-width:1200px`）：帶有 `page` 屬性的項目執行內部導航，帶有 `href` 的項目開啟外部連結，帶有 `disabled` 的項目顯示為 Coming Soon，帶有 `forRole: 'user' \| 'admin'` 的項目依登入身份過濾。**admin 身份只顯示有 `forRole: 'admin'` 標記的卡片**（不顯示一般功能卡片）。目前卡片：guest/user 可見：01 頁面連結（hardcoded）、02 LLM 問答、03 民國人物傳、04 學習者、05 電子書問答、06 文獻探索；admin 可見：01 頁面連結（hardcoded）、09 遊戲（`/game`）。帳戶管理／系統管理已移出卡片，僅透過右上角懸浮框進入。（TTS 卡片已暫時移除，`Tts.tsx` 保留備用）右上角以 `.home-top-controls` flex 容器並列：主題切換按鈕 + `UserCircleIcon` 按鈕（guest=灰、user=藍、admin=綠）。點擊 UserCircleIcon 展開懸浮框：未登入時顯示登入／註冊 tab 表單（httpOnly cookie session）；已登入時顯示帳號名稱、角色 badge、帳戶管理／系統管理按鈕、登出。 |
| `Link.tsx` | 階層式連結管理頁，頁面標題「頁面連結」。使用遞迴的 `TreeItem`（`LinkItem` / `FolderItem` 的辨別聯合型別）樹狀結構。`FolderItem` 支援可選 `password?: string` 欄位；有密碼的資料夾在進入、編輯、刪除時會彈出密碼驗證 modal，卡片右下角顯示鎖頭圖示。五個純函式 tree helpers（`treeAdd`、`treeUpdate`、`treeDelete`、`getChildrenAtPath`、`buildBreadcrumbs`）定義於元件外部。樹內導航使用 `navPath: string[]`（從根節點到當前資料夾的 ID 陣列）。**刪除流程**：點擊刪除時先彈出「確認刪除」modal，要求使用者輸入 `DELETE` 後才能執行；若目標是有密碼的資料夾，則在 DELETE 確認後再接著彈出密碼驗證 modal。 |
| `Chat.tsx` | 多服務商 LLM 問答介面。左側 sidebar 提供三個服務商 tab（OpenAI / Gemini / Ollama），各服務商設定獨立保留於記憶體。OpenAI 使用 `gpt-4o-mini`，Gemini 使用 `gemini-2.0-flash`（OpenAI 相容介面），Ollama 需輸入 URL + Model（儲存時自動測試連線）。OpenAI / Gemini 透過 SSE 串流回應，Ollama 透過 NDJSON 串流回應。支援上傳**圖片**（base64 vision；OpenAI/Gemini 使用 `image_url` content block，Ollama 使用 `images` 陣列）；若選用 Ollama 且上傳圖片，badge 下方顯示金色提示「需使用支援視覺的模型（如 llava）」。**AI 回覆訊息泡泡**：hover 時右側顯示動作按鈕群組（`.chat-msg-actions`）—— 所有有內容的回覆顯示**複製**按鈕（`navigator.clipboard.writeText`，點擊後圖示切換為勾選 2 秒）；若回覆包含 markdown 表格額外顯示**下載 PNG**（`html-to-image` `toPng`，截取 `.chat-msg-bubble`，2x retina）與**匯出 CSV** 按鈕。所有設定僅存於記憶體，關閉頁面後自動清除。Topbar 右側顯示**服務商 badge**（金色膠囊標籤，顯示當前對話實際使用的服務商）：badge 使用 `convProvider` state 鎖定——第一則訊息送出時捕捉當時的 `llmProvider`，切換 tab 不改變 badge，直到新對話才重設；未開始對話時顯示當前 tab 選項作為提示（`convProvider ?? llmProvider`）。Topbar 最左側有**新對話按鈕**（對話泡泡 + 加號圖示），點擊清空 messages、重設 `convProvider`、清除 error 與上傳檔案。**Token 追蹤**：OpenAI/Gemini 請求加 `stream_options: { include_usage: true }`，讀取 SSE 最後一個 chunk 的 `usage.total_tokens`；Ollama 讀取最後 NDJSON 行的 `prompt_eval_count + eval_count`；串流結束後呼叫 `reportTokens(user, provider, tokens)`（guest 或 admin 略過），並顯示 `TokenToast`。Topbar 右側加 `<AuthUserIcon />`（顯示用，無互動）。 |
| `Ebook.tsx` | 電子書 LLM 問答頁面（`/ebook`）。使用 `epubjs`（MIT）在瀏覽器端解析 EPUB。介面風格與 Chat.tsx 相同（sidebar + topbar + messages + input）。**上傳流程（UploadPhase 狀態機）**：`idle`（拖曳上傳區）→ `parsing`（spinner）→ `confirming`（書本資訊卡）→ `ready`（問答介面）。書本資訊卡顯示書名、作者、章節數、總字數、預估閱讀時間、詞彙豐富度，以及各章節長度長條圖。**分塊策略**：書本總字元 < 40,000 時使用全文；超過則以 TF-like 關鍵詞評分（`scoreChunk`）選取最相關的 top-3 章節（各截斷至 10,000 字元）；每則 AI 回覆下方顯示「📖 參考章節：…」資訊。**推薦問題**：載入書本後及每次 AI 回覆後自動生成 4 個問題 chip（non-streaming，各 LLM provider 均支援）。**章節摘要**：sidebar 提供「一鍵生成摘要」按鈕，逐章串流生成（`for` loop + `await`），摘要面板在 topbar 下方可折疊（CSS `max-height` transition）；生成完成後出現「下載摘要 PDF」按鈕。**PDF 匯出**：下載問答（`handlePrintQA`）與下載摘要（`handlePrintSummary`）皆使用 `window.open + document.write + window.print`；問答 PDF 使用內建 `markdownToHtml` 函式將 markdown 轉為 HTML 渲染。**Temperature 滑桿**：sidebar 提供 0.0–2.0 調節（OpenAI/Gemini 傳 top-level `temperature`，Ollama 傳 `options.temperature`）。**`epubjs` Vite 相容**：防禦性 import `(typeof (Epub as any) === 'function' ? Epub : (Epub as any).default) as any`；spine section 查找依序嘗試 idref → href → `book.spine.get(index)` 三種方式。**Token 追蹤**：`handleSend` 與 `streamChapterSummary` 均加 token 計數（同 Chat.tsx 機制），`streamChapterSummary` 累加各章節 token 後統一上報。Topbar 加 `<AuthUserIcon />`。 |
| `PaperDoc.tsx` | 文獻探索頁面（`/paper`）。使用者輸入「主題」與「需求描述（選填）」，點擊「探索」後後端同時查詢 **Semantic Scholar API**（`/graph/v1/paper/search`）與 **ArXiv API**（Atom XML），合併去重後回傳。搜尋建議使用英文關鍵詞（ArXiv 對中文查詢回傳零結果）；空白結果時若偵測到非 ASCII 字元會提示改用英文。結果分兩區塊：含 PDF 的論文（可勾選 checkbox）與無 PDF 的論文（僅提供外部連結）。**PDF 下載**透過後端代理端點 `GET /api/papers/pdf?url=...` 繞過瀏覽器 CORS；下載按鈕為 `<a download="論文標題.pdf">` 直接觸發，避免失去 user-gesture 上下文。**勾選流程**：勾選或取消勾選 checkbox 時，立即清空 messages、summaries、convProvider（對話重設規則）；有勾選時顯示浮動確認欄，點「確認所選文件並開始問答」→ `docPhase = 'processing'`，逐一呼叫 `extractPdfText`（透過 `/api/papers/pdf` proxy fetch，以 `pdfjs-dist` + `Uint8Array` 提取文字，workerSrc = `/pdf.worker.min.mjs`）；若平均每頁字元數 < 100 則標記 `hasImageWarning = true`；下載失敗時讀取 server 回傳的 JSON `{ error }` 顯示具體原因（非泛用「HTTP 502」）。處理完成後 `docPhase = 'ready'`，顯示**可折疊文件資訊卡**（點擊標題列展開／收合，預設展開，顯示各 PDF 的頁數、字數、警告 badge）與 Q&A 介面。**上下文選取**：同 Ebook.tsx 的 TF-like `scoreChunk` 邏輯，全部文件合併字數 < 40,000 時全文送入；超過則每份文件取前 10,000 字，依相關性評分後取 top-3。**摘要**：sidebar「一鍵生成摘要」逐篇串流（`for` loop + `await`）；摘要面板位於主畫面**文件資訊卡下方**，為可折疊欄（`pd-summary-panel` / `pd-summary-panel--collapsed`，`max-height` transition），header 含標題、下載摘要 PDF 按鈕（完成後才顯示）、chevron 收折按鈕，body 每篇含標題（DM Mono、金色）＋串流文字＋生成中 spinner（`pd-summary-spinner`）。Topbar 顯示服務商 badge、新對話、返回搜尋結果（SearchIcon）、下載問答 PDF 等按鈕。所有狀態僅存記憶體，`.pd-` CSS 前綴，CSS 樣式定義於 `PaperDoc.css`。**Token 追蹤**：`handleSend` 與 `streamDocSummary` 均加 token 計數，Topbar 加 `<AuthUserIcon />`。 |
| `Tts.tsx` | 中文文字轉語音頁面（暫未掛載於首頁）。左側 sidebar 顯示模型狀態與聲線選單（可收折），主區域含文字輸入卡（支援上傳 `.txt`）與語音輸出卡（HTML5 audio player + 下載 WAV）。透過輪詢 `/api/tts/status` 等待模型就緒。Topbar 加 `<AuthUserIcon />`（顯示用）。 |
| `Celebrity.tsx` | 民國人物傳頁面（`/celebrity`）。人物資料存於 `src/data/celebrities.json`，開發者可自行新增人物。左側浮動人物選擇器（金色邊框按鈕，mask 漸消邊界），右側時間軸隨捲動高亮對應節點並可點擊跳轉，主畫面各生平段落以 IntersectionObserver 觸發進場動效（Apple 式滾動）。預設每 3 秒自動推進下一段落，右上角有 Play/Pause 切換按鈕。亮色模式採多層金色暈散漸層背景 + 細纖維紋理。右上角加 `<AuthUserIcon />`（顯示用）。 |
| `Learner.tsx` | 主題式互動學習頁面（`/learner`）。主題 JSON 存於 `data/learner/{id}.json`，server 動態讀取，無需重啟即可新增主題。左側 sidebar 依分類分組列出主題清單；分類標題在單一分類時隱藏，多分類時顯示為**可點擊按鈕**（`.lr-category-heading`），點擊折疊／展開該分類下的主題列表（`collapsedCats: Set<string>` state + CSS `max-height` transition）；折疊狀態由 chevron 圖示旋轉指示。分類標題樣式：深色模式為金色橫向漸層底色 + 金色文字；亮色模式為深海軍藍（`#1a3060`）底色 + 白色文字。右側主區顯示 hero、level tabs（初階／進階／高階）、各段落內容。段落支援：可點擊高亮關鍵詞（浮動 popover 說明）、程式練習（輸入批改 + 提示 + 答錯後出現「查看答案」按鈕）、行動建議清單。右上角控制列：文字大小切換（小／中／大）、**匯出主題 PDF**（印表機 icon，選中主題時才顯示，輸出所有層級的帶樣式 HTML，`window.print()` 觸發列印）、管理面板（⚙）、主題切換。右下角浮動聊天按鈕（Chat FAB）展開 LLM 問答面板（360×600px 懸浮卡片，AI 回覆以 `react-markdown + remark-gfm` 渲染 markdown，聊天記錄有內容時 header 出現**匯出問答 PDF** 按鈕，跨主題切換時保留各主題獨立對話記錄），聊天輸入框支援中文 IME（`isComposing` 防誤送）。聊天面板 header 顯示**服務商 badge**（金色膠囊，邏輯同 Chat.tsx：`convProvider ?? llmProvider`，鎖定於第一則訊息，切換主題時重設）。亮色模式使用者泡泡改為淡金色底（`rgba(200,169,110,0.18)`）以提升可讀性。管理面板（⚙）提供：**分類管理**（新增自訂分類、刪除空分類需輸入 `DELETE` 確認）、**LLM 設定**（三個服務商 tab：OpenAI API Key、Gemini API Key、Ollama URL + Model；各服務商設定獨立保留；Ollama 儲存時自動測試連線；所有設定僅存記憶體）、貼上 LLM 生成 JSON 匯入主題（可選擇分類，預設「未分類」）、各主題可移動分類、Prompt 生成器（輸入主題名稱後複製填好的 prompt）、各主題的下載 JSON 與刪除（刪除需輸入 `DELETE` 確認）。**Token 追蹤**：`handleChatSubmit` 加 token 計數（同 Chat.tsx 機制），Topbar 加 `<AuthUserIcon />`。 |
| `UserManage.tsx` | 帳戶管理頁面（`/user-manage`，僅 user 角色可訪問；未登入自動 redirect `/`）。顯示帳號名稱、角色，以及累積 token 數。**修改密碼**：輸入目前密碼 + 新密碼 + 確認密碼（PUT `/api/user/password`）。**刪除帳號**：點擊按鈕彈出 modal，輸入密碼確認後 DELETE `/api/user/account`，成功後登出並跳回首頁。**Token 可視化**：近 30 天每日 stacked BarChart（openai=藍、gemini=金、ollama=綠）+ 本月 Provider donut PieChart，使用 `recharts`（MIT）。CSS 前綴 `.um-`，深色預設、`.light` 覆寫。 |
| `AdminManage.tsx` | 系統管理頁面（`/admin-manage`，僅 admin 可訪問；非 admin 自動 redirect `/`）。**總覽**：全站使用者數 + 累積 token 數。**使用者列表**：所有非 admin 帳號（用 GET `/api/admin/users`），可點選列表項目過濾下方圖表；每列右側有「刪除」按鈕，需輸入 `DELETE` 確認後呼叫 `DELETE /api/admin/users/:username`。**Token 可視化**：同 UserManage，可切換「全站」或特定使用者視圖（`GET /api/token-usage/all`）。**資料保留設定**：下拉選單選擇 token 用量紀錄保留期間（一個月/兩個月/三個月/半年/一年，預設一年），儲存後立即清理過期資料（`PUT /api/admin/settings`），載入時自動讀取目前設定（`GET /api/admin/settings`）。**修改管理員密碼**：PUT `/api/user/password`。CSS 前綴 `.am-`，深色預設、`.light` 覆寫。 |
| `Game.tsx` | 遊戲中心頁面（`/game`，admin only 從首頁進入）。以 Home 卡片風格列出全部 5 款遊戲：Snake 貪食蛇（`/snake`）、Tetris 俄羅斯方塊（`/tetris`）、Breakout 打磚塊（`/breakout`）、Flappy 飛翔小鳥（`/flappy`）、Invaders 太空侵略者（`/invaders`）。頂部 topbar：左側返回首頁按鈕 + 標題，右側主題切換 + `<AuthUserIcon />`（顯示用，無互動）。CSS 前綴 `.gm-`，深色預設、`.light` 覆寫，預設 `isDark=true`，`max-width: 900px`。 |
| `SnakeGame.tsx` | 貪食蛇遊戲頁面（`/snake`）。Canvas 繪製，20×20 格（每格 25px）。`onBack` 返回 `/game`（遊戲中心）。綠色霓虹主題（`#00ff88`）。控制：方向鍵 / WASD；Space/P 暫停；R/Enter 重開。計分每食 +10，每 5 食升一級（加速），最高分存 `localStorage('snake-best')`。 |
| `Tetris.tsx` | 俄羅斯方塊遊戲頁面（`/tetris`）。Canvas 繪製，10×20 格（每格 28px），主畫布 280×560。`onBack` 返回 `/game`。青藍霓虹主題（`#00e5ff`）。7-bag 隨機、ghost piece（半透明落點）、next piece 預覽、wall kick 旋轉。控制：← → 移動、↑ 旋轉、↓ 軟降、Space 硬降、P/Esc 暫停、Space 開始/重開。計分：1行×100、2行×300、3行×500、4行×800（×level）；每 10 行升一級（初始 800ms，每級 -60ms，最低 100ms）；最高分存 `localStorage('tetris-best')`。Side panel 顯示 next、score、best、level、lines。 |
| `Breakout.tsx` | 打磚塊遊戲頁面（`/breakout`）。Canvas 420×520，5 行 × 8 列磚塊，橘紅霓虹主題（`#ff6b35`）。`onBack` 返回 `/game`。滑鼠 + 鍵盤（←→/AD）控制擋板。3 條命，每關加速（`baseSpeed = 3.8 + (level-1)*0.45`），行顏色漸層（粉→橘→黃→綠→青），最高分存 `localStorage('breakout-best')`。 |
| `FlappyBird.tsx` | 飛翔小鳥遊戲頁面（`/flappy`）。Canvas 360×560，萊姆綠霓虹主題（`#c6ff00`）。`onBack` 返回 `/game`。重力 + 拍翅物理（GRAVITY=0.38，FLAP=-7.2），捲動水管隨機間距（GAP=148px），鳥身依速度傾斜渲染。控制：Space / ↑ / 點擊畫布；點擊或按鍵開始/重試。最高分存 `localStorage('flappy-best')`。 |
| `Invaders.tsx` | 太空侵略者遊戲頁面（`/invaders`）。Canvas 420×540，紫色霓虹主題（`#e040fb`）。`onBack` 返回 `/game`。4 行 × 9 列外星人，整排步進移動（碰邊界後下移 + 反向），底排存活者隨機向下射擊，射擊頻率依關卡加速。3 條命，每關敵人步進間隔縮短，最高分存 `localStorage('invaders-best')`。控制：←→/AD 移動，Space/Z 射擊，P/Esc 暫停。 |

**後端（server.js）** — Node.js 內建 HTTP server（無 express），ESM。除了服務靜態檔案外，提供：
- `GET /api/links` — 讀取 `data/links.json`，回應帶 `ETag` header（MD5 hash 前 8 碼）
- `POST /api/links` — 寫入 `data/links.json`；若請求帶 `If-Match` 且版本不符回 409（樂觀鎖並發控制），成功後回應新 `ETag`
- `GET /api/learner` — 列出 `data/learner/` 目錄下所有主題（過濾 `.backup.json` 與 `_categories.json`，回傳 `[{ id, name, description, category }]`，category 預設 `'未分類'`）
- `GET /api/learner/:id` — 讀取特定主題完整 JSON（`_categories` id 被保護，回 404）
- `POST /api/learner` — 接收完整主題 JSON，寫入 `data/learner/{id}.json`（id 欄位必須存在且合法，覆寫時直接取代，無備份）
- `DELETE /api/learner/:id` — 刪除 `data/learner/{id}.json`
- `GET /api/learner/categories` — 讀取 `data/learner/_categories.json`，回傳 `['未分類', ...自訂分類]`（**必須在 `GET /api/learner/:id` 之前定義**）
- `POST /api/learner/categories` — 新增分類（`{ name }`），409 若重複
- `DELETE /api/learner/categories/:name` — 刪除分類；若有主題使用該分類回 400 `category-not-empty`
- `GET /api/papers/search?topic=...&desc=...` — 同時查詢 Semantic Scholar + ArXiv，合併去重後回傳 `{ withPdf: Paper[], withoutPdf: Paper[] }`；`fetchExternalText` helper 使用 Node.js `https` 模組（follow redirect，10 秒 timeout）
- `GET /api/papers/pdf?url=...` — 從外部 URL 代理下載 PDF binary（`fetchExternalBinary`，30 秒 timeout），供前端繞過 CORS 限制。含三層驗證：① URL 必須為 http/https（否則 400）；② 外部伺服器必須回 200（否則 502 + 具體狀態碼）；③ 前 4 bytes 必須為 `%PDF` magic bytes（否則 502，提示登入牆或非公開論文）。`fetchExternalBinary` 支援 redirect（相對路徑 Location 以 `new URL(location, urlStr).href` 解析，避免 ArXiv 301 redirect 解析失敗）。server.js MIME 表含 `.mjs: application/javascript`（pdfjs worker 需要）
- `GET /api/admin/settings` — 回傳系統設定（目前僅 `{ token_retention_days: number }`），admin only
- `PUT /api/admin/settings` — 更新系統設定（`{ token_retention_days: 30|60|90|180|365 }`），立即觸發一次 `cleanupTokenUsage()`，admin only
- `GET /api/tts/status` — proxy 至 Python TTS API `/health`，回傳 `{ ready, initializing, error }`
- `GET /api/tts/speakers` — proxy 至 Python TTS API `/speakers`，回傳聲線列表
- `POST /api/tts` — proxy 至 Python TTS API `/tts`，接收 `{ text, speakerId }`，回傳 WAV binary

**vite.config.ts** — 內含 `copyPdfjsWorker` 自訂插件，在每次 `buildStart`（dev / build 皆觸發）時將 `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` 複製至 `public/pdf.worker.min.mjs`，使 worker 以固定路徑 `/pdf.worker.min.mjs` 在 dev 和 production 均可存取（繞過 Vite 8 + rolldown 對 `new URL()` hash 路徑的處理問題）。`public/pdf.worker.min.mjs` 已加入 `.gitignore`。目前 Chat.tsx 的 PDF 功能已移除，此插件保留供未來 PDF 頁面使用。

**TTS 引擎** — 由外部 Python TTS API server 提供，Node.js 透過 HTTP proxy 呼叫。API base URL 由環境變數 `PYTHON_TTS_URL` 設定（預設 `http://host.docker.internal:14000`）。Timeout：status/speakers 5 秒，合成 120 秒。

**Python TTS API 介面**（Node.js 呼叫的端點）：
- `GET /health` → `{ ready, loading, error }`
- `GET /speakers` → `[{ id, name }]`
- `POST /tts` body: `{ text, speaker_id, speed, format }` → WAV binary

**主題切換** — 每個頁面各自管理 `isDark` 布林值，由固定位置的按鈕切換。深色／亮色類別（`.home-root.light`、`.link-root.light`、`.chat-root.light`、`.tts-root.light`、`.cb-root.light`、`.lr-root.light`、`.eb-root.light`、`.pd-root.light`）會覆寫各元件根元素上定義的 CSS 變數。字型：`Noto Sans TC`、`Cormorant Garamond`、`DM Mono`，透過 Google Fonts 載入（定義於 `index.html`）。

**人物資料擴充（Celebrity）** — 在 `src/data/celebrities.json` 中新增一個物件（格式：`id`、`name`、`dates`、`tagline`、`periods[]`），頁面會自動渲染新人物的選擇按鈕與生平內容，無需修改任何程式碼。每個 `period` 含 `id`、`years`、`title`、`content`、`works[]`（可為空陣列）。

**學習主題擴充（Learner）** — 在 `data/learner/` 目錄放入符合格式的 JSON 檔案，頁面重新整理後即自動出現新主題，無需修改程式碼。JSON 格式：`{ id, name, description, category?, levels: { beginner?, intermediate?, advanced? } }`，`category` 為可選欄位（預設 `'未分類'`，值須對應已存在的分類）。每個 level 為 section 陣列（`{ id, title, content, highlights?, practice? }`）。`practice.type` 為 `"code"`（程式輸入批改；答錯後顯示「查看答案」按鈕，展開 `lr-answer-reveal` 顯示參考答案）或 `"action"`（行動建議清單）。也可透過管理面板（⚙）直接貼上 JSON 匯入（匯入時可選擇分類），或使用內建 Prompt 生成器讓 LLM 產生符合格式的主題檔案。分類資料存於 `data/learner/_categories.json`（字串陣列，不含「未分類」）。

## 介面風格基準

新增頁面時請遵循以下設計規範，確保視覺一致性。

---

> ⚠️ **重要：配色方案管理**
>
> 專案支援多套配色方案，切換配色時請完整替換所有頁面的 CSS 變數與背景漸層。目前使用**配色方案一**。
> 若需恢復某套配色，直接以下方對應方案的完整數值覆寫所有 `{page}.css` 的根元素變數即可。

---

### 配色方案一：深藍金色（目前使用）

**識別**：深邃海軍藍底 + 金麥色強調，沉穩典雅，適合資料/學習類應用。

**CSS 變數（深色預設 / `.light` 覆寫）：**

| 變數 | 深色 | 亮色 |
|------|------|------|
| `--bg` | `#050d1a` | `#eef3fb` |
| `--surface` | `rgba(255,255,255,0.13)` | `#ffffff` |
| `--border` | `rgba(255,255,255,0.18)` | `#c8d8f0` |
| `--text` | `#e8e4dc` | `#0e1f3d` |
| `--muted` | `#6b7a90` | `#6e82a4` |
| `--gold` | `#c8a96e` | `#9a6f30` |
| `--gold-dim` | `#8a7249` | `#b8924a` |
| `--input-bg` | `rgba(255,255,255,0.07)` | `#f4f7fd` |
| `--input-border` | `rgba(255,255,255,0.14)` | `#c0d0ec` |
| `--input-focus` | `rgba(200,169,110,0.5)` | `#9a6f30` |
| `--btn-primary` | `#c8a96e` | `#0e1f3d` |
| `--btn-primary-text` | `#0a0a0a` | `#ffffff` |
| `--danger` | `#e05c5c` | `#c94040` |
| `--danger-hover` | `rgba(224,92,92,0.12)` | `rgba(201,64,64,0.08)` |

**背景漸層：**

```css
/* 深色 */
background:
  radial-gradient(ellipse 70% 50% at 15% 10%, rgba(40,100,200,0.18) 0%, transparent 60%),
  radial-gradient(ellipse 55% 45% at 85% 88%, rgba(20,60,150,0.15) 0%, transparent 55%),
  linear-gradient(160deg, #0b1f40 0%, #050d1c 50%, #091528 100%);

/* 亮色（標準） */
background:
  radial-gradient(ellipse 70% 50% at 15% 10%, rgba(100,160,255,0.18) 0%, transparent 60%),
  radial-gradient(ellipse 55% 45% at 85% 88%, rgba(60,120,220,0.10) 0%, transparent 55%),
  linear-gradient(160deg, #ddeaff 0%, #eef3fb 50%, #d8e8ff 100%);

/* Learner 亮色例外（金色漸層） */
background:
  radial-gradient(ellipse 70% 50% at 15% 10%, rgba(200,169,110,0.18) 0%, transparent 60%),
  radial-gradient(ellipse 55% 45% at 85% 88%, rgba(154,111,48,0.12) 0%, transparent 55%),
  linear-gradient(160deg, #fdf6e8 0%, #ffffff 50%, #faf2e0 100%);
```

**新頁面 CSS 範本（配色方案一）：**

```css
/* ── Dark theme (default) ── */
.{page}-root {
  --bg: #050d1a; --surface: rgba(255,255,255,0.13); --border: rgba(255,255,255,0.18);
  --text: #e8e4dc; --muted: #6b7a90; --gold: #c8a96e; --gold-dim: #8a7249;
  --input-bg: rgba(255,255,255,0.07); --input-border: rgba(255,255,255,0.14);
  --input-focus: rgba(200,169,110,0.5); --btn-primary: #c8a96e; --btn-primary-text: #0a0a0a;
  --danger: #e05c5c; --danger-hover: rgba(224,92,92,0.12);
}
/* ── Light theme ── */
.{page}-root.light {
  --bg: #eef3fb; --surface: #ffffff; --border: #c8d8f0;
  --text: #0e1f3d; --muted: #6e82a4; --gold: #9a6f30; --gold-dim: #b8924a;
  --input-bg: #f4f7fd; --input-border: #c0d0ec; --input-focus: #9a6f30;
  --btn-primary: #0e1f3d; --btn-primary-text: #ffffff;
  --danger: #c94040; --danger-hover: rgba(201,64,64,0.08);
}
```

---

### 色彩系統（當前方案快查表）

每個頁面在根元素（`{page}-root`）上定義 CSS 變數，深色為預設，亮色以 `.light` 覆寫：

| 變數 | 深色 | 亮色 | 用途 |
|------|------|------|------|
| `--bg` | `#050d1a` | `#eef3fb` | 頁面背景 |
| `--surface` | `rgba(255,255,255,0.13)` | `#ffffff` | 卡片／面板底色 |
| `--border` | `rgba(255,255,255,0.18)` | `#c8d8f0` | 邊框 |
| `--text` | `#e8e4dc` | `#0e1f3d` | 主要文字 |
| `--muted` | `#6b7a90` | `#6e82a4` | 次要文字／placeholder |
| `--gold` | `#c8a96e` | `#9a6f30` | 強調色（accent） |
| `--gold-dim` | `#8a7249` | `#b8924a` | 淡化強調色 |
| `--input-bg` | `rgba(255,255,255,0.07)` | `#f4f7fd` | 輸入框底色 |
| `--input-border` | `rgba(255,255,255,0.14)` | `#c0d0ec` | 輸入框邊框 |
| `--input-focus` | `rgba(200,169,110,0.5)` | `#9a6f30` | 輸入框 focus 邊框 |
| `--btn-primary` | `#c8a96e` | `#0e1f3d` | 主要按鈕底色 |
| `--btn-primary-text` | `#0a0a0a` | `#ffffff` | 主要按鈕文字 |
| `--danger` | `#e05c5c` | `#c94040` | 錯誤／危險 |
| `--danger-hover` | `rgba(224,92,92,0.12)` | `rgba(201,64,64,0.08)` | 錯誤背景 |

### 背景漸層

大多數頁面使用相同的背景：

```css
/* 深色 */
background:
  radial-gradient(ellipse 70% 50% at 15% 10%, rgba(40,100,200,0.18) 0%, transparent 60%),
  radial-gradient(ellipse 55% 45% at 85% 88%, rgba(20,60,150,0.15) 0%, transparent 55%),
  linear-gradient(160deg, #0b1f40 0%, #050d1c 50%, #091528 100%);

/* 亮色（標準） */
background:
  radial-gradient(ellipse 70% 50% at 15% 10%, rgba(100,160,255,0.18) 0%, transparent 60%),
  radial-gradient(ellipse 55% 45% at 85% 88%, rgba(60,120,220,0.10) 0%, transparent 55%),
  linear-gradient(160deg, #ddeaff 0%, #eef3fb 50%, #d8e8ff 100%);
```

**例外**：`Learner.tsx` 亮色背景採金色／白色漸層（與其他頁面不同）：

```css
/* Learner 亮色 */
background:
  radial-gradient(ellipse 70% 50% at 15% 10%, rgba(200,169,110,0.18) 0%, transparent 60%),
  radial-gradient(ellipse 55% 45% at 85% 88%, rgba(154,111,48,0.12) 0%, transparent 55%),
  linear-gradient(160deg, #fdf6e8 0%, #ffffff 50%, #faf2e0 100%);
```

### 字型

| 字型 | 用途 |
|------|------|
| `Noto Sans TC`, `Microsoft JhengHei` | 主要內文、中文、標題 |
| `DM Mono` | 標籤、索引數字、代碼、說明文字 |
| `Cormorant Garamond` | 裝飾性大標（首頁） |

### 版面結構

**子頁面（有 sidebar）：**
```css
.{page}-root {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
```
- 左側 sidebar：寬 260px，收折後 52px，`backdrop-filter: blur(12px)`
- 右側 main：`flex: 1`，垂直排列 topbar + 內容區

**子頁面（無 sidebar，如 Link）：**
```css
.{page}-root {
  min-height: 100vh;
}
```

### 元件規格

**Topbar**
- 高度：56px，`backdrop-filter: blur(12px)`
- 左側：圖示（gold 色）+ 頁面標題，`font-size: 15px; font-weight: 700; letter-spacing: 0.06em`
- 右側：控制按鈕群組（`gap: 6px`）
- 底部邊框：`1px solid var(--border)`

**Topbar 控制按鈕（主題切換、返回首頁等）**
```css
width: 34px; height: 34px;
border-radius: 8px;
border: 1px solid var(--border);
background: var(--input-bg);
color: var(--muted);
/* hover */ color: var(--gold); border-color: var(--gold-dim); transform: scale(1.08);
```

**Sidebar 收折按鈕**
```css
width: 28px; height: 28px;
border-radius: 6px;
border: 1px solid var(--sidebar-border);
/* hover */ color: var(--gold); border-color: var(--gold-dim); background: rgba(200,169,110,0.08);
```

**主要按鈕（Primary）**
```css
background: var(--btn-primary);
color: var(--btn-primary-text);
border-radius: 8–10px;
/* hover */ opacity: 0.85; transform: translateY(-1px) 或 scale(1.06);
/* disabled */ opacity: 0.3; cursor: not-allowed;
```

**輸入框**
```css
background: var(--input-bg);
border: 1px solid var(--input-border);
border-radius: 8px;
padding: 9px 12px;
font-size: 14px;
/* focus */ border-color: var(--input-focus);
```

**錯誤提示**
```css
color: var(--danger);
background: var(--danger-hover);
border: 1px solid var(--danger);
border-radius: 8px;
padding: 8px 14px;
font-size: 13px; letter-spacing: 0.04em;
```

**狀態指示點**
```css
width: 6px; height: 6px; border-radius: 50%;
/* ok */      background: var(--status-ok);  box-shadow: 0 0 6px rgba(76,175,125,0.5);
/* loading */ background: var(--gold);
/* error */   background: var(--danger);
```

**Sidebar 區塊標題**
```css
font-size: 12px; font-weight: 700;
letter-spacing: 0.18em; text-transform: uppercase;
color: var(--muted);
```

### 動畫

```css
/* 元素進場 */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
animation: fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;

/* 漸入 */
@keyframes fadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* 通用 transition easing（有彈性感） */
transition: ... 0.3s cubic-bezier(0.16, 1, 0.3, 1);
```

### SVG 圖示

所有圖示使用 inline SVG（`viewBox="0 0 24 24"`），`fill="none"`、`stroke="currentColor"`、`strokeWidth="1.8"`、`strokeLinecap="round"`、`strokeLinejoin="round"`，尺寸透過父元素的 `width/height` 控制。不引入外部 icon library。

**新增頁面**

1. 建立 `Page.tsx` 與 `Page.css`
2. 在 `App.tsx` 的 `AppRoutes` 中新增 `<Route path="/xxx" element={<Page onBack={goHome} />} />`
3. 在 `Home.tsx` 的 `NAV_ITEMS` 中新增一張卡片，`page` 屬性填入路由路徑（不含 `/`）

**新增首頁導覽卡片**

`NAV_ITEMS` 中的每個項目需包含 `en`（卡片左上角英文標籤）、`name`、`description`，以及以下三者之一：`page`（路由路徑字串，對應 `/<page>`）、`href`（外部連結）、`disabled: true`（停用）。

## 部署

**建置 Docker image**
```bash
docker build -t link-center:latest .
```

**設定（編輯 `.env`）**
```
UI_PORT=3000
PYTHON_TTS_URL=http://host.docker.internal:14000
```

**啟動容器**
```bash
docker-compose up -d
```

**停止容器**
```bash
docker-compose down
```

**持久化資料目錄**

| 本機路徑 | 容器路徑 | 用途 |
|---|---|---|
| `./data/` | `/app/data/` | links.json（連結樹資料）、learner/（學習主題 JSON） |

遷移時搬運 `data/` 目錄即可無痛移植。

**PostgreSQL**

`docker-compose.yaml` 內含 `postgres:15` 服務，供後續有關聯式資料需求的頁面使用：

| 項目 | 值 |
|---|---|
| container_name | `link-center-postgres` |
| user / password / db | `filecenter` / `Fc2026PgLc!` / `filecenter` |
| volume | `link-center-postgres-vol`（named volume，持久化） |
| ports | `5432:5432`（對外開放，供本機直接連線） |
| 連線 hostname | `postgres`（同 compose 預設 bridge network） |

**資料表結構**

| 資料表 | 說明 |
|---|---|
| `users` | id, username, password_hash, created_at |
| `sessions` | token, user_id, expires_at（24h TTL） |
| `token_usage` | username, date, provider, total_tokens（PK: username+date+provider） |
| `settings` | key, value（目前僅 `token_retention_days`，預設 `'365'`） |

Token 用量定期清理：server 啟動時執行一次 `cleanupTokenUsage()`，之後每 24 小時重複；依 `settings.token_retention_days` 刪除超期紀錄。`docker-compose.yaml` 中 postgres 已加 healthcheck（`pg_isready`），link-center 以 `depends_on: condition: service_healthy` 等待 postgres 就緒；server.js 的 `initDb()` 另有 10 次 retry（間隔 3 秒），全部失敗則 `process.exit(1)`。
