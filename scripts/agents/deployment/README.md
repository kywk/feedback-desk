# 部署後重測橋接器

內網 Worker 收到 CI/CD 簽署的部署紀錄後，先核對實際上線版本，再送 Airedale。Airedale 用已保存的工單、MR commit、環境及核准的巡檢對應判定是否建立重測。橋接器依權威重測意圖向 Whippet 排程，查回正式 Run 的終態證據，再送 Airedale 套用結果。

## 設定來源與授權

在 Airedale 啟用該專案環境的部署、重測授權，登錄 deployment 用的 `fdd_` token、retest 用的 `fdr_` token、可信來源和元件，並設定 MR 或巡檢的核准重測對應。Whippet 使用同一 workspace 與環境下分別具備排程與讀取權限的 bearer，並設定該部署目標、`deploymentProofPath`、允許的測試、版本和檢查。內網設定只引用憑證的環境變數名稱。

```json
{
  "whippet_origin": "https://whippet.example.org",
  "feedback_desk_origin": "https://feedback.example.org",
  "sources": [{
    "source_id": "portal-qa",
    "project_slug": "portal",
    "environment": "qa",
    "scope_revision": "portal-qa-v1",
    "workspace_id": "0785eb41-4863-4f0a-9ee1-6826e4f96696",
    "manifest_hmac_key_env": "PORTAL_QA_CI_MANIFEST_KEY",
    "deployment_token_env": "PORTAL_QA_DEPLOYMENT_TOKEN",
    "retest_token_env": "PORTAL_QA_RETEST_TOKEN",
    "whippet_schedule_token_env": "PORTAL_QA_WHIPPET_SCHEDULE_TOKEN",
    "whippet_read_token_env": "PORTAL_QA_WHIPPET_READ_TOKEN",
    "components": [{
      "component_id": "checkout",
      "proof_url": "https://qa.example.org/.well-known/deployment.json",
      "tests": [{
        "test_id": "58f3278c-5cf9-4a14-83e5-3e5655bea317",
        "version_id": "30592608-8e10-403d-8705-fcb608d7dc60",
        "check_keys": ["checkout-total"]
      }]
    }]
  }]
}
```

`proof_url` 指向實際服務的部署版本端點，回傳 `{deploymentId,artifactRevision,environment,projectSlug}`。CI 及橋接器按該端點核對已上線版本，Whippet Runner 另查驗執行時的部署證據。可在隔離環境用 loopback HTTP，部署環境的服務端點使用 HTTPS。

## CI/CD 提交部署紀錄

部署成功後查詢目標的版本端點，從建置來源證據取得實際部署的完整 commit SHA，組成 JSON。`sequence` 由可信部署來源按專案、環境、元件持久遞增，同一事件重送時沿用原識別、序號與內容。`evidence_ref` 使用能回查 CI 或建置紀錄的識別字。

```json
{
  "schema_version": 1,
  "source_id": "portal-qa",
  "project_slug": "portal",
  "environment": "qa",
  "deployment_id": "checkout-153",
  "component_id": "checkout",
  "sequence": 153,
  "occurred_at": "2026-11-21T02:00:00.000Z",
  "state": "succeeded",
  "artifact_revision": "sha256:275a6e192edeb4ba34988bc77a89362e698bb1db528a49e4cd2514879c87dd1",
  "commit_shas": ["20bc4b8f9083be537efc4466430c0b83588f99fd"],
  "evidence_ref": "ci:checkout:153"
}
```

失敗部署使用 `state: "failed"` 並省略 `artifact_revision`、`commit_shas`。成功部署的 `commit_shas` 僅在純巡檢部署缺少適用 MR 時可給空陣列。簽署金鑰由祕密儲存服務注入，為 32 位元組、64 個小寫十六進位字元。CI 對 JSON 檔的原始位元組做 HMAC-SHA256，輸出單行十六進位簽章。

```sh
node --input-type=module -e '
  import { createHmac } from "node:crypto";
  import { readFileSync } from "node:fs";
  const key = process.env.PORTAL_QA_CI_MANIFEST_KEY;
  if (!/^[a-f0-9]{64}$/.test(key ?? "")) process.exit(1);
  console.log(createHmac("sha256", Buffer.from(key, "hex")).update(readFileSync(process.argv[1])).digest("hex"));
' deployment.json > deployment.sig
```

在內網執行以下指令。首次收到成功紀錄時，橋接器會確認版本端點目前回報相同部署、版本、專案及環境，再將紀錄存入本機狀態並送 Airedale。取得原收據或中途失去回應時，進入狀態目錄的同一觀察可繼續交付。

```sh
export FEEDBACK_DESK_DEPLOYMENT_CONFIG=/path/to/deployment-bridge.json
export FEEDBACK_DESK_DEPLOYMENT_STATE_DIR=/path/to/deployment-state
node scripts/agents/deployment/cli.mjs --ingest portal-qa deployment.json deployment.sig
node scripts/agents/deployment/cli.mjs --once
node scripts/agents/deployment/cli.mjs
node scripts/agents/deployment/cli.mjs --replay portal-qa 'retest-request-uuid'
```

`--once` 續送本機待確認的部署及重測結果，然後掃完目前待處理的意圖。無參數時持續輪詢。`FEEDBACK_DESK_DEPLOYMENT_POLL_MS` 預設 3000 毫秒，`FEEDBACK_DESK_DEPLOYMENT_MAX_ATTEMPTS` 預設每個 HTTP 操作 3 次。狀態目錄放在持久磁碟，權限為 `0700`。程序重啟時保留目錄。`--replay` 依 Airedale 的重測請求識別重查 Whippet，正常中的 Run 會等下一次輪詢，歷史終態可取得原結果或晚到的稽核收據。

排程前及套用當前證據性結果前，橋接器再次核對目標的部署版本。版本不同會留下 `deployment_live_revision_mismatch`。取消、逾時、環境異常或證據不足時，保存實際可查到的結果，交由 Airedale 留待辦查閱。正式報告仍在 Whippet，Airedale 保存可查詢的 Run 識別。

```sh
npm run test:cli -- test/cli/automation-deployment.test.ts test/cli/automation-inspection.test.ts test/cli/automation-consumer.test.ts
```
