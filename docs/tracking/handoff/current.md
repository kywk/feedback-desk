# PM 交接

W1 第一批已於 2026-11-20 整合至 feedback-desk 本機 `main`。產品版本 `29d0f63` 含 W1-01 佇列 `6a463bb`、W1-02 專案隔離 `d02fe44`，以及 W1-04 測試準備 `a3985d4`、`138ab98`。QA 在此版本驗過型別、完整套件與本批案例。[W1 派工與驗證紀錄](../devlog/w1.md)

1. 讀 [現況](../../research/baseline.md)、[功能規格](../../requirements/automation.md) 與 [分工表](../waves.md)。
2. **下一批為 W1-03，依賴已滿足。** 從 `29d0f63` 串接輪詢、領件、續租、進度、游標及退避，切換同專案的舊輪詢器。既有 `scripts/agents/pm_poll.sh` 尚在原工作樹，建立新 worktree 時須納入此現況。隔離測試先註冊專案、環境、範圍版本與專用憑證，再啟用客戶收單。
3. W1 完整驗收通過後進入 W2；W2～W4 的真實 MR、部署與 Whippet Run 證據仍待試辦。
