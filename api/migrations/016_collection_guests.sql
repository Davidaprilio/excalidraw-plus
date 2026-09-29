-- Sharing a workspace collection outside its workspace:
--  * people from other workspaces (collection_members rows of non-members)
--  * whole other teams (a workspace = a team) with one role: collection_teams
-- Both only count while the collection is shared with its workspace ("public");
-- a private collection stays within its workspace.
CREATE TABLE IF NOT EXISTS collection_teams (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('view', 'edit', 'manage')),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_teams_workspace ON collection_teams(workspace_id);

-- Access level of a user on a collection: 0 none, 1 view, 2 edit, 3 manage.
CREATE OR REPLACE FUNCTION collection_access_level(p_collection UUID, p_user UUID) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(MAX(level), 0) FROM (
    -- its own workspace: owner, admins and everyone (when shared with the workspace)
    SELECT CASE
             WHEN c.owner_id = p_user THEN 3
             WHEN c.visibility = 'workspace' AND wm.role = 'admin' THEN 3
             WHEN c.visibility = 'workspace' THEN
               CASE c.workspace_role WHEN 'manage' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END
             ELSE 0
           END AS level
    FROM collections c
    JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = p_user
    WHERE c.id = p_collection
    UNION ALL
    -- people added: members of its workspace, or anyone when it's public
    SELECT CASE cm.role WHEN 'manage' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END
    FROM collection_members cm
    JOIN collections c ON c.id = cm.collection_id
    JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    WHERE cm.collection_id = p_collection AND cm.user_id = p_user
      AND (c.visibility = 'workspace' OR EXISTS (
        SELECT 1 FROM workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_id = p_user))
    UNION ALL
    -- other teams it's shared with (public only)
    SELECT CASE ct.role WHEN 'manage' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END
    FROM collection_teams ct
    JOIN collections c ON c.id = ct.collection_id AND c.visibility = 'workspace'
    JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    JOIN workspaces tw ON tw.id = ct.workspace_id AND tw.deleted_at IS NULL
    JOIN workspace_members tm ON tm.workspace_id = ct.workspace_id AND tm.user_id = p_user
    WHERE ct.collection_id = p_collection
  ) levels
$$;
