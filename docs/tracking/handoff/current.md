# PM 交接

W1 已在 `327dc18` 完成整波驗收並整合至本機 `main`。W1-03 `c051f9a` 接上內網 Worker，W1-04 `aa2e523`、`55ddef9` 補齊實際程序重啟、自然租約到期、退避與人工接手的證據。[W1 驗證紀錄](../devlog/w1.md)

W2-01～04 已整合至本機 `main`。QA 在產品版本 `94dc54b` 完成型別檢查、Worker 360 項、CLI 101 項（含真 Docker）、W1 回歸與 W2 整合 16 項。任務與整合提交對照、實際指令、去敏工單及工作識別見 [W2 驗證紀錄](../devlog/w2.md)。

依最新指示，Worker 已先完成本機 Git 隔離交付。產品提交 `243e6b3` 支援依專案設定本機或 GitLab 模式。TodoMVC 的真實修復分支 `feedback/3590696a9d6ea43ab101619f0aa61817` 已保留於本機隔離裸庫，Underscore 1.13.7 已通過基底檢查。可直接使用這兩個專案試跑。[設定與重跑方式](../../../scripts/agents/fixtures/README.md) · [本機驗收與提交紀錄](../devlog/w2-local-projects.md)

**W2-04 已在本機隔離 GitLab 建立真實 MR。** 產品提交 `de632ed` 使用 GitLab CE 19.6.1 的私有專案 `root/w2-todomvc`（ID 1），以本機 TodoMVC 的 main 為基底。開發驗收查回 [MR !1](https://localhost:18443/root/w2-todomvc/-/merge_requests/1)，並核對相同工單重送仍對應同一張 MR。[設定、重跑方式與證據](../devlog/w2.md#本機-gitlab-ce-實機驗收)

**W3 已完成。** Feedback Desk 產品 `42db763`、實機驗收 `8e3266e`，Whippet 產品 `bdb2724`、最終測試修正 `8843131`，均已整合至本機 main。兩筆真實 QA 巡檢失敗連到同一張團隊單，stage 分單。成功、Runner 中斷與草稿驗證失敗皆未觸發建單。QA 驗過發布權限、重送、跨服務可用性，並重開 D1 後從 Run 頁面點回原單。[完整指令、Run 與收據證據](../devlog/w3.md#最終驗收證據) · [本機啟動與存取](../devlog/w3.md#本機驗收環境)

**下一波為 W4 部署後重測。** 從 W4-01／02／03 的共用契約開始，先固定可信部署識別、實際上線 revision、環境與已發布測試版本。可沿用 W2 本機 GitLab 的 MR／commit 與 W3 既有 Run、受限身分及團隊單；需由部署來源證實上線版本後才排重測。W4 尚未執行。[Wave 計畫](../waves.md)
