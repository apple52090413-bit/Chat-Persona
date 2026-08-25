Chat Persona 網站

一個純前端（HTML/CSS/JS 全部內嵌於單一檔案）的聊天人格分析 / 塔羅風格互動原型頁面。

## 本機預覽

不需要任何建置工具，直接用瀏覽器開啟 `index.html` 即可，或啟動一個簡易伺服器：

```bash
python3 -m http.server 8000
# 開啟 http://localhost:8000
```

## 部署到 GitHub Pages

`.github/workflows/deploy-pages.yml` 已設定好：每次 push 到 `main` 分支時會自動把整個 repo（含 `index.html`）部署到 GitHub Pages。

若是第一次啟用，需要到 GitHub repo 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**（之後就會自動部署，不用再手動操作）。
