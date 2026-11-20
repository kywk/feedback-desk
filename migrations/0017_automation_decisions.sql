ALTER TABLE automation_work ADD COLUMN next_action TEXT NOT NULL DEFAULT 'analyze' CHECK (next_action IN ('analyze', 'repair'));
ALTER TABLE automation_work ADD COLUMN proposal_revision INTEGER;
ALTER TABLE automation_work ADD COLUMN decision_outcome TEXT;

-- Missing policy means customer replies need team review and no repository can be written.
CREATE TABLE automation_policies (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    auto_reply INTEGER NOT NULL DEFAULT 0 CHECK (auto_reply IN (0, 1)),
    gitlab_instance_id TEXT,
    gitlab_origin TEXT,
    gitlab_proof_key_ref TEXT,
    PRIMARY KEY (project_id, environment, scope_revision),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes(project_id, environment) ON DELETE CASCADE
);

CREATE TABLE automation_repositories (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    gitlab_project_id INTEGER NOT NULL,
    base_branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    branch_prefix TEXT NOT NULL,
    required_check_ids TEXT NOT NULL,
    PRIMARY KEY (project_id, environment, scope_revision, repo_id),
    FOREIGN KEY (project_id, environment, scope_revision) REFERENCES automation_policies(project_id, environment, scope_revision) ON DELETE CASCADE
);

CREATE TABLE automation_reviewers (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    developer_id INTEGER NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, environment, developer_id),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes(project_id, environment) ON DELETE CASCADE
);

CREATE TABLE automation_decisions (
    work_id TEXT NOT NULL REFERENCES automation_work(work_id) ON DELETE CASCADE,
    decision_revision INTEGER NOT NULL,
    report_revision INTEGER NOT NULL,
    scope_revision TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    evidence_json TEXT,
    outcome TEXT NOT NULL,
    proposal_digest TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (work_id, decision_revision)
);

CREATE TABLE automation_reviews (
    approval_id TEXT PRIMARY KEY NOT NULL,
    work_id TEXT NOT NULL,
    decision_revision INTEGER NOT NULL,
    developer_id INTEGER REFERENCES developers(id) ON DELETE SET NULL,
    developer_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('approve', 'request_changes', 'provide_evidence')),
    report_revision INTEGER NOT NULL,
    scope_revision TEXT NOT NULL,
    evidence_json TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_id, decision_revision) REFERENCES automation_decisions(work_id, decision_revision) ON DELETE CASCADE
);

CREATE INDEX automation_reviews_work ON automation_reviews(work_id, decision_revision, created_at);

CREATE TABLE automation_commands (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    work_id TEXT NOT NULL REFERENCES automation_work(work_id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL,
    receipt_json TEXT,
    PRIMARY KEY (project_id, environment, operation_id)
);

-- SQLite has no ASSERT statement outside a trigger. A failed conditional assertion rolls
-- back the entire D1 batch, including any preceding effects.
CREATE TABLE automation_assertion (
    valid INTEGER NOT NULL CONSTRAINT automation_guard CHECK (valid = 1)
);

-- Keep the binding until the draft is removed. Deleting a scope must never turn
-- an automation draft into an ordinary, unfenced draft.
CREATE TABLE automation_drafts (
    draft_id INTEGER PRIMARY KEY REFERENCES message_drafts(id) ON DELETE CASCADE,
    work_id TEXT NOT NULL,
    report_revision INTEGER NOT NULL,
    scope_revision TEXT NOT NULL
);

CREATE TABLE automation_mr_links (
    work_id TEXT PRIMARY KEY REFERENCES automation_work(work_id) ON DELETE CASCADE,
    decision_revision INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    gitlab_instance_id TEXT NOT NULL,
    gitlab_project_id INTEGER NOT NULL,
    mr_iid INTEGER NOT NULL,
    observation_json TEXT NOT NULL,
    UNIQUE (gitlab_instance_id, gitlab_project_id, mr_iid),
    FOREIGN KEY (work_id, decision_revision) REFERENCES automation_decisions(work_id, decision_revision) ON DELETE CASCADE
);
