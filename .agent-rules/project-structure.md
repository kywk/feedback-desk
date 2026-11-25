# 文件與實作位置

[主規範](../AGENTS.md)

服務入口在 src/worker，跨入口邏輯在 src/shared，現有輪詢器在 scripts/agents。調整資料模型時一併檢查 migrations。

本次規劃文件結構如下。

```text
./
├── .agent-rules/
│   ├── project-structure.md  # 文件與實作位置
│   ├── tech-stack.md  # 技術與執行環境
│   ├── tracking.md  # 任務派工與交接
│   └── verification.md  # 單項與 Wave 驗證
├── docs/
│   ├── architecture/  # 系統與事件契約
│   ├── guides/  # 操作指引與提示詞
│   ├── requirements/  # 功能與驗收規格
│   ├── research/  # 現況證據
│   └── tracking/  # 計畫與進度
│       ├── devlog/  # 各 Wave 驗證證據
│       └── handoff/  # PM 接續點
└── AGENTS.md  # 主規範與開發文件索引
```
