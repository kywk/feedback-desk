# 內網收單 Worker

在可連到 Feedback Desk 與核准來源的內網主機執行，使用 Node.js 20 以上。

```sh
node scripts/agents/consumer/cli.mjs
node scripts/agents/consumer/cli.mjs --once
```

預設持續輪詢，每輪最多領一件。`--once` 執行一輪，可用於排程與隔離測試。一般部署經 D1 輸入與處置介面執行 [W2 研判](../analysis/README.md)。缺少模型設定的研判工作會留下 `analysis_model_not_configured` 並進阻塞。

| 環境變數 | 用途 |
| --- | --- |
| `FEEDBACK_DESK_URL` | Feedback Desk HTTPS origin。本機測試可用 HTTP loopback |
| `FEEDBACK_DESK_AUTOMATION_TOKEN` | 綁定專案與環境的專用 `fda_` 憑證，從部署環境注入 |
| `FEEDBACK_DESK_PROJECT_SLUG` | D1 登錄的專案 slug |
| `FEEDBACK_DESK_ENVIRONMENT` | D1 登錄的環境 |
| `FEEDBACK_DESK_SCOPE_REVISION` | DMZ 和本機設定共同使用的版本 |
| `FEEDBACK_DESK_WORKER_ID` | 執行個體代號，同一個體重啟時沿用 |
| `FEEDBACK_DESK_SCOPE_CONFIG` | [範圍設定](../scope/README.md) JSON 路徑 |
| `FEEDBACK_DESK_SCOPE_AUDIT` | 本機範圍稽核 JSONL 路徑 |
| `FEEDBACK_DESK_CONSUMER_STATE` | 本機持久游標與輪詢退避檔路徑，各個體使用自己的檔案 |
| `FEEDBACK_DESK_CONSUMER_HANDLER` | 選填。沿用 W1 的自訂流程時指定管理員維護的本機 Node 模組，以目前目錄解析相對路徑 |
| `FEEDBACK_DESK_POLL_MS`、`FEEDBACK_DESK_HEARTBEAT_MS` | 選填。預設 3000／15000 毫秒，心跳最多 30000 毫秒 |
| `FEEDBACK_DESK_RETRY_BASE_MS`、`FEEDBACK_DESK_MAX_ATTEMPTS` | 選填。預設 1000 毫秒與 4 次 |

設定與狀態檔須放在受存取控制的目錄。輪詢將事件游標及 API 退避存到本機，D1 記錄真正的工作、嘗試次數、處理進度與重試時間。重啟沿用本機游標；即使換 Worker，租約逾期後仍可從 D1 接續已確認的進度。`SIGTERM` 或 `SIGINT` 會中止 handler 及其後續讀取和進度寫入，既有租約由 D1 到期回收。已提交但回應遺失的寫入以 D1 狀態為準。日誌為 JSONL，包括 `work_id`、`lease_generation`、輪詢、重試與結果代碼。

## 管理員提供的 handler

只載入管理員信任的本機程式碼。工單資料不參與選擇模組。若後續串接模型，將需要的去敏資料與 `tools.execute` 入口個別提供給它。

```js
import { RetryableWorkError } from './index.mjs';

export async function handleWork({ work, progress, checkpoint, tools, signal }) {
    signal.throwIfAborted();
    if (!progress.checked) {
        await tools.execute({ operation: 'read_repo_file', repo_id: 'recruitment', path: 'docs/flow.md' });
        await checkpoint({ checked: true, report_revision: work.report_revision });
    }
    return { stage: 'waiting_review' };
}
```

`work` 含工作識別、來源事件、範圍與租約代次。`progress` 是已保存的 handler checkpoint，`checkpoint(data)` 儲存新 checkpoint。`data` 及可選的結果 `progress` 為最多 12 KiB 的 JSON 物件，只放續辦資料。`stage` 可用 `waiting_customer`、`waiting_review`、`blocked`、`completed`。需要重試時拋出 `new RetryableWorkError('service_busy', { retryAfterMs: 1000 })`。handler 必須遵守 `signal`，跨程序續辦要從 checkpoint 取回進度。W1 提供唯讀證據工具及受租約限制的進度入口。

## 從舊的 OpenCode 輪詢切換

1. 停止該專案的舊輪詢程序與排程，包含其他主機仍在執行的執行個體。
2. 在 D1 登錄範圍、專用憑證與收單設定。需要接手符合條件的舊單時才啟用 `backfill_unclaimed`。人工已接手的單由 D1 排除。
3. 以同一個 `scripts/agents/pm_poll.sh` 入口或直接以 Node 啟動隊列 Worker，核對專案和環境。既有 OpenCode 可在尚未啟用 D1 收單的部署明確設定 `FEEDBACK_DESK_POLL_MODE=legacy`，繼續使用 `FEEDBACK_DESK_MCP_TOKEN`、`PM_MODEL` 和 `PM_INTERVAL`。同一入口會拒絕同時設定 legacy 與隊列憑證或狀態檔。
