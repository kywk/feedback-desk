# 單項與 Wave 驗證

[主規範](../AGENTS.md)

開發期間針對受影響行為執行必要單元測試。Wave 收尾由測試 agent 對整合後的 commit 執行 npm run typecheck、npm test，以及該 Wave 的整合驗收案例。涉及 Whippet 時依其 repo 規範執行完整檢查及跨系統案例。將 commit、測試環境、指令、結果、失敗與重跑證據存入 docs/tracking/devlog。外部服務不可用時，記錄未驗證項目與恢復條件；模擬通過只列為契約測試。
