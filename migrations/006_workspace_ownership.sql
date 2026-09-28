-- Workspace ownership rules:
--  * every user has one personal workspace: it can't be deleted or left
--  * other workspaces have one owner (always an admin); only the owner deletes,
--    and must hand ownership to someone else before leaving
--  * deleting is a soft delete (restorable from the owner's trash)

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE workspaces SET owner_id = created_by WHERE owner_id IS NULL;

-- A creator who already left their workspace can't own it: hand it to its oldest admin (or member)
UPDATE workspaces w
SET owner_id = (
  SELECT m.user_id FROM workspace_members m
  WHERE m.workspace_id = w.id
  ORDER BY (m.role = 'admin') DESC, m.joined_at
  LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = w.owner_id
);

-- Each user's oldest workspace that they still own is their personal one
UPDATE workspaces w SET is_personal = TRUE
FROM (
  SELECT DISTINCT ON (owner_id) id FROM workspaces
  WHERE owner_id IS NOT NULL AND owner_id = created_by
  ORDER BY owner_id, created_at
) p
WHERE w.id = p.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_personal ON workspaces(owner_id) WHERE is_personal;
CREATE INDEX IF NOT EXISTS idx_workspaces_deleted ON workspaces(owner_id) WHERE deleted_at IS NOT NULL;

-- Owners are always admins
UPDATE workspace_members wm SET role = 'admin'
FROM workspaces w
WHERE w.id = wm.workspace_id AND w.owner_id = wm.user_id;
