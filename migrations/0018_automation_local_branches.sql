-- Older scopes used GitLab. Keep their configured targets, and let a local-only
-- repository be registered without a GitLab project identifier.
CREATE TABLE automation_repositories_next (
    project_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope_revision TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    gitlab_project_id INTEGER,
    base_branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    branch_prefix TEXT NOT NULL,
    required_check_ids TEXT NOT NULL,
    delivery_mode TEXT NOT NULL DEFAULT 'gitlab' CHECK (delivery_mode IN ('local', 'gitlab')),
    CHECK ((delivery_mode = 'local' AND gitlab_project_id IS NULL) OR (delivery_mode = 'gitlab' AND gitlab_project_id IS NOT NULL)),
    PRIMARY KEY (project_id, environment, scope_revision, repo_id),
    FOREIGN KEY (project_id, environment, scope_revision) REFERENCES automation_policies(project_id, environment, scope_revision) ON DELETE CASCADE
);

INSERT INTO automation_repositories_next (
    project_id, environment, scope_revision, repo_id, gitlab_project_id, base_branch, base_commit, branch_prefix, required_check_ids
)
SELECT project_id, environment, scope_revision, repo_id, gitlab_project_id, base_branch, base_commit, branch_prefix, required_check_ids
FROM automation_repositories;

DROP TABLE automation_repositories;
ALTER TABLE automation_repositories_next RENAME TO automation_repositories;

-- A grant retains its selected delivery mode for this decision revision.
ALTER TABLE automation_decisions ADD COLUMN delivery_mode TEXT DEFAULT 'gitlab' CHECK (delivery_mode IN ('local', 'gitlab'));

CREATE TABLE automation_local_branches (
    work_id TEXT NOT NULL,
    decision_revision INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (work_id, decision_revision),
    FOREIGN KEY (work_id, decision_revision) REFERENCES automation_decisions(work_id, decision_revision) ON DELETE CASCADE
);
