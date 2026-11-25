# 自動接單試辦的現況

| 已查證的行為 | 對開發的影響 |
| --- | --- |
| [輪詢器](../../scripts/agents/pm_poll.sh) 固定喚起模型與 session。[既有紀錄](../e2e-pm-poll.log) 有認領、RD 分析、留言及交接。 | 沿用服務端團隊操作，新增廉價取單與按案件隔離的執行上下文。 |
| [PM](../../.opencode/agents/pm.md) 釋放待審案件後仍收 new；[RD](../../.opencode/agents/rd.md) 把 push 失敗也列為 fixed_mr。 | 優先驗收避免重派、查回真實 MR、確認部署後再邀請驗收。 |
| Whippet 的 docs/guides/mcp-agent.md 記錄普通 Test 的外部作者接單、提交與獨立驗證。互動 draft_create 支援 Module、Use Case。 | 先以已發佈測試驗證重跑能力。需要新回歸案例時，用既有作者流程，保存 revision 與驗證 run，沿用人工發佈。 |

Whippet 的 services/server/internal/server/http.go 已註冊 POST /api/tests/{id}/runs、GET /api/runs/{id} 與 artifacts 讀取端點。目前 createRun 只傳 test ID；postgres.go 的 CreateRun 在交易內讀當下的 published_version_id。因此排測前後若 QA 發佈新版，僅重送 test ID 可能跑到另一版。W4 要驗證機器授權，並在排測交易中固定版本或拒絕版本不符，處理目標環境與重送去重。

試辦以 recruitment-flow 為例。由 PM 在對應 Wave 查明 ELK 唯讀索引、Git 測試專案、Whippet 機器身分、run 查詢與部署版本來源。正式環境權限、跨系統重跑及通知交付均須以試辦結果更新。Whippet 原始碼位置為 ~/workspace/whippet。
