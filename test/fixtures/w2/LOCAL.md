# 本機修復驗收

整合 LOC-01／02 後，以專案最終版本執行：

```sh
npm run build
node --test test/w2/local-acceptance.test.mjs
```

測試透過真正的 consumer CLI 和本機 Miniflare HTTP／D1 建立客戶回報、分析及修復，source clone 的 origin 為 `file:` 臨時裸庫，無 GitLab 設定或憑證；檢查在真正 Docker 容器中執行，需預先備妥測試固定的 Node image digest，不能自動拉取。模型為本機替身。驗證產出分支、基底不變、團隊查回、無 MR 與客戶留言、工作再次輪詢不建立新分支。絕不推送客戶 remote 或上游。這項測試與真實開源專案的補充驗收應各自記錄。

開源 TodoMVC 範例為另行授權、會在 catalog 指定的隔離 bare 建立可持久保留的 `feedback/` 分支；不會移動 main 或改 checkout。需提供 PM 核准 catalog 的絕對路徑：

```sh
W2_TODOMVC_CATALOG=/absolute/path/to/scope.json node --test test/w2/todomvc-acceptance.test.mjs
```

測試綁定 `sandbox-todomvc`、核准 base 和 `blank-title` 正式容器檢查，模型為本機替身；完成後直接查隔離 bare 分支。不得將 catalog 指向客戶或上游服務。
