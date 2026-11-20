-- An ordinary customer report has no environment of its own. Route it through at most one
-- enabled ingress per project. Scope rows and hashed credentials are provisioned by an operator.
CREATE TABLE automation_scopes (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    customer_ingress INTEGER NOT NULL DEFAULT 0 CHECK (customer_ingress IN (0, 1)),
    backfill_unclaimed INTEGER NOT NULL DEFAULT 0 CHECK (backfill_unclaimed IN (0, 1)),
    PRIMARY KEY (project_id, environment)
);

CREATE UNIQUE INDEX automation_scopes_customer_ingress
ON automation_scopes (project_id) WHERE enabled = 1 AND customer_ingress = 1;

CREATE TABLE automation_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

ALTER TABLE reports ADD COLUMN report_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reports ADD COLUMN automation_manual_takeover INTEGER NOT NULL DEFAULT 0;

-- Existing team claims predate the queue and must retain ownership when automation is enabled.
UPDATE reports SET automation_manual_takeover = 1 WHERE claimed_by_developer_id IS NOT NULL;

CREATE TABLE automation_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (event_type IN ('report.created', 'report.customer_replied')),
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    report_public_id TEXT NOT NULL,
    report_revision INTEGER NOT NULL,
    message_id INTEGER,
    ignored_reason TEXT,
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE INDEX automation_events_scope_cursor ON automation_events (project_id, environment, cursor);
CREATE INDEX automation_events_report ON automation_events (report_public_id);

CREATE TABLE automation_work (
    work_id TEXT PRIMARY KEY NOT NULL,
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    event_cursor INTEGER NOT NULL UNIQUE REFERENCES automation_events(cursor) ON DELETE CASCADE,
    report_public_id TEXT NOT NULL,
    input_revision INTEGER NOT NULL,
    report_revision INTEGER NOT NULL,
    stage TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued', 'running', 'waiting_customer', 'waiting_review', 'blocked', 'completed')),
    progress_json TEXT,
    retry_at TEXT,
    worker_id TEXT,
    lease_token_hash TEXT,
    lease_expires_at TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0,
    revoked_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (report_public_id, input_revision),
    FOREIGN KEY (project_id, environment) REFERENCES automation_scopes (project_id, environment) ON DELETE CASCADE
);

CREATE INDEX automation_work_claim
ON automation_work (project_id, environment, scope_revision, event_cursor) WHERE revoked_reason IS NULL AND stage IN ('queued', 'running');

CREATE TABLE automation_work_attempts (
    work_id TEXT NOT NULL REFERENCES automation_work(work_id) ON DELETE CASCADE,
    lease_generation INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    released_at TEXT,
    outcome TEXT,
    retry_at TEXT,
    PRIMARY KEY (work_id, lease_generation)
);

CREATE TRIGGER automation_attempt_started AFTER UPDATE OF lease_generation ON automation_work
WHEN NEW.lease_generation > OLD.lease_generation
BEGIN
    UPDATE automation_work_attempts SET
        released_at = NEW.updated_at,
        outcome = CASE WHEN NEW.report_revision <> OLD.report_revision THEN 'report_changed' ELSE 'lease_expired' END
    WHERE work_id = OLD.work_id AND lease_generation = OLD.lease_generation AND released_at IS NULL;

    INSERT INTO automation_work_attempts (work_id, lease_generation, worker_id, claimed_at)
    VALUES (NEW.work_id, NEW.lease_generation, NEW.worker_id, NEW.updated_at);
END;

CREATE TRIGGER automation_attempt_released AFTER UPDATE OF lease_expires_at ON automation_work
WHEN NEW.lease_expires_at IS NULL AND OLD.lease_expires_at IS NOT NULL
BEGIN
    UPDATE automation_work_attempts SET
        released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        outcome = CASE
            WHEN NEW.revoked_reason IS NOT NULL THEN NEW.revoked_reason
            WHEN NEW.retry_at IS NOT NULL THEN 'retry_scheduled'
            WHEN NEW.stage NOT IN ('queued', 'running') THEN NEW.stage
            WHEN EXISTS (SELECT 1 FROM automation_scopes s WHERE s.project_id = NEW.project_id AND s.environment = NEW.environment AND s.enabled = 0) THEN 'scope_paused'
            ELSE 'credential_revoked'
        END,
        retry_at = NEW.retry_at
    WHERE work_id = OLD.work_id AND lease_generation = OLD.lease_generation AND released_at IS NULL;
END;

CREATE TABLE automation_operations (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    work_id TEXT NOT NULL REFERENCES automation_work(work_id) ON DELETE CASCADE,
    report_revision INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    lease_generation INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    result_hash TEXT,
    result_json TEXT,
    recorded_at TEXT,
    recorded_by TEXT,
    recorded_generation INTEGER,
    PRIMARY KEY (project_id, environment, operation_id)
);

-- Enqueuing and revoking the previous input are part of accepting the source event.
CREATE TRIGGER automation_event_enqueue AFTER INSERT ON automation_events
WHEN NEW.ignored_reason IS NULL
BEGIN
    UPDATE automation_work
    SET revoked_reason = 'new_customer_input', worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = NEW.occurred_at
    WHERE report_public_id = NEW.report_public_id AND revoked_reason IS NULL AND stage <> 'completed';

    INSERT INTO automation_work (
        work_id, project_id, environment, scope_revision, event_cursor, report_public_id, input_revision, report_revision, updated_at
    )
    VALUES (
        lower(hex(randomblob(16))), NEW.project_id, NEW.environment, NEW.scope_revision, NEW.cursor,
        NEW.report_public_id, NEW.report_revision, NEW.report_revision, NEW.occurred_at
    );
