# Chat Persona API（Cloudflare Worker）

這是 `index.html` 前端的後端：接收你上傳/貼上的聊天內容（文字或截圖），呼叫 Claude API 做真正的分析，回傳結構化 JSON 給前端渲染。前端不再顯示寫死的範例資料。

## 1. 申請 Anthropic API 金鑰

1. 前往 https://console.anthropic.com/ 註冊/登入帳號。
2. 左側選單找到 **API Keys**，點 **Create Key**，複製產生的金鑰（格式類似 `sk-ant-...`，只會顯示一次，先存好）。
3. 到 **Billing** 加值一些額度（就算是免費試用額度也需要綁定，才能實際呼叫 API）。

## 2. 部署 Worker

有兩種方式，選一種就好：

### 方法 A：沒有終端機／不想用指令（網頁操作）

用 `dashboard-bundle.js` 這個檔案，整個 Worker 的程式碼都合併在這一份裡，用複製貼上就能部署，不需要安裝任何東西。

1. 前往 https://dash.cloudflare.com/ 註冊/登入帳號（免費方案就夠用）。
2. 左側選單找 **Workers & Pages** → 點 **Create**（或 **Create application**）。
3. 選 **Create Worker**，取個名字（例如 `chat-persona-api`），點 **Deploy** 先建立一個預設的 Worker。
4. 部署完成後點 **Edit code**（或 **Continue to project** → 進到編輯器頁面），會看到一個線上程式碼編輯器，裡面預設有一段範例程式碼。
5. 打開這個 repo 裡的 `worker/dashboard-bundle.js`，全選（Ctrl/Cmd+A）複製全部內容。
6. 回到 Cloudflare 的編輯器，把裡面原本的範例程式碼全選、刪除，貼上你剛複製的內容。
7. 點右上角 **Save and deploy**（或 **Deploy**）。
8. 部署完成後，回到 Worker 的概覽頁（**Settings** 附近），找到 **Variables and Secrets**（變數與密鑰）區塊：
   - 新增一筆變數，名稱填 `ANTHROPIC_API_KEY`，值貼上你的 `sk-ant-...` 金鑰，類型選 **Secret / Encrypt**（加密），儲存。
   - 存好後通常需要重新部署一次（頁面上會有提示按鈕）讓新變數生效。
9. 回到 Worker 概覽頁，網址通常會顯示在頁面上方，長得像：
   ```
   https://chat-persona-api.<你的 subdomain>.workers.dev
   ```
   複製這個網址，留著下一步用。

之後如果我（Claude）有更新 `worker/src/` 裡的程式碼，需要請我重新產生一次 `dashboard-bundle.js`，你再回到編輯器整份覆蓋貼上、重新部署一次即可。

### 方法 B：有終端機，用 wrangler 指令部署

```bash
cd worker
npm install
npx wrangler login   # 會開瀏覽器要你登入/註冊 Cloudflare 帳號並授權
```

設定金鑰（不會進到程式碼或 git）：

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# 貼上剛剛複製的 sk-ant-... 金鑰，按 Enter

