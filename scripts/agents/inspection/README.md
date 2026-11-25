# Whippet 巡檢橋接器

在內網以 Node.js 執行。橋接器讀取 Whippet 的巡檢終態與 Run 詳情，將具有效報告的產品斷言失敗送到 Airedale，再把工單關聯寫回 Whippet。

## 設定來源

先在 Whippet 設定巡檢來源及橋接憑證，在 Airedale 啟用對應範圍的巡檢收件並登錄專用 `fdi_` token 及 workspace、test、check 授權。設定檔只填憑證的環境變數名稱。`environment` 與 `scope_revision` 對應 Airedale 的授權範圍，`whippet_environment` 對應 Whippet 的巡檢環境。

```json
{
  "whippet_origin": "https://whippet.example.org",
  "feedback_desk_origin": "https://feedback.example.org",
  "sources": [
    {
      "source_id": "portal-qa",
      "workspace_id": "portal-workspace-id",
      "whippet_environment": "qa",
      "whippet_token_env": "WHIPPET_PORTAL_QA_BRIDGE_TOKEN",
      "project_slug": "portal",
      "environment": "qa",
      "scope_revision": "portal-qa-v1",
      "feedback_desk_token_env": "FEEDBACK_PORTAL_QA_INSPECTION_TOKEN",
      "tests": [{ "test_id": "checkout-test-id", "check_keys": ["checkout-total"] }]
    },
    {
      "source_id": "portal-stage",
      "workspace_id": "portal-workspace-id",
      "whippet_environment": "stage",
      "whippet_token_env": "WHIPPET_PORTAL_STAGE_BRIDGE_TOKEN",
      "project_slug": "portal",
      "environment": "stage",
      "scope_revision": "portal-stage-v1",
      "feedback_desk_token_env": "FEEDBACK_PORTAL_STAGE_INSPECTION_TOKEN",
      "tests": [{ "test_id": "checkout-test-id", "check_keys": ["checkout-total"] }]
    }
  ]
}
```

每組 workspace 與 Whippet 環境對應一個來源。每個來源使用自己的 Whippet 憑證與終態游標，且只接受該來源核准的測試與檢查。服務網址填 HTTPS origin，本機測試可用 loopback HTTP。

## 啟動與回放

```sh
export FEEDBACK_DESK_INSPECTION_CONFIG=/path/to/inspection.json
export FEEDBACK_DESK_INSPECTION_STATE_DIR=/path/to/inspection-state
# 由部署環境注入 JSON 中引用的憑證，再執行下列命令。
node scripts/agents/inspection/cli.mjs --once
node scripts/agents/inspection/cli.mjs
node scripts/agents/inspection/cli.mjs --replay portal-qa 'run-id-from-whippet'
node scripts/agents/inspection/cli.mjs --reconcile portal-qa
```

`--once` 輪詢每個來源一頁（每頁最多 100 筆），有來源失敗時回傳非零狀態。無參數時持續輪詢各來源。可用 `FEEDBACK_DESK_INSPECTION_POLL_MS` 調整輪詢間隔（預設 3000 毫秒），用 `FEEDBACK_DESK_INSPECTION_MAX_ATTEMPTS` 調整單次 HTTP 操作的嘗試上限（預設 3 次）。回放依 `source_id` 重查指定 Run，從原收據補送關聯。

讓常駐程序在持久磁碟上使用自己的狀態目錄（權限 `0700`）。修改設定或輪替憑證後重新啟動程序，保留原狀態目錄。每頁的 Run 詳情驗證、分類與所有應寫入的關聯都完成後，才保存該頁游標。回應在提交後遺失時，可重新啟動或回放。橋接器以相同事件與操作識別重送，並核對原收據及兩端的關聯回覆。

`--reconcile` 向 Airedale 取得指定來源最多 50 筆尚未確認的關聯，逐筆回查 Whippet 目前的 Run、attempt 與證據，補寫 Whippet 再確認 Airedale 的收據。此操作直接使用現行授權，可在本機狀態遺失、輪替授權版本或輪詢清單已前進時補寫。證據或權限已改變的待辦仍保留，程式以非零狀態結束並記錄原因。可重複執行處理後續批次。

