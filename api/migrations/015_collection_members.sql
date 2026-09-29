-- Collection access (a workspace is one team):
--  * private collection: only its owner and the people added to it
--    (they must be members of its workspace); never shared by link
--  * workspace collection: everyone in the workspace, with `workspace_role`,
--    plus the people added (a higher role wins); may be shared by link
-- Roles: view (read only) < edit < manage (settings, people, sharing).
CREATE TABLE IF NOT EXISTS collection_members (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('view', 'edit', 'manage')),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_members_user ON collection_members(user_id);

ALTER TABLE collections ADD COLUMN IF NOT EXISTS workspace_role VARCHAR(10) NOT NULL DEFAULT 'edit'
  CHECK (workspace_role IN ('view', 'edit', 'manage'));

-- A private collection can't keep a public link
UPDATE collections SET share_token = NULL, share_allow_save = FALSE
WHERE visibility = 'private' AND share_token IS NOT NULL;

-- Access level of a user on a collection: 0 none, 1 view, 2 edit, 3 manage.
-- Only members of the collection's (live) workspace get anything.
CREATE OR REPLACE FUNCTION collection_access_level(p_collection UUID, p_user UUID) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(MAX(level), 0) FROM (
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
    SELECT CASE cm.role WHEN 'manage' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END
    FROM collection_members cm
    JOIN collections c ON c.id = cm.collection_id
    JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id
    WHERE cm.collection_id = p_collection AND cm.user_id = p_user
  ) levels
$$;
