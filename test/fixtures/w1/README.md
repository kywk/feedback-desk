# W1-04 隔離環境驗收準備

這些是測試資料及 HTTP 重放工具，**不是 W1 整合通過證據**。先整合 W1-01、W1-02、W1-03，建立隔離 D1、兩個獨立測試 repo／ELK 測試索引與測試 worker，才能執行完整驗收。不要使用正式資料、正式 token、真正客戶資料或正式外部服務。`projects.json` 中的 marker、索引及客戶文字為測試資料；repo 和索引須由測試環境實際建立，不能用 mock 證明隔離。

## 執行及重放

1. 建立 A、B 專案與各自的 QA scope，依系統支援的方式核發只允許 A／qa 的測試憑證；在隔離 repo 各放唯一 marker。由一般客戶介面建立 A 單，另建立 B 單。記錄實際版本及 ID，不要用 SQL 直接插入取代客戶入口。
2. 複製 `variables.example.json` 到測試環境的暫存目錄，填入實際值；每次使用新的 `operation_id`，確認 operation type、payload 和 result 符合實作契約。`lease_wait_ms` 須長於隔離環境實際租約；每個情境使用乾淨、恰有一筆可領取工作的資料庫，避免另一張單被取走。token 只透過環境變數提供。
3. 設 `W1_BASE_URL` 為隔離服務、`W1_TOKEN` 為 A 憑證，執行：

```sh
node test/fixtures/w1/replay.mjs test/fixtures/w1/events-replay.json /private/tmp/w1-vars.json
node test/fixtures/w1/replay.mjs test/fixtures/w1/cross-project.json /private/tmp/w1-vars.json
node test/fixtures/w1/replay.mjs test/fixtures/w1/ack-replay.json /private/tmp/w1-vars.json
node test/fixtures/w1/replay.mjs test/fixtures/w1/lease-replay.json /private/tmp/w1-vars.json
```

各情境需要各自重設資料；不能在同一已領件狀態下依序直接執行。ACK 遺失透過確實送出請求、讀完並丟棄回應模擬；重送同一 operation ID。這不模擬 TCP 層故障，也不能取代核對資料庫的唯一紀錄與外部權威物件。`events-replay` 在無新增事件期間比較重讀游標，仍需核對事件內容及工作數。`lease-replay` 使用實際時間等待逾期，還需核對代次遞增與 worker B 的實際續辦結果；兩個 claim 不是併發測試。

工具只輸出步驟、狀態碼和等待時間，不輸出 token 或回應內容。失敗會回非零代碼。`node --test test/fixtures/w1/replay.test.mjs` 只驗證重放工具，測試替身不算產品或 Wave 驗收。

## 整合後待跑的證據清單

| 情境 | 操作與必須留存的實際證據 |
| --- | --- |
| 新單與補件 | 由客戶正常開單、重複補讀、再由客戶補件。記事件 ID、cursor、public ID、輸入 revision、每版 work ID 及工作筆數；同版一次、新版另建一次；舊版本寫入 409。 |
| 同時領取與中斷恢復 | 兩個真 worker 同時領件，只有一個有效租約；領件後終止執行個體並等待逾期，由另一個接手。記兩個 instance ID、每次開始時間／次數、generation、階段與前後租約，確認階段可恢復。 |
| ACK 遺失及重送 | 執行意圖與收據腳本，查持久紀錄及外部權威物件，核對只有一筆，變更負載同 ID 為 409。對真正外部呼叫若結果未知，先對帳；不可盲目重送。 |
| 限流／斷線 | 在隔離環境的受控代理回 429 帶 Retry-After、暫時中斷連線，記 worker 每次請求時間、狀態、計數、退避、上限及恢復階段。驗證遵守 Retry-After、有限次重試、有界退避與擾動；再確認沒有重複工作或操作。HTTP 腳本本身不模擬 worker 重試。 |
| 人工接手 | 領件後由團隊入口接手，記前後狀態；舊 worker 的 renew、progress、intent、receipt 均遭拒，不能繼續對外寫入。 |
| 範圍與憑證 | A 憑證取 B 事件為 403、缺失或無效憑證為 401；用真實 W1-02 工具嘗試 A 工作讀 B repo marker、B 日誌索引、未核准 remote、符號連結跳脫及工單中的機密指令，記拒絕與稽核。合法 A 操作仍成功。 |
| 客戶隔離 | 驗客戶能正常讀單與已發送留言，檢查 HTML 及 JSON 不含 work ID、worker ID、租約、scope、內部狀態、意圖／收據、祕密與內部證據；團隊端能追查狀態與關聯 ID。 |