# 選用：限制只有你的網站可以呼叫這個 API（避免被盜用額度）
npx wrangler secret put ALLOWED_ORIGIN
# 例如輸入：https://your-github-username.github.io
```

部署：

```bash
npx wrangler deploy
```

成功後終端機會印出一個網址，長得像：

```
https://chat-persona-api.<你的 subdomain>.workers.dev
```

複製這個網址。

## 3. 設定訂單管理後台（D1 資料庫 + 後台密碼）

訂單管理後台（`admin.html`）需要一個資料庫來存客戶／商品／訂單，用 Cloudflare 的 **D1**（免費額度很夠個人使用）。

### 3.1 建立資料庫

**有終端機：**

```bash
cd worker
npx wrangler d1 create chat-persona-db
```

會印出一段 `database_id`，把它貼到 `worker/wrangler.toml` 裡 `[[d1_databases]]` 那段，取代 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。接著建資料表：

```bash
npx wrangler d1 execute chat-persona-db --remote --file=./schema.sql
```

**沒有終端機（網頁操作）：**

1. Cloudflare Dashboard 左側選單找 **Workers & Pages** → **D1**（或 **D1 SQL Database**）
2. 點 **Create database**，取名 `chat-persona-db`，建立
3. 進到這個資料庫頁面，找 **Console**（可以直接貼 SQL 執行的地方）
4. 打開這個 repo 裡的 `worker/schema.sql`，複製全部內容，貼到 Console 執行
5. 回到你的 Worker（`chat-persona-api`）→ **Settings** → **Bindings** → 新增一個 **D1 Database** binding：
   - Variable name 填 `DB`（要完全一樣）
   - 選你剛建立的 `chat-persona-db`
   - 儲存（可能需要重新部署一次）

### 3.2 設定後台密碼

這個後台只有你自己用，用一組密碼保護就好（不是多人帳號系統）：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

沒終端機的話，一樣在 **Settings → Variables and Secrets** 新增一筆 `ADMIN_PASSWORD`（類型選 Secret），值是你自己設定的密碼。

## 4. 讓前端接上這個網址

打開 repo 根目錄的 `index.html`，找到這一行（在 `<script>` 區塊靠前面的地方）：

```js
const API_BASE = '';
```

改成：

```js
const API_BASE = 'https://chat-persona-api.<你的 subdomain>.workers.dev';
```

**`admin.html`（訂單後台）也要做一樣的事**——打開 `admin.html`，把裡面的 `const API_BASE = '';` 改成同一個 Worker 網址。

存檔、commit、push（或直接編輯 GitHub 上的檔案），GitHub Pages 會自動重新部署。之後打開你網站網址加上 `/admin.html`（例如 `https://your-user.github.io/chat-persona/admin.html`）就能進到訂單後台，用剛剛設定的 `ADMIN_PASSWORD` 登入。

## 5. 串接藍新金流真實付款

前面步驟做完，訂單後台已經可以手動建立訂單、手動標記已付款，拿來記帳、管理客戶完全夠用。這一步是讓**網站上的客戶自己按「前往藍新金流付款」就真的能刷卡扣款、自動解鎖付費報告**——前提是你已經申請到藍新金流的**特約商店資格**且審核通過（後台商店管理頁面顯示「營運狀態：營運中」）。

拿到資格後，藍新後台會給你三個值，**直接在 Cloudflare Dashboard 貼上，不要打字貼進聊天視窗**：

到 Worker 的 **Settings → Variables and Secrets**，新增以下三筆，類型都選 **Secret / Encrypt**：

- `NEWEBPAY_MERCHANT_ID` — 商店代號
- `NEWEBPAY_HASH_KEY` — 32 字元
- `NEWEBPAY_HASH_IV` — 16 字元

再新增兩筆一般變數（Variable，不用加密即可）：

- `NEWEBPAY_NOTIFY_URL` — 填 `https://chat-persona-api.<你的 subdomain>.workers.dev/webhook/newebpay`（藍新伺服器對伺服器背景通知，跟你之前設定的一樣，不用改）
- `NEWEBPAY_RETURN_URL` — 填 `https://chat-persona-api.<你的 subdomain>.workers.dev/return/newebpay`（**注意是導到 Worker，不是導到 chatpersonachatlab.com**——因為藍新的 Return URL 是瀏覽器 POST 導頁，靜態網站沒有後端可以接收這個 POST，要先讓 Worker 驗證完，再由 Worker 把瀏覽器轉導回真正的網站）

儲存後通常需要重新部署一次讓變數生效。

設定好之後，客戶端的真實付款流程是：

1. 客戶在付款頁按「前往藍新金流付款」→ 前端呼叫 `POST /pay/create-order`（不需要登入），Worker 建立一筆訂單、算好 `TradeInfo`/`TradeSha`
2. 前端用隱藏表單把瀏覽器導去藍新的收銀台頁面（`gatewayUrl`），客戶在藍新的頁面上真正刷卡
3. 付款完成，藍新同時：
   - 呼叫 `NEWEBPAY_NOTIFY_URL`（伺服器對伺服器，背景進行）→ Worker 驗證簽章、把訂單標記為已付款
   - 把客戶的瀏覽器導回 `NEWEBPAY_RETURN_URL`（也就是 `/return/newebpay`）→ Worker 一樣驗證＋標記已付款，再把瀏覽器轉導回 `https://chatpersonachatlab.com/?paid=1`
