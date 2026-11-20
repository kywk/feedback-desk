# W2 本機隔離專案驗收

2026-11-20。依使用者指定，先驗收 Worker 將修復交付至本機 Git repo，再保留每個專案選用遠端 GitLab 的設定。兩份開源測資已建立於本機的 `.feedback-desk/isolated-projects/`。[準備與操作方式](../../../scripts/agents/fixtures/README.md)

| 任務 | 依賴與範圍 | 提交 |
| --- | --- | --- |
| LOC-01 | 由 `59a05fe` 開始，負責內網 consumer、scope、repair 與 CLI 單測。核對租約、基底與本機 bare repo，檢查通過才以單筆 Git ref 交易建立工作分支 | `a8fa975` |
| LOC-02 | 同一基底，負責 D1 migration 0018、授權、操作意圖、本機收據、團隊查詢與單測。以授權版本綁定交付模式，保留舊 GitLab 登錄 | `806f2e4` |
| LOC-03 | 同一基底，依 LOC-01／02 契約準備隔離案例，兩者整合後以正常 consumer CLI 驗收 | `ee8f486`、`d0cd529` |
| 開源測資 | 固定兩個上游版本與本機快照 SHA，產生各自的 clone、bare repo、scope 與登錄 SQL | `f4b1a7b` |

開發使用 `gpt-6.2-sol / xhigh`，QA 使用 `gpt-6.1-terra / high`。派工工具未提供 fast 參數，實際速度為工具預設。LOC-01 在新工作樹直接跑 CLI 時有三個既有案例缺少 dist，依專案入口先 build 再跑，完整套件通過。

## 開源資料與修復結果

| 專案 | 上游 commit | 本機 main | 實際結果 |
| --- | --- | --- | --- |
| TodoMVC | `ff43b02e59dfa604386bb382034b2cd07c2bcd8a` | `6b4c0ed422426e0252ed95dd065a2854d204b89c` | JavaScript ES5 目錄與上游 tree ID 相同，另含規格與授權。空白標題的新需求在基底的 Docker 檢查重現失敗，修復後 `blank-title` 通過。 |
| Underscore 1.13.7 | `d2e7e613a597bec6b16c946e42c91950dcc1a215` | `0c97491e52e33867681032e9b768453a1a8bd2a7` | 全樹與上游相同。在 Node 及無網路 Docker 執行 `collection-smoke`，涵蓋反向 range 和移除空值，均通過。 |

TodoMVC 工單 `d8fb2425-e3ef-41ad-9b31-dd677ae4b62b`，工作 `a75ac68d58bbba7e5ad8ed25b7ab4cdb`。團隊 API 查回 `local_branch_ready`、`waiting_review` 和通過的檢查。操作識別為 `repair-local:3590696a9d6ea43ab101619f0aa61817da29fb6c50c1b948feb995ba4174f5c5`。持久的分支 `feedback/3590696a9d6ea43ab101619f0aa61817` 指向 `a32484c6f385df64b465cc3306b74efe86b364af`，父提交為本機 main。差異只有 `examples/javascript-es5/src/model.js`。

模型使用本機 HTTP 測試替身，consumer、Git 與 Docker 走實際執行路徑。HTTP／D1 使用暫存 Miniflare，測試結束後釋放，Git 分支保留供審閱。可直接從 feedback-desk 根目錄查證。

```sh
git -C .feedback-desk/isolated-projects/todomvc/origin.git diff main feedback/3590696a9d6ea43ab101619f0aa61817
node scripts/agents/fixtures/prepare.mjs
```

重跑準備工具時兩個裸庫的 main 與 clone 皆通過核對，TodoMVC 修復分支仍可查得。兩份 `register.sql` 也各在套用 0018 的暫存 SQLite 執行兩次，確認每個專案各有一筆 local 登錄、GitLab ID 為 NULL，外鍵檢查通過。

## 最終整合 QA

QA 在獨立工作樹 `/private/tmp/fd-local-integration` 驗證產品提交 `243e6b33f3352bffc821dec130c9cf7cc38af901`。下列 catalog 環境變數使用主工作區實際產出的 scope 檔。

| 實際指令 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過 |
| `FEEDBACK_REPAIR_DOCKER_SMOKE=1 npm test` | Worker 364/364、CLI 113/113，包含本機與 GitLab 路徑的真 Docker 檢查 |
| `node --test test/w2/local-acceptance.test.mjs` | 1/1。正常 CLI 建立一個本機修復分支，相同收據重送取得原結果，變更 HEAD 的重送為 409，客戶端未收到內部成果 |
| `W2_TODOMVC_CATALOG=/Users/kywk/kywk/project/feedback-desk/.feedback-desk/isolated-projects/scope.json node --test test/w2/todomvc-acceptance.test.mjs` | 1/1。從正式 CLI 到真 TodoMVC 工作分支，原始 clone 乾淨 |
| `node --test test/w2/model-fixture.test.mjs test/w2/acceptance.test.mjs` | W2 回歸 16/16。GitLab API 使用測試替身 |
| `npx vitest run --config vitest.w1.config.ts`、`node --test test/fixtures/w1/replay.test.mjs test/w1/scope-acceptance.mjs` | W1 整合 2/2、重放與範圍 5/5 |
| `W1_REAL_LEASE=1 node --test test/w1/runtime-fixture.test.mjs test/w1/runtime-acceptance.test.mjs` | 5/5。首次租約自然到期，代次 2 取得原 checkpoint；429 後相隔 1,011 ms，人工接手後舊租約續租取得 409 |

整合工作樹於驗收後乾淨。`npm test` 的 workerd 結束時輸出一筆 pipe aborted，程序結束碼為 0，無失敗測試。遠端 GitLab 的實機 MR 驗收條件見 [W2 交接紀錄](w2.md)。