END;

CREATE TRIGGER automation_customer_report_created AFTER INSERT ON reports
WHEN NEW.creator_type = 'client'
BEGIN
    INSERT INTO automation_events (event_id, event_type, project_id, environment, scope_revision, occurred_at, report_public_id, report_revision)
    SELECT 'report.created:' || NEW.public_id, 'report.created', project_id, environment, scope_revision, NEW.created_at, NEW.public_id, NEW.report_revision
    FROM automation_scopes
    WHERE project_id = NEW.project_id AND enabled = 1 AND customer_ingress = 1;
END;

-- Report content and state changes fence an existing lease even if they occurred within one ms.
-- Read markers and internal drafts are not customer input. Existing team claims stop the queue
-- permanently for this report, including when the team later releases its coordination claim.
CREATE TRIGGER automation_report_revised
AFTER UPDATE OF title, description, category, page_url, status, completed_at, client_deleted_at, claimed_by_developer_id, adjustment_note, adjustment_updated_at, shared_with_client ON reports
BEGIN
    UPDATE reports SET
        report_revision = report_revision + 1,
        automation_manual_takeover = CASE WHEN NEW.claimed_by_developer_id IS NOT NULL THEN 1 ELSE automation_manual_takeover END
    WHERE id = NEW.id;

    UPDATE automation_work SET
        revoked_reason = CASE WHEN NEW.claimed_by_developer_id IS NOT NULL THEN 'manual_takeover' ELSE 'report_closed' END,
        worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = NEW.updated_at
    WHERE report_public_id = NEW.public_id AND revoked_reason IS NULL AND stage <> 'completed'
        AND (NEW.claimed_by_developer_id IS NOT NULL OR NEW.client_deleted_at IS NOT NULL OR NEW.status = 'completed');
END;

CREATE TRIGGER automation_report_removed BEFORE DELETE ON reports
BEGIN
    UPDATE automation_work SET revoked_reason = 'report_deleted', worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE report_public_id = OLD.public_id AND revoked_reason IS NULL AND stage <> 'completed';
END;

CREATE TRIGGER automation_message_added AFTER INSERT ON messages
BEGIN
    UPDATE reports SET report_revision = report_revision + 1 WHERE id = NEW.report_id;
END;

CREATE TRIGGER automation_message_revised AFTER UPDATE OF body, deleted_at ON messages
BEGIN
    UPDATE reports SET report_revision = report_revision + 1 WHERE id = NEW.report_id;
END;

-- Enabling a scope or opting into backfill can add untouched open customer reports.
-- Reports already seen by the queue or taken by the team never count as a backlog item.
CREATE VIEW automation_backfill_candidates AS
SELECT s.project_id, s.environment, s.scope_revision, r.created_at, r.public_id, r.report_revision
FROM automation_scopes s JOIN reports r ON r.project_id = s.project_id
WHERE s.enabled = 1 AND s.customer_ingress = 1 AND s.backfill_unclaimed = 1
    AND r.creator_type = 'client' AND r.status = 'new' AND r.client_deleted_at IS NULL
    AND r.automation_manual_takeover = 0 AND r.claimed_by_developer_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM automation_events WHERE report_public_id = r.public_id);

CREATE TRIGGER automation_scope_created AFTER INSERT ON automation_scopes
WHEN NEW.enabled = 1 AND NEW.customer_ingress = 1 AND NEW.backfill_unclaimed = 1
BEGIN
    INSERT INTO automation_events (event_id, event_type, project_id, environment, scope_revision, occurred_at, report_public_id, report_revision)
    SELECT 'report.created:' || public_id, 'report.created', project_id, environment, scope_revision, created_at, public_id, report_revision
    FROM automation_backfill_candidates WHERE project_id = NEW.project_id AND environment = NEW.environment
    ORDER BY created_at, public_id;
END;

CREATE TRIGGER automation_scope_changed AFTER UPDATE OF enabled, customer_ingress, backfill_unclaimed, scope_revision ON automation_scopes
BEGIN
    UPDATE automation_work SET
        revoked_reason = CASE WHEN NEW.scope_revision <> OLD.scope_revision OR NEW.customer_ingress = 0 THEN 'scope_changed' ELSE revoked_reason END,
        worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE project_id = NEW.project_id AND environment = NEW.environment AND revoked_reason IS NULL AND stage <> 'completed'
        AND (NEW.enabled = 0 OR NEW.customer_ingress = 0 OR NEW.scope_revision <> OLD.scope_revision);

    INSERT INTO automation_events (event_id, event_type, project_id, environment, scope_revision, occurred_at, report_public_id, report_revision)
    SELECT 'report.created:' || public_id, 'report.created', project_id, environment, scope_revision, created_at, public_id, report_revision
    FROM automation_backfill_candidates WHERE project_id = NEW.project_id AND environment = NEW.environment
        AND (OLD.enabled = 0 OR OLD.customer_ingress = 0 OR OLD.backfill_unclaimed = 0)
    ORDER BY created_at, public_id;
END;

-- Revoking a credential frees its leases while leaving the recorded checkpoint intact.
CREATE TRIGGER automation_token_revoked AFTER UPDATE OF revoked_at ON automation_tokens
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
BEGIN
    UPDATE automation_work SET
        worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = NEW.revoked_at
    WHERE lease_token_hash = NEW.token_hash;
END;
