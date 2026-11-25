# 技術與執行環境

[主規範](../AGENTS.md)

Airedale 的應用、CLI 與測試入口以 package.json 為準。DMZ 執行回報服務，內網 worker 主動連線。Whippet 獨立部署並維護 Playwright 執行環境。修改串接時先讀 [整合契約](../docs/architecture/integration.md)。
