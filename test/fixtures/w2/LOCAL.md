# 本機修復驗收

整合 LOC-01／02 後，以專案最終版本執行：

```sh
npm run build
node --test test/w2/local-acceptance.test.mjs
```

測試透過真正的 consumer CLI 和本機 Miniflare HTTP／D1 建立客戶回報、分析及修復，source clone 的 origin 為 `file:` 臨時裸庫，無 GitLab 設定或憑證；檢查在真正 Docker 容器中執行，需預先備妥測試固定的 Node image digest，不能自動拉取。模型為本機替身。驗證產出分支、基底不變、團隊查回、無 MR 與客戶留言、工作再次輪詢不建立新分支。絕不推送客戶 remote 或上游。這項測試與真實開源專案的補充驗收應各自記錄。