留存受保護的環境／版本、指令、時間、結果、工作紀錄、執行個體、退避紀錄及重新執行證據，並記缺少的依賴與解除條件。不得將 token、客戶資料或內部原始證據放入提交。

## 對真實 Worker 注入限流與斷線

將 worker 的測試服務 URL 指向僅監聽本機的代理 `http://127.0.0.1:18877`；先設定 `W1_UPSTREAM` 為隔離 feedback-desk 的 HTTP(S) origin，然後分別啟動以下兩種情境（每次重啟代理可重設次數）：

```sh
W1_FAULT=rate-limit W1_FAILURES=2 W1_RETRY_AFTER=5 node test/fixtures/w1/fault-proxy.mjs
W1_FAULT=disconnect W1_FAILURES=1 node test/fixtures/w1/fault-proxy.mjs
```

代理記錄每次到達的 UTC 時間與結果，不記錄請求路徑、token 或內容。比對 worker 的持久化退避資料和代理時間；此代理只在請求進入上游前故障，提交後 ACK 遺失由前述重放及持久紀錄檢查涵蓋。代理會轉送授權標頭到指定上游，只能對隔離測試環境使用。測試完關閉代理。

## 可重建的 Miniflare 與 scope 測試

以下手動啟動，不納入未整合產品分支的 `npm test`。Miniflare 使用既有 migration setup 和 `test/worker/helpers.ts`，自動建立兩個專案、scope、hash token，再由客戶 HTTP 表單建立單與補件。測試核對游標重讀、同版工作數、兩個同時領件、補件後新工作與舊租約 409、跨專案 403 和客戶 HTML／JSON。它需要 W1-01 migration、入口及 API 已合併：

```sh
npx vitest run --config vitest.w1.config.ts test/w1/bootstrap.worker.ts
npx vitest run --config vitest.w1.config.ts test/w1/queue-acceptance.worker.ts
```

Scope 測試建立兩個臨時 Git repository 和各自固定的 commit，呼叫實際 W1-02 scope 工具驗證 A 能讀自己的版本、不能讀 B repo／索引、不能穿過符號連結或使用異動的 remote，並核對稽核紀錄。ELK 請求使用替身，不代表真實 ELK 整合通過；測試會自動刪除臨時資料。W1-02 合併後執行：

```sh
node --test test/w1/scope-acceptance.mjs
```

開發期間可用 `W1_SCOPE_MODULE` 指向另一個 worktree 的絕對路徑測試；記錄當時版本，未提交程式碼的結果不能當作整合驗收。完整 W1 驗收仍須真實 worker、重啟、限流及人工接手證據。

## 真實子程序與隔離 HTTP／D1 驗收

整合 W1-03 後，在目標 checkout 執行：

```sh
npm run build
node --test test/w1/runtime-fixture.test.mjs test/w1/runtime-acceptance.test.mjs
```

測試啟動本機 Miniflare 與隔離 D1，套用全部 migration，透過客戶 HTTP 表單開單；實際以獨立 Node 子程序執行 W1-03 CLI。故障代理僅監聽 loopback，在送達前回 429／切斷連線，或讓上游完成寫入後丟棄 ACK。輸出的診斷包含測試工單與工作 ID、代次、階段與毫秒時間，不輸出憑證與客戶內容；請保存結果及 commit。handler 是固定測試替身，不呼叫模型或外部 ELK。scope 隔離與客戶 HTML／JSON 另由前述兩組測試驗證。

重啟案例在 kill 子程序後，直接把隔離 D1 租約時間設為過期來避免等待 60 秒；再以第二個實際子程序確認同一 work、代次遞增、checkpoint 與執行次數。人工接手使用正式團隊 HTTP API 並觀察舊 Worker 續租 409。這些檢查不代表真實部署及外部模型、Git、ELK 已整合。

開發期間可用 `W1_CONSUMER_ENTRY` 指向另一個 worktree 的絕對 CLI 路徑；需清楚記錄版本，只有在最終整合 commit 上重跑才能列為該版本的結果。
