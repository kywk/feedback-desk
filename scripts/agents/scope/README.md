# 內網 Worker 專案執行範圍

Worker 從受信任的領件回應與自己的服務身分取得工作欄位，綁定一組工具。領件或續辦時先呼叫 `validate()`，再把 `execute(request)` 當作模型的資料讀取入口。

```js
import { createScopeAccess } from './scope/index.mjs';

const access = createScopeAccess({ configPath, auditPath });
const tools = access.forWork({
    work_id, correlation_id, actor, project_slug, environment, scope_revision,
});
await tools.validate();
const evidence = await tools.execute({
    operation: 'read_repo_file',
    repo_id: 'recruitment',
    path: 'docs/flow.md',
});
```

`read_repo_file` 接受 `repo_id` 與 `path`，回傳 `repo_id`、`commit` 及 `content`。
`read_local_guide` 接受 `guide_id` 與 `path`，回傳 `guide_id` 及 `content`。
`query_elk` 接受 `index`、`template_id`、`service`、UTC ISO 格式的 `from`／`to` 與 `limit`，回傳 `index`、`template_id` 及 `rows`。
拒絕或讀取失敗時會拋出帶固定 `code` 的 `ScopeError`。

## 管理員設定

```json
{
  "scopes": [
    {
      "project_slug": "recruitment-flow",
      "environment": "test",
      "scope_revision": "2026-11-20.1",
      "repositories": [
        {
          "id": "recruitment",
          "directory": "/srv/feedback-sources/recruitment",
          "remote": "https://git.example.org/teams/recruitment.git",
          "base_branch": "main",
          "base_commit": "0000000000000000000000000000000000000000",
          "read_paths": ["docs", "src/recruitment"]
        }
      ],
      "guides": [
        {
          "id": "local-handbook",
          "directory": "/srv/feedback-sources/handbook",
          "read_paths": ["recruitment/setup.md"]
        }
      ],
      "elk": {
        "endpoint": "https://elk.example.org",
        "index": "recruitment-test",
        "services": ["recruitment"],
        "queries": [{ "id": "errors", "terms": { "log.level": "error" } }],
        "fields": ["@timestamp", "message", "user.email"],
        "redact_fields": ["user.email"],
        "max_window_seconds": 1800,
        "max_hits": 20,
        "credential_ref": "RECRUITMENT_TEST_ELK_TOKEN"
      }
    }
  ]
}
```

- 管理員維護設定、Git clone 與本機說明所在目錄。正式目錄使用解析後的絕對路徑，且須限制寫入權。Git clone 須有實體 `.git` 目錄，以 `origin` 設定核准 remote，並將範例 commit 替換為本機基底分支可達的 commit。更新來源由管理員處理。
- 每組專案與環境只有一項設定。調整授權時同步更新 DMZ 與 Worker 的 `scope_revision`。以原子替換更新設定檔。移除該項或將 `enabled` 設為 `false` 即撤銷。無 ELK 存取權時省略 `elk`。
- 工具從部署環境取得 `credential_ref` 對應的 Bearer token。可在可信 Worker 注入 `resolveSecret(ref)`。ELK 端的服務帳號須限定核准 index／alias 的唯讀權限。管理員只核准分析需要的文件與欄位。設定檔與來源檔案應與憑證存放位置分開。
- 稽核 JSONL 由 Worker 新建為 `0600`。目錄須限制存取。紀錄包含工作、執行者、範圍、操作名、核准的來源代號或固定錯誤代碼。稽核檔不可寫入時工具會拒絕執行。
