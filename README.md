Chat Persona 網站

一個聊天人格分析 / 塔羅風格互動網站。前端（`index.html`）是純 HTML/CSS/JS 單一檔案，部署在 GitHub Pages；`worker/` 是一個 Cloudflare Worker 後端，接上 Claude API 後會真的分析你上傳/貼上的聊天內容（人格分數、關鍵字、關係報告等），不再是寫死的範例資料。

想要「上傳對話 → 開始分析」真的跑出根據你內容生成的結果，需要先部署 `worker/`（見 [`worker/README.md`](worker/README.md)），並把 Worker 網址填進 `index.html` 的 `API_BASE`。沒有設定的話，網站仍然可以瀏覽所有畫面，但按下「開始分析」會顯示提示訊息，說明需要先完成後端設定。

主網站上的付款流程（藍新金流頁面）是刻意做成的原型模擬，不會有任何真實金流或扣款。

`admin.html` 是另外一個獨立的**訂單管理後台**（客戶／商品方案／訂單，含營收總覽），用密碼登入保護，資料存在 Cloudflare D1。要串接真實付款（藍新金流），需要先申請到特約商店資格，設定好金鑰後由後台的 `/admin/create-payment` 產生付款請求、`/webhook/newebpay` 接收付款結果自動更新訂單狀態。詳見 [`worker/README.md`](worker/README.md) 的第 3、5 節。

## 本機預覽

不需要任何建置工具，直接用瀏覽器開啟 `index.html` 即可，或啟動一個簡易伺服器：

```bash
python3 -m http.server 8000
# 開啟 http://localhost:8000
```

## 部署到 GitHub Pages

`.github/workflows/deploy-pages.yml` 已設定好：每次 push 到 `main` 分支時會自動把整個 repo（含 `index.html`）部署到 GitHub Pages。

若是第一次啟用，需要到 GitHub repo 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**（之後就會自動部署，不用再手動操作）。
