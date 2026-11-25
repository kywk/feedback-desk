# Worker 本機隔離專案

在 Airedale 根目錄執行以下指令。首次執行會從 GitHub 下載固定版本，建立兩個獨立的 Git 專案。再次執行會離線核對基底、設定與 origin，保留已產生的工作分支。可在指令尾端指定其他資料目錄。

```sh
node scripts/agents/fixtures/prepare.mjs
```

| 專案 slug | 匯入內容 | Worker 驗收 |
| --- | --- | --- |
| `sandbox-todomvc` | Vanilla JavaScript ES5 範例、應用規格與授權 | 提交空白標題時略過儲存，一般標題去除首尾空白。這是隔離工單的新需求，原始基底預期未通過。 |
| `sandbox-underscore` | Underscore 1.13.7 完整原始碼樹與授權 | 以 Node.js 載入原始模組，檢查 `range` 與 `compact` 的結果。 |

每個快照以單一 commit 記錄上游位置與版本，檔案沿用上游 Git 物件。專案版本、可讀寫路徑與驗收指令收在 [projects.json](projects.json)。[TodoMVC 原始版本](https://github.com/tastejs/todomvc/tree/ff43b02e59dfa604386bb382034b2cd07c2bcd8a) · [Underscore 原始版本](https://github.com/jashkenas/underscore/tree/d2e7e613a597bec6b16c946e42c91950dcc1a215)

預設位置為 `.feedback-desk/isolated-projects/`。各專案的 `repo/` 是受管工作副本，唯一的 origin 指向同層 `origin.git/`。Worker 把修復提交寫到該 bare repo 的 `feedback/` 分支，`recovery/` 則保留需要續辦的工作。可用以下指令在本機重跑 TodoMVC 工單並查看結果。Docker 需先有 scope 內固定摘要的 Node 映像。

```sh
npm run build
W2_TODOMVC_CATALOG="$PWD/.feedback-desk/isolated-projects/scope.json" node --test test/w2/todomvc-acceptance.test.mjs
git -C .feedback-desk/isolated-projects/todomvc/origin.git for-each-ref --format='%(refname:short) %(objectname)' refs/heads
```

## 為 Worker 選擇專案

本機驗收使用暫存 D1。若要接入持久的隔離環境，先將 D1 升到 migration 0018 並登錄專案與 scope，再於該隔離 D1 執行對應專案的 `register.sql`。將 `FEEDBACK_DESK_SCOPE_CONFIG` 指向產出的 `scope.json`，依檔案填入 `FEEDBACK_DESK_PROJECT_SLUG`、`FEEDBACK_DESK_ENVIRONMENT` 和 `FEEDBACK_DESK_SCOPE_REVISION`，再使用該隔離環境的 automation token 啟動 consumer。[連線與啟動方式](../consumer/README.md)

| 設定 | 本機專案 | 遠端 GitLab 專案 |
| --- | --- | --- |
| Worker repo | `repair.mode = "local"`，`remote` 為專用 bare repo 的絕對 `file://` URL | `repair.mode = "gitlab"`，`remote` 為 GitLab HTTPS URL，填寫 `repair.gitlab` |
| D1 repository | `delivery_mode = 'local'`，`gitlab_project_id` 為 NULL | `delivery_mode = 'gitlab'`，登錄 GitLab project ID 與簽章參照 |
| 團隊成果 | 已驗證的本機分支、HEAD 與檢查收據 | 從 GitLab API 查回的 MR 與 HEAD |

加入自己的本機專案時，可先建專用 bare repo，從原專案一次性匯入核准分支，再從 bare 建立工作副本。參照產出的 scope 填寫兩個路徑、基底 SHA、允許修改的路徑、必要檢查與私有 recovery 目錄。切換交付模式時，Worker 和 D1 使用相同的新 scope revision。既有 GitLab 專案沿用預設 GitLab 模式。[遠端專案設定](../repair/README.md)