4. 前端看到網址帶 `?paid=1`，會再呼叫一次 `GET /pay/status` 用建立訂單時拿到的權杖跟後端二次確認訂單真的是付款完成，才解鎖付費上傳流程——不會只信任網址參數。

⚠️ `worker/src/newebpay.js` 裡的加解密／簽章演算法是照藍新 MPG API 標準文件寫的，且已經用假金鑔做過完整的加密/解密/簽章驗證測試（確認邏輯正確），但正式上線前，建議先自己實際付一筆 NT$99 走過一次完整流程，確認報告有正常解鎖、後台訂單狀態也正確變成「已付款」。

## 本機測試（不需要先部署）

```bash
cd worker
npm install
npx wrangler dev
```

會在 `http://localhost:8787` 起一個本機版的 API，這時候可以把前端的 `API_BASE` 暫時指向 `http://localhost:8787` 來測試（記得測試完要換回正式網址）。第一次要先設定好本機的 `.dev.vars`：

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-你的金鑰' > .dev.vars
echo 'ADMIN_PASSWORD=你自己設定的後台密碼' >> .dev.vars
```

本機的 D1 資料庫會自動建立在 `.wrangler/` 底下（不會動到雲端的正式資料庫），第一次要先建表：

```bash
npx wrangler d1 execute DB --local --file=./schema.sql
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

以下是訂單管理後台用的端點，除了 `/admin/login`，其他都要在 header 帶 `Authorization: Bearer <token>`（登入後拿到的 token）：

- `POST /admin/login` — `{ password }` → `{ token }`
- `GET /admin/dashboard` — 本月營收、已付款訂單數、待付款訂單數、最新 8 筆訂單
- `GET /admin/customers` / `POST /admin/customers` / `PATCH /admin/customers/:id` / `DELETE /admin/customers/:id`
- `GET /admin/products` / `POST /admin/products` / `PATCH /admin/products/:id` / `DELETE /admin/products/:id`
- `GET /admin/orders`（可加 `?status=pending` 篩選）/ `POST /admin/orders` / `PATCH /admin/orders/:id/status`（`{ status: 'pending'|'paid'|'failed'|'cancelled' }`）
- `POST /admin/create-payment` — `{ orderId }`，回傳藍新收銀台需要的參數（需要先設定好 `NEWEBPAY_*` 金鑰），這是後台手動建單用的，客戶端結帳走的是下面的 `/pay/create-order`
- `POST /webhook/newebpay` — 藍新伺服器對伺服器的付款通知（不是給前端呼叫的，藍新後台設定 Notify URL 指到這裡）

以下是給網站客戶端結帳用的公開端點（不需要登入）：

- `POST /pay/create-order` — `{ relationshipType? }` → `{ orderNo, clientToken, gatewayUrl, merchantId, version, tradeInfo, tradeSha }`，建立一筆 NT$99 訂單並回傳導去藍新收銀台需要的參數
- `GET /pay/status?orderNo=...&token=...` — 用建立訂單時拿到的 `clientToken` 查詢這筆訂單的付款狀態，`token` 對不上就查不到（避免被亂猜訂單號碼）
- `POST /return/newebpay` — 藍新的 Return URL，客戶付款完瀏覽器會被導到這裡（不是給前端 fetch 呼叫的），Worker 驗證完會直接把瀏覽器轉導回 `chatpersonachatlab.com`

## 費用與額度

每次分析都是一次 Claude API 呼叫，會依實際輸入/輸出的 token 數計費（見 https://www.anthropic.com/pricing ）。這個 Worker 已經：
- 把送給模型的文字截斷在最近約 6 萬字，避免單次呼叫過大。
- 每張截圖上限 8 張。

如果流量變大，建議到 Cloudflare Dashboard 幫這個 Worker 的路徑加上 Rate Limiting 規則，避免被濫用刷爆 API 額度。
