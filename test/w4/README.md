# W4 本機整合驗收

這個案例使用隔離的 GitLab 私有 TodoMVC 專案、Whippet Server／PostgreSQL／Manager／Chromium Worker 和本機 Feedback Desk。每次執行使用新的 D1 資料目錄、工單與 GitLab 工作分支。W2 的修復模型使用固定回應，Git、Docker 檢查、GitLab MR、瀏覽器與雙方 API 都走正式入口。

## 執行條件

- GitLab 設定與 W2 實機案例相同。受測檔案從指定私有專案的 Git SHA 下載並比對內容雜湊。
- Whippet API 綁定 127.0.0.1:19931，PostgreSQL 使用專用測試庫。對該庫套用 whippet-fixture.sql。來源授權的工作區、測試、固定版本與環境見 journey.mjs；測試標題為 TodoMVC model，斷言標題為 Blank titles are ignored，檢查名稱為 blank-title。
- 測試站執行 target.mjs，W4_RELEASE_FILE 指向 releases/active.json，容器對外連接埠為 19932，允許 Whippet 瀏覽器透過 host.docker.internal:19932 取得網頁。站台須提供部署證明與 HTTP 回應標頭。
- 保留 127.0.0.1:19933 給測試期間的 Feedback Desk。案例會另開暫時的 loopback 連接埠，控制重測回寫的送達順序。
- 本機憑證參照為 WHIPPET_SCHEDULE、WHIPPET_BRIDGE、W4_INSPECTION_TOKEN、W4_SIGNING_KEY 及 W2 GitLab 設定。憑證與 D1 存放在忽略版控的目錄。

從已建置的驗收工作樹啟動，FD_ROOT 指向原始 feedback-desk 工作樹。

```sh
set -a
. "$FD_ROOT/.feedback-desk/gitlab/project.env"
. "$FD_ROOT/.feedback-desk/w4/tokens.env"
set +a
W4_LIVE=1 \
W4_RELEASES="$FD_ROOT/.feedback-desk/w4/releases" \
W4_EVIDENCE_DIR="$FD_ROOT/.feedback-desk/w4/runs" \
W2_TODOMVC_CATALOG="$FD_ROOT/.feedback-desk/isolated-projects/scope.json" \
NODE_EXTRA_CA_CERTS="$W2_GITLAB_CA_FILE" GIT_SSL_CAINFO="$W2_GITLAB_CA_FILE" \
node --test test/w4/live.test.mjs
```

成功後各站識別與工單結果會寫入此次 journey 目錄的 evidence.json。

案例另驗證：錯誤環境的簽章部署不建立重測；測試站的部署證明正確、瀏覽器取得的 model 回應卻帶舊版本標頭，確認真實 Whippet Run 為 `unverified`、FD 要求人工處理且不得結案；`infrastructure` 類型由 Worker 契約測試覆蓋；較新部署完成後才送達的舊結果回傳 `ignored_stale`，重送回傳相同收據；共用 Run 可透過團隊 API 反查兩張工單，各單 API 亦可查到該次重測。

執行前先確認 GitLab、Whippet 及測試站已就緒，並由整合負責人確認產品版本。測試會在私有 GitLab 建立修復與回歸分支，並變更測試站的 active release；請使用專用驗收環境。`evidence.json` 記錄實際識別與結果，不應包含 token；請妥善保管驗收資料。
