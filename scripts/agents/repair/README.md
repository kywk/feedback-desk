# W2 修復 Worker

內網 consumer 收到 `next_action: repair` 時，會從同一租約重新取得 `repair_authorization`，核對目前的工單輸入、方案摘要、核准及範圍版本。修復會套用方案中的既有檔案文字替換。檢查通過後，依專案的交付模式將工作分支保存到本機裸庫，或推送到 GitLab 並查回 MR。工單等團隊審查或可信部署。

## 本機交付

這個模式適用於先在本機審閱修正。準備由 Worker 管理的 clone 和獨立的裸庫，將 clone 的 `origin` 與 scope 設定內的 `remote` 設為同一個實際絕對路徑的 `file://` URL。例如 `file:///srv/feedback-worker/test-app.git`。工作庫和裸庫應使用一般 Git 目錄及無轉指的物件與 ref 儲存。請把受管 `base_branch` 與 `base_commit` 放進兩個庫，並限制檔案系統存取權。

在對應的 scope repo 下設定 `repair.mode: "local"`，保留後述的 `allowed_paths`、`branch_prefix`、`recovery_directory`、`checks` 和 `test_image`，省略 `gitlab`。DMZ 登記相同版本與 repo 的 `delivery_mode: "local"`、基底、分支前綴及檢查 ID。本機模式只需既有的 Airedale consumer 憑證。Worker 以本機 Git 物件與 refs 儲存將 commit 寫入核准的裸庫，保留基底分支與來源 clone，並回報 `local_branch_ready` 給團隊審查。

在 Worker 主機以 `git --git-dir <裸庫絕對路徑> show <head_sha>` 查閱內容；確認基底分支、來源分支與 commit 後，再依團隊既有流程處理。若收據回應遺失，consumer 會重送相同的操作並核對裸庫內的分支 HEAD。

## 設定 GitLab 交付

1. 在內網 Worker 準備專用帳號、Git、tar、Node.js 20+ 及本機 Docker。Worker 帳號需可獨立使用 Docker，模型與檢查程式只可接觸各自的工具介面。準備內含 `/bin/sh`、`tar`、語言工具及已安裝相依套件的可信映像，在本機載入並以 SHA-256 摘要固定版本。
2. 使用專用 GitLab 測試專案。準備獨立 clone，其 `origin` 使用下列精確的 HTTPS URL，並保留核准的本機基底分支與 commit。GitLab 專案的來源、目標須屬於同一 project ID。把基底分支設為受保護分支，讓自動化身分只能在核准的工作分支前綴建立分支及 MR。
3. 由 Worker 帳號在可持久化的私有儲存區預建 `recovery_directory`（如 `mkdir -m 700 /srv/feedback-worker/recovery`），路徑使用實際絕對路徑。與設定內的 repo 和文件目錄分開，並限制保留目錄的存取權。
4. 在 W1 的 scope 設定中更新 `scope_revision`，在對應 repo 加上 `repair`。GitLab 模式可設定 `mode: "gitlab"`，未填時也沿用此模式。在 DMZ 的相同專案／環境及版本登錄 repo ID、基底分支、commit、允許的工作分支前綴、必要檢查 ID、GitLab 站台 ID、origin、project ID 及簽章密鑰參照。

若 GitLab 使用私人 CA，在啟動 Worker 前將 `NODE_EXTRA_CA_CERTS`（GitLab API）與 `GIT_SSL_CAINFO`（Git HTTPS）指向 Worker 主機上的 CA PEM 檔案。兩個連線都會驗證 GitLab 憑證。

以下是 `repositories` 陣列內的一個 repo 物件。請換成實際目錄、基底 commit、映像摘要與 GitLab 專案資料。

```json
{
  "id": "test-app",
  "directory": "/srv/repos/test-app",
  "remote": "https://gitlab.example.org/qa/test-app.git",
  "base_branch": "main",
  "base_commit": "1111111111111111111111111111111111111111",
  "read_paths": ["src", "test"],
  "repair": {
    "allowed_paths": ["src"],
    "branch_prefix": "automation/test-app/",
    "recovery_directory": "/srv/feedback-worker/recovery",
    "test_image": "test-app-checks@sha256:2222222222222222222222222222222222222222222222222222222222222222",
    "checks": [
      {"id": "unit", "argv": ["node", "--test", "test/unit.test.mjs"]}
    ],
    "gitlab": {
      "instance_id": "gitlab-test",
      "origin": "https://gitlab.example.org",
      "project_id": 42,
      "project_path": "qa/test-app",
      "push_username": "feedback-repair",
      "push_token_ref": "FEEDBACK_REPAIR_GIT_TOKEN",
      "api_token_ref": "FEEDBACK_REPAIR_GITLAB_TOKEN",
      "proof_key_ref": "FEEDBACK_AUTOMATION_GITLAB_PROOF_KEY"
    }
  }
}
```

環境變數注入三個獨立值。推送 token 只須有該專案的 Git 寫入權，API token 用於讀取專案與建立、查詢 MR。簽章密鑰至少 32 bytes，DMZ 和內網 Worker 使用同一值。使用系統信任的 HTTPS 憑證，Git 與 REST 連線拒絕重新導向。

依 [consumer 部署說明](../consumer/README.md) 設定環境、憑證及分析入口，可先跑一輪 `node scripts/agents/consumer/cli.mjs --once` 驗證。檢查程式在無網路、無宿主目錄掛載、無服務憑證的容器執行，每個檢查最多兩分鐘。依賴須裝在檢查映像中，檢查指令需以離線方式執行。替換的文字只可改到 `allowed_paths` 內已追蹤的一般 UTF-8 檔案，每個原片段須在該檔恰好出現一次。驗證或遠端分支需要變更時，更新受管設定版本及 DMZ 授權後重新研判。

## 追查與續辦

- 工作紀錄的 `repair` 包含階段、`recovery_id`、來源分支，以及當時可取得的檢查 ID 或 HEAD SHA。開啟 `<recovery_directory>/<recovery_id>/repair.json` 可比對工單及方案。以 `git -C <recovery_directory>/<recovery_id>/worktree diff --cached` 檢查尚未通過的內容，或以同一路徑執行 `git log -1` 查看已通過檢查的本機 commit。保留原受管 clone，以便隔離工作樹仍可讀取基底物件。
- 若 push 回應遺失，續辦會比對固定工作分支的實際 HEAD。其他 HEAD、已不存在的已確認分支，或在建單前變更的基底分支都會停止後續寫入。
- 若 GitLab 建 MR 的回應遺失，續辦會查同一來源與目標分支，再讀 MR 詳情，核對操作標記、project ID、MR ID、IID、URL 與 HEAD。既有 MR 可確認就回寫。同一意圖在後續租約仍查無 MR 時會留下 `repair_mr_result_uncertain` 並交由團隊對帳。請保留 MR 說明中的 `Airedale operation:` 標記行。
- 成功回寫後清理當次隔離工作樹。曾失敗的嘗試會保留在私有磁碟，團隊確認處置後可清理對應的 recovery 目錄。

## 開發驗證

```sh
npm run typecheck
npm run test:cli -- test/cli/automation-repair.test.ts
FEEDBACK_REPAIR_DOCKER_SMOKE=1 npm run test:cli -- test/cli/automation-repair.test.ts -t '真 Docker'
```

預設測試使用隔離 Git repository 與模擬 GitLab。Docker 案例需先備妥測試內固定的 Node 映像，會以真容器驗證變更與憑證隔離。測試 GitLab 試辦時再以查回的 MR ID、IID、URL、來源及目標分支與 HEAD 作為部署驗收證據。
