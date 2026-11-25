# 任務派工與交接

[主規範](../AGENTS.md)

PM 依 [Wave 計畫](../docs/tracking/waves.md) 分批派工。每次派工註明任務 ID、repo、允許修改的檔案、前置 commit 與驗收案例。平行 agent 使用獨立 worktree；共享契約由一人負責，先固定契約再整合。開發用 gpt-6.2-sol / xhigh / fast，測試用 gpt-6.1-terra / high / fast。工具未提供 fast 參數時，記錄實際模式與差異。任務通過必要單測即 commit，只提交該任務的變更。PM 在 docs/tracking/handoff 記錄下一個可派任務與阻塞事項。
