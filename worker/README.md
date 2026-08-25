# Chat Persona API（Cloudflare Worker）

這是 `index.html` 前端的後端：接收你上傳/貼上的聊天內容（文字或截圖），呼叫 Claude API 做真正的分析，回傳結構化 JSON 給前端渲染。前端不再顯示寫死的範例資料。

## 1. 申請 Anthropic API 金鑰

1. 前往 https://console.anthropic.com/ 註冊/登入帳號。
2. 左側選單找到 **API Keys**，點 **Create Key**，複製產生的金鑰（格式類似 `sk-ant-...`，只會顯示一次，先存好）。
3. 到 **Billing** 加值一些額度（就算是免費試用額度也需要綁定，才能實際呼叫 API）。

## 2. 安裝 wrangler 並登入 Cloudflare

```bash
cd worker
npm install
npx wrangler login   # 會開瀏覽器要你登入/註冊 Cloudflare 帳號並授權
```

## 3. 設定金鑰（不會進到程式碼或 git）

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# 貼上剛剛複製的 sk-ant-... 金鑰，按 Enter

# 選用：限制只有你的網站可以呼叫這個 API（避免被盜用額度）
npx wrangler secret put ALLOWED_ORIGIN
# 例如輸入：https://your-github-username.github.io
```

## 4. 部署

```bash
npx wrangler deploy
```

成功後終端機會印出一個網址，長得像：

```
https://chat-persona-api.<你的 subdomain>.workers.dev
```

複製這個網址。

## 5. 讓前端接上這個網址

打開 repo 根目錄的 `index.html`，找到這一行（在 `<script>` 區塊靠前面的地方）：

```js
const API_BASE = '';
```

改成：

```js
const API_BASE = 'https://chat-persona-api.<你的 subdomain>.workers.dev';
```

存檔、commit、push（或直接編輯 GitHub 上的檔案），GitHub Pages 會自動重新部署。這樣「上傳對話 → 開始分析」就會真的呼叫 Claude 分析你貼上或上傳的內容，不再是固定的範例結果。

## 本機測試（不需要先部署）

```bash
cd worker
npm install
npx wrangler dev
```

會在 `http://localhost:8787` 起一個本機版的 API，這時候可以把前端的 `API_BASE` 暫時指向 `http://localhost:8787` 來測試（記得測試完要換回正式網址）。第一次要先照上面步驟 3 設定好本機的 `.dev.vars`（或用 `wrangler secret put` 也會被本機開發模式讀到）：

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-你的金鑰' > .dev.vars
```

## API 端點

所有端點都是 `POST`，body 是 JSON，回傳也是 JSON。

- `POST /analyze-persona` — 免費版單人聊天人格分析
  - 輸入：`{ text?: string, images?: [{ mediaType: string, data: base64 }] }`
  - 輸出：人格類型、分數、關鍵字、洞察文字、六段趨勢資料

- `POST /analyze-relationship` — 付費版兩人關係深度分析（第一階段）
  - 輸入：`{ text?, images?, relationshipType: string, milestones: [{date, note}] }`
  - 輸出：完整關係報告 + 2-3 個 AI 追問問題

- `POST /refine-relationship` — 付費版第二階段，納入使用者對追問的回答
  - 輸入：`{ draft: <上一步的完整回傳結果>, answers: [{question, answer}] }`
  - 輸出：更新後的 `personalInsight` / `overallInsight`

- `POST /timeline-followup` — 時間軸事件的追問對話
  - 輸入：`{ event: {date,title,summary,interpretation}, question: string, text?: string }`
  - 輸出：`{ reply: string }`

## 費用與額度

每次分析都是一次 Claude API 呼叫，會依實際輸入/輸出的 token 數計費（見 https://www.anthropic.com/pricing ）。這個 Worker 已經：
- 把送給模型的文字截斷在最近約 6 萬字，避免單次呼叫過大。
- 每張截圖上限 8 張。

如果流量變大，建議到 Cloudflare Dashboard 幫這個 Worker 的路徑加上 Rate Limiting 規則，避免被濫用刷爆 API 額度。
