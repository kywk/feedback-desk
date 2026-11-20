ALTER TABLE automation_scopes ADD COLUMN inspection_ingress INTEGER NOT NULL DEFAULT 0 CHECK (inspection_ingress IN (0, 1));

-- Operators store SHA-256 hashes of fdi_ bridge tokens. Each token is bound
-- to a single project, environment and stable Whippet deployment identity.
CREATE TABLE automation_inspection_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE TABLE automation_inspection_targets (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    check_key TEXT NOT NULL,
    PRIMARY KEY (project_id, environment, scope_revision, source_instance, workspace_id, test_id, check_key),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE TABLE automation_inspection_groups (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    check_key TEXT NOT NULL,
    failure_signature TEXT NOT NULL,
    report_public_id TEXT PRIMARY KEY NOT NULL,
    previous_report_public_id TEXT REFERENCES automation_inspection_groups(report_public_id),
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL,
    closed_at TEXT,
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE UNIQUE INDEX automation_inspection_group_open
ON automation_inspection_groups (project_id, environment, source_instance, workspace_id, test_id, check_key, failure_signature)
WHERE closed_at IS NULL;

CREATE INDEX automation_inspection_group_history
ON automation_inspection_groups (project_id, environment, source_instance, workspace_id, test_id, check_key, failure_signature, closed_at DESC);

CREATE TABLE automation_inspection_runs (
    source_instance TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    check_key TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    observation_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    report_public_id TEXT REFERENCES automation_inspection_groups(report_public_id),
    linked_at TEXT,
    PRIMARY KEY (source_instance, workspace_id, run_id, check_key),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE INDEX automation_inspection_pending_links
ON automation_inspection_runs (project_id, environment, source_instance, occurred_at)
WHERE report_public_id IS NOT NULL AND linked_at IS NULL;

CREATE INDEX automation_inspection_report_runs ON automation_inspection_runs (report_public_id, occurred_at);

CREATE TABLE automation_inspection_receipts (
    source_instance TEXT NOT NULL,
    event_id TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (source_instance, event_id),
    UNIQUE (project_id, environment, operation_id),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

ALTER TABLE automation_events ADD COLUMN ingress_kind TEXT NOT NULL DEFAULT 'customer' CHECK (ingress_kind IN ('customer', 'inspection'));
ALTER TABLE automation_work ADD COLUMN ingress_kind TEXT NOT NULL DEFAULT 'customer' CHECK (ingress_kind IN ('customer', 'inspection'));

DROP TRIGGER automation_event_enqueue;
CREATE TRIGGER automation_event_enqueue AFTER INSERT ON automation_events
WHEN NEW.ignored_reason IS NULL
BEGIN
    UPDATE automation_work
    SET revoked_reason = CASE NEW.ingress_kind WHEN 'inspection' THEN 'new_inspection_input' ELSE 'new_customer_input' END,
        worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = NEW.occurred_at
    WHERE report_public_id = NEW.report_public_id AND revoked_reason IS NULL AND stage <> 'completed';

    INSERT INTO automation_work (
        work_id, project_id, environment, scope_revision, event_cursor, report_public_id,
        input_revision, report_revision, updated_at, ingress_kind
    )
    VALUES (
        lower(hex(randomblob(16))), NEW.project_id, NEW.environment, NEW.scope_revision, NEW.cursor,
        NEW.report_public_id, NEW.report_revision, NEW.report_revision, NEW.occurred_at, NEW.ingress_kind
    );
END;

DROP TRIGGER automation_scope_changed;
CREATE TRIGGER automation_scope_changed
AFTER UPDATE OF enabled, customer_ingress, inspection_ingress, backfill_unclaimed, scope_revision ON automation_scopes
BEGIN
    UPDATE automation_work SET
        revoked_reason = CASE WHEN NEW.scope_revision <> OLD.scope_revision OR
            (ingress_kind = 'customer' AND NEW.customer_ingress = 0)
            THEN 'scope_changed' ELSE revoked_reason END,
        worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE project_id = NEW.project_id AND environment = NEW.environment AND revoked_reason IS NULL AND stage <> 'completed'
        AND (NEW.enabled = 0 OR NEW.scope_revision <> OLD.scope_revision OR
            CASE ingress_kind WHEN 'inspection' THEN NEW.inspection_ingress ELSE NEW.customer_ingress END = 0);

    INSERT INTO automation_events (event_id, event_type, project_id, environment, scope_revision, occurred_at, report_public_id, report_revision)
    SELECT 'report.created:' || public_id, 'report.created', project_id, environment, scope_revision, created_at, public_id, report_revision
    FROM automation_backfill_candidates WHERE project_id = NEW.project_id AND environment = NEW.environment
        AND (OLD.enabled = 0 OR OLD.customer_ingress = 0 OR OLD.backfill_unclaimed = 0)
    ORDER BY created_at, public_id;
END;

DROP TRIGGER automation_attempt_released;
CREATE TRIGGER automation_attempt_released AFTER UPDATE OF lease_expires_at ON automation_work
WHEN NEW.lease_expires_at IS NULL AND OLD.lease_expires_at IS NOT NULL
BEGIN
    UPDATE automation_work_attempts SET
        released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        outcome = CASE
            WHEN NEW.revoked_reason IS NOT NULL THEN NEW.revoked_reason
            WHEN NEW.retry_at IS NOT NULL THEN 'retry_scheduled'
            WHEN NEW.stage NOT IN ('queued', 'running') THEN NEW.stage
            WHEN EXISTS (SELECT 1 FROM automation_scopes s WHERE s.project_id = NEW.project_id AND s.environment = NEW.environment
                AND (s.enabled = 0 OR (NEW.ingress_kind = 'inspection' AND s.inspection_ingress = 0))) THEN 'scope_paused'
            ELSE 'credential_revoked'
        END,
        retry_at = NEW.retry_at
    WHERE work_id = OLD.work_id AND lease_generation = OLD.lease_generation AND released_at IS NULL;
END;

-- Retain the group and receipts if its report is closed, shared with clients or removed.
CREATE TRIGGER automation_inspection_group_closed
AFTER UPDATE OF status, shared_with_client, client_deleted_at ON reports
WHEN NEW.status = 'completed' OR NEW.shared_with_client = 1 OR NEW.client_deleted_at IS NOT NULL
BEGIN
    UPDATE automation_inspection_groups
    SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE report_public_id = NEW.public_id AND closed_at IS NULL;

    UPDATE automation_work SET revoked_reason = 'report_shared', worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE report_public_id = NEW.public_id AND ingress_kind = 'inspection' AND revoked_reason IS NULL AND stage <> 'completed'
        AND NEW.shared_with_client = 1;
END;

CREATE TRIGGER automation_inspection_group_removed BEFORE DELETE ON reports
BEGIN
    UPDATE automation_inspection_groups
    SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE report_public_id = OLD.public_id AND closed_at IS NULL;
END;
