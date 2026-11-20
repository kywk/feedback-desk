ALTER TABLE automation_policies ADD COLUMN auto_close_inspections INTEGER NOT NULL DEFAULT 0 CHECK (auto_close_inspections IN (0, 1));

-- Store a SHA-256 hash of a separately deployed fdd_ or fdr_ credential.
CREATE TABLE automation_w4_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('deployment', 'retest')),
    source_instance TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE TABLE automation_deployment_sources (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    component_id TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    PRIMARY KEY (project_id, environment, scope_revision, component_id),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE TABLE automation_retest_targets (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    component_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('mr', 'inspection')),
    repo_id TEXT,
    source_instance TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    check_key TEXT NOT NULL,
    CHECK ((target_kind = 'mr' AND repo_id IS NOT NULL) OR (target_kind = 'inspection' AND repo_id IS NULL)),
    FOREIGN KEY (project_id, environment, scope_revision, component_id)
        REFERENCES automation_deployment_sources (project_id, environment, scope_revision, component_id) ON DELETE CASCADE
);

-- An origin maps to one pinned test. Several origins can share the same test.
CREATE UNIQUE INDEX automation_retest_target_mr
ON automation_retest_targets (project_id, environment, scope_revision, repo_id)
WHERE target_kind = 'mr';

CREATE UNIQUE INDEX automation_retest_target_inspection
ON automation_retest_targets (project_id, environment, scope_revision, source_instance, workspace_id, test_id, check_key)
WHERE target_kind = 'inspection';

CREATE TABLE automation_deployments (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    occurred_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('succeeded', 'failed')),
    artifact_revision TEXT,
    commits_json TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    receipt_json TEXT,
    received_at TEXT NOT NULL,
    PRIMARY KEY (project_id, environment, deployment_id),
    UNIQUE (project_id, environment, component_id, sequence),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE TABLE automation_retest_intents (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    retest_request_id TEXT UNIQUE NOT NULL,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'finished', 'superseded')),
    latest_generation INTEGER NOT NULL DEFAULT 0 CHECK (latest_generation >= 0),
    UNIQUE (project_id, environment, deployment_id, source_instance, workspace_id, test_id, version_id),
    UNIQUE (source_instance, workspace_id, run_id),
    FOREIGN KEY (project_id, environment, deployment_id)
        REFERENCES automation_deployments (project_id, environment, deployment_id) ON DELETE CASCADE
);

CREATE INDEX automation_retest_pending ON automation_retest_intents (project_id, environment, source_instance, cursor)
WHERE status IN ('pending', 'running');

CREATE TABLE automation_retest_reports (
    retest_request_id TEXT NOT NULL REFERENCES automation_retest_intents(retest_request_id) ON DELETE CASCADE,
    report_public_id TEXT NOT NULL,
    report_revision INTEGER NOT NULL,
    work_id TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    check_key TEXT NOT NULL,
    mr_head_sha TEXT,
    PRIMARY KEY (retest_request_id, report_public_id)
);

CREATE INDEX automation_retest_report_history ON automation_retest_reports (report_public_id, retest_request_id);

CREATE TABLE automation_retest_results (
    retest_request_id TEXT NOT NULL REFERENCES automation_retest_intents(retest_request_id) ON DELETE CASCADE,
    attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 0),
    attempt_id TEXT,
    token_hash TEXT NOT NULL,
    observation_hash TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (retest_request_id, attempt_generation),
    UNIQUE (retest_request_id, attempt_id),
    CHECK ((attempt_generation = 0) = (attempt_id IS NULL))
);

CREATE TABLE automation_retest_receipts (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    retest_request_id TEXT NOT NULL,
    attempt_generation INTEGER NOT NULL,
    request_hash TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    PRIMARY KEY (project_id, environment, operation_id),
    FOREIGN KEY (retest_request_id, attempt_generation)
        REFERENCES automation_retest_results (retest_request_id, attempt_generation) ON DELETE CASCADE
);

CREATE TABLE automation_retest_report_results (
    retest_request_id TEXT NOT NULL,
    attempt_generation INTEGER NOT NULL,
    report_public_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    PRIMARY KEY (retest_request_id, attempt_generation, report_public_id),
    FOREIGN KEY (retest_request_id, attempt_generation)
        REFERENCES automation_retest_results (retest_request_id, attempt_generation) ON DELETE CASCADE,
    FOREIGN KEY (retest_request_id, report_public_id)
        REFERENCES automation_retest_reports (retest_request_id, report_public_id) ON DELETE CASCADE
);
