# Whippet 巡檢橋接器

在內網以 Node.js 執行。橋接器讀取 Whippet 的巡檢終態與 Run 詳情，將具有效報告的產品斷言失敗送到 Feedback Desk，再把工單關聯寫回 Whippet。

## 設定來源

先在 Whippet 設定巡檢來源及橋接憑證，在 Feedback Desk 啟用對應範圍的巡檢收件並登錄專用 `fdi_` token 及 workspace、test、check 授權。設定檔只填憑證的環境變數名稱。`environment` 與 `scope_revision` 對應 Feedback Desk 的授權範圍，`whippet_environment` 對應 Whippet 的巡檢環境。

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
```

`--once` 輪詢每個來源一頁（每頁最多 100 筆），有來源失敗時回傳非零狀態。無參數時持續輪詢各來源。可用 `FEEDBACK_DESK_INSPECTION_POLL_MS` 調整輪詢間隔（預設 3000 毫秒），用 `FEEDBACK_DESK_INSPECTION_MAX_ATTEMPTS` 調整單次 HTTP 操作的嘗試上限（預設 3 次）。回放依 `source_id` 重查指定 Run，從原收據補送關聯。

讓常駐程序在持久磁碟上使用自己的狀態目錄（權限 `0700`）。修改設定或輪替憑證後重新啟動程序，保留原狀態目錄。每頁的 Run 詳情驗證、分類與所有應寫入的關聯都完成後，才保存該頁游標。回應在提交後遺失時，可重新啟動或回放。橋接器以相同事件與操作識別重送，並核對原收據及兩端的關聯回覆。

終端輸出為 JSON Lines，狀態目錄保存每筆 Run 的送件內容、Feedback Desk 收據與處理結果。`passed` 代表巡檢通過，`purpose_not_inspection` 代表非正式巡檢。`infrastructure`、`cancelled`、`timed_out` 與 `unverified` 可用於維運查核，`test_not_mapped` 及 `check_not_mapped` 可用於核對授權設定。`stale_run` 表示 Feedback Desk 已判定該 Run 早於該問題的結案界線。證據參照以 `whippet:run:<run-id>` 保存，原始報告由 Whippet 管理。

```sh
npm run test:cli -- test/cli/automation-inspection.test.ts
```
