# W3 實機驗收

僅在專用、可丟棄的 Whippet 環境執行。此測試會建立多筆 Run，並中止唯一符合該 Run 標籤與 `whippet-worker:fd-w3-qa` 映像的暫時 Runner；禁止指向正式環境。`whippet-fixture.sql` 預期套用在已執行標準 migration 與種子資料的專用 PostgreSQL。外部服務、測資和授權設定的重建方式見 W3 交接。

先 `npm ci` 及 `npm run build`。測試需本機 Whippet server `127.0.0.1:19831`、fixture 網站 `127.0.0.1:19832`、可用的 manager 與 Docker；19833 供測試啟動 Feedback Desk，執行時不得另開佔用相同埠的服務。設定 QA／stage 的 schedule、bridge 和 DMZ token、Whippet admin token、`W3_DESK_OWNER`、`W3_DESK_CLIENT`、`W3_DESK_SECRET`，均放在版控外的私有環境檔。需讓執行者有權存取這些服務及 Docker。

```sh
set -a
source /path/to/private/tokens.env
source /path/to/private/compose.env
set +a
export W3_LIVE=1
export W3_FIXTURE_HTML=/absolute/path/to/isolated/site/index.html
export W3_D1_PERSIST=/absolute/path/to/private/w3/d1
node --test test/w3/live.test.mjs
```

測試會暫時改寫 fixture HTML，並在結束時還原。它確認一次通過、一次中斷不建立工單，兩次相同 QA 斷言失敗併入同一張團隊單，stage 獨立建單；透過 Whippet API 核對每筆反向連結，驗證團隊可開頁、登入客戶及匿名訪客無法開啟。測試以 bridge 的正式 CLI 執行並重送事件。

`W3_D1_PERSIST` 應固定使用專用目錄，與 Whippet 測試資料庫成對保留，重跑才能辨識已寫入 Whippet 的舊 Run 與工單。`desk.mjs` 的 `startDesk()` 可供驗收站啟動器使用，回傳 `{ mf, db }`；不使用時應 `await mf.dispose()`。不要將 token、資料庫或驗收憑證加入版控。直接結束測試會停止 Feedback Desk，須重新啟動驗收站才能瀏覽保留的連結。
