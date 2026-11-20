# W2 QA 隔離整合測試

此套件需先整合 W2-01／02／03，並在同一 checkout 建置，手動執行：

```sh
npm run build
node --test test/w2/model-fixture.test.mjs test/w2/acceptance.test.mjs
```

測試每案建立本機 Miniflare HTTP、全新 D1、客戶登入與一般開單入口、臨時 Git 儲存庫，呼叫實際 consumer CLI、W2 handler 與本機模型 HTTP 替身。模型先要求讀取被核准的 Git 基底檔案，回傳分析時引用當次實際取得的 evidence reference。涵蓋說明、補件、新版、重放、0／4／5／7／8／10 與不合法分數、待決需求、過期及同版核准、同一輸入版補證後重新決策、送模型前去敏與客戶資訊隔離。測試顯示去敏工單／工作識別與決策，不輸出憑證或證據原文。

修復旅程對高分與團隊核准中分，各啟動實際 `runConsumer`／W2 handler／repair adapter，使用真實隔離 Git 與本機 bare remote，經真實 D1 intent、receipt 及 `/mr-links`。GitLab API 是替身；它建立 MR 後故意丟失回應，repair adapter 再查回同一 MR。檢查執行器是替身：解開實際變更封存並比對預期內容。兩者不證明真實 GitLab、Docker、模型或部署的可用性。禁止以此測試存取或推送客戶儲存庫。

`test/fixtures/w2/repair-runner.mjs` 是受信任測試驅動，透過 production `runConsumer` 的 workflow 注入替身 transport；不是 production CLI 的預設接線。其他分析測試則啟動 production CLI。實際 GitLab MR 與 Docker 驗收須另外在核准環境執行，沒有權限或環境時記錄為待驗收。
