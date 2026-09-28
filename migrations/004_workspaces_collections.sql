-- Excalidraw+-style workspaces: members, invites, collections, trash, visit history.
-- The older `teams` tables are left untouched (unused by the UI for now).

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

-- email NULL = open invite link, usable by anyone who has it
CREATE TABLE IF NOT EXISTS workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  token VARCHAR(64) UNIQUE NOT NULL,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id);

-- visibility: 'private' = owner only, 'workspace' = every workspace member.
-- is_personal marks each member's built-in "Private" collection.
CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  visibility VARCHAR(20) NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('private', 'workspace')),
  is_personal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collections_workspace ON collections(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_personal
  ON collections(workspace_id, owner_id) WHERE is_personal;

ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES collections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_workspace ON scenes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scenes_collection ON scenes(collection_id);

CREATE TABLE IF NOT EXISTS scene_visits (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, scene_id)
);
CREATE INDEX IF NOT EXISTS idx_scene_visits_user ON scene_visits(user_id, visited_at DESC);

-- Backfill: one workspace + Private collection per existing user; their scenes go there
INSERT INTO workspaces (name, created_by)
SELECT COALESCE(NULLIF(u.name, ''), split_part(u.email, '@', 1)) || '''s workspace', u.id
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id);

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, w.created_by, 'admin' FROM workspaces w
WHERE w.created_by IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO collections (workspace_id, owner_id, name, visibility, is_personal)
SELECT wm.workspace_id, wm.user_id, 'Private', 'private', TRUE FROM workspace_members wm
ON CONFLICT DO NOTHING;

UPDATE scenes s
SET workspace_id = c.workspace_id, collection_id = c.id, updated_by = COALESCE(s.updated_by, s.owner_id)
FROM collections c
WHERE s.workspace_id IS NULL AND c.is_personal AND c.owner_id = s.owner_id;
