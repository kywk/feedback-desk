# W2 唯讀研判

使用 [Worker 入口](../consumer/README.md) 啟動。要用相容 Chat Completions 的 HTTPS 文字端點，設定以下環境變數。

| 設定 | 用途 |
| --- | --- |
| `FEEDBACK_DESK_ANALYSIS_MODEL_URL` | 管理員核准的完整文字模型端點。HTTP 僅允許本機 loopback |
| `FEEDBACK_DESK_ANALYSIS_MODEL` | 端點支援的模型名稱 |
| `FEEDBACK_DESK_ANALYSIS_MODEL_TOKEN` | 選填，由部署環境注入的 Bearer token |
| `FEEDBACK_DESK_ANALYSIS_ADAPTER` | 選填。以管理員提供的本機模組取代 HTTP adapter，適用於內部模型或 QA 測試 |

模型端點接收 `model`、`messages`、`stream: false` 的 JSON，回覆 `choices[0].message.content` 中的 JSON 字串。選擇操作時回 `{"action":"read","request":{...}}`，完成時回 `{"action":"finish","analysis":{...}}`。未設定 adapter 或模型端點時，研判工作進阻塞並留下 `analysis_model_not_configured`。

本機 adapter 匯出 `async function analyze({report,catalog,readEvidence,signal})`，回傳 [共用分析格式](../../../src/shared/automation-analysis.d.mts) 的物件。報告截取標題、說明與最近留言並先遮罩，模型取得核准來源代號、相對路徑與檢查代號。模型使用下列讀取工具。

- `read_repo_file` 需要 `repo_id` 和 `path`。`read_local_guide` 需要 `guide_id` 和 `path`。兩種都可設定 `start_line`、`line_count` 以取必要片段。
- `query_elk` 需要 `index`、`template_id`、`service`、`from`、`to` 和 `limit`，遵守範圍中的索引、查詢範本、保留欄位與遮罩規則。
- 團隊補證可填 `repo:<id>:<相對路徑>` 或 `guide:<id>:<相對路徑>`。已核准範圍內的位置會出現在 `catalog.supplemental_read_requests`。模型須重新讀取才取得有效參照。

有效的讀取會回傳 `reference`，並在本機範圍稽核檔記錄同一參照、授權範圍與證據摘要雜湊。分數與方案只能引用該輪實際讀取的參照。修改的 `before` 片段須出現在此次查證而且由方案引用的、相同 Git commit 及路徑的證據。敏感修改片段整件阻塞。DMZ 收到的是去敏分析、證據參照及必要修改片段。

D1 的 `/input` 判定是否重新研判或續辦同版修復。送出 `/decisions` 前先保存已驗證結果的 checkpoint，同一輪的回應遺失可重送同一操作鍵。團隊補證或要求重新分析後使用新的決策版本。結束研判或完成 MR 關聯後，以伺服器收據為準。修復從最新租約下的核准方案開始，由 W2-02 轉接器處理。