終端輸出為 JSON Lines，狀態目錄保存每筆 Run 的送件內容、Airedale 收據與處理結果。`passed` 代表巡檢通過，`purpose_not_inspection` 代表非正式巡檢。`infrastructure`、`cancelled`、`timed_out` 與 `unverified` 可用於維運查核，`test_not_mapped` 及 `check_not_mapped` 可用於核對授權設定。`stale_run` 表示 Airedale 已判定該 Run 早於該問題的結案界線。證據參照以 `whippet:run:<run-id>` 保存，原始報告由 Whippet 管理。

```sh
npm run test:cli -- test/cli/automation-inspection.test.ts
```

## 內網 Worker 提出測試草稿

需要補測試時，用該專案核准的 Whippet Workspace Agent Token，將支援 Streamable HTTP 的 MCP 客戶端連到 `https://<whippet-host>/mcp`。管理者從 Whippet 的 Workspace Agent 存取設定核發專用 Token，再由祕密儲存服務注入 MCP 客戶端的 `Authorization: Bearer …`。巡檢橋接憑證仍用在 `api/inspections`，發布由具該 workspace 權限的 QA 在 Whippet 登入後確認。

在 MCP 客戶端完成 `initialize` 後呼叫 `tools/list`，依實際列出的 schema 執行以下流程。

1. 用 `draft_create` 建立 Module 或 Use Case。Module 參數為 `requestId`（UUID）、`kind: "module"`、`name`、`description` 與 `slug`。Use Case 使用 `kind: "usecase"`，省略 `slug`。保存回傳的 `testId`，供後續驗證與 QA 交接。
2. 呼叫 `draft_get({testId})` 讀取當前的 `editingSession.id`、`draft.revision` 與 `editingSession.contextRevision`。以這三個值和 `testId`、新 `requestId`、`instruction` 呼叫 `author_start`。取得作者任務後按任務提供的 skill 及工具範圍完成工作，再透過 `task_submit` 提出候選。Use Case 的 Plan 交由有權限的人員確認。
3. 再用 `draft_get` 取得候選的當前 revision，呼叫 `validation_request({requestId,testId,editingSessionId,revision})`。`queued` 時保存 `runId`，以 `validation_report({testId,revision,runId})` 讀取正式驗證結果。若回傳 `awaiting_human_plan_confirmation`，待人員確認後重查 revision，再安排驗證。重試同一次寫入時沿用相同 `requestId` 與參數。
4. 交給 QA 的識別資料包括 `testId`、`editingSessionId`、`revision`、`runId` 與驗證結果。QA 在 Whippet 查看目前 revision 的證據與發布摘要，確認後發布。草稿改動後重跑目前 revision 的驗證與摘要。

### 驗收 A10

在隔離 Whippet 上，以 Workspace Agent Token 查 `tools/list` 並執行一次草稿與驗證流程。直接呼叫 MCP `publish` 應回工具錯誤，帶同一 bearer 呼叫 `POST /api/tests/{testId}/publish` 應回 `403`。再用 QA 的平台登入身分確認未驗證草稿遭拒，將成功驗證的草稿改一版後確認舊證據與舊 revision 遭拒，最後以新 revision 的成功報告與摘要完成發布，查回對應的已發布版本。保存測試、revision、驗證 Run、摘要及版本識別。

Whippet Server 的既有測試可複驗 MCP 工具權限、受限巡檢憑證、草稿流程及發布前提。在該 repo 的 `services/server` 執行下列指令，將 `TEST_DATABASE_URL` 指向隔離 PostgreSQL。

```sh
go test -tags=integration ./internal/server -v -run '^(TestM11MCPRegistryReadScopeAndRevocation|TestM11InteractiveMCPAuthorAndWaitingPlan|TestInspectionTerminalFeedAndLink|TestM7EditingLifecycle|TestPublicationRequiresCurrentValidatedRevisionAndReport)$'
```
