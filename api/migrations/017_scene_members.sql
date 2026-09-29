-- Sharing a single scene with people (view / edit / manage), on top of its
-- collection's access. People outside the scene's workspace count only when
-- its collection may leave the workspace: shared with the workspace, or the
-- owner's own Private collection (a private collection they created stays in).
CREATE TABLE IF NOT EXISTS scene_members (
  scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('view', 'edit', 'manage')),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scene_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_scene_members_user ON scene_members(user_id);

-- Scene access level: 0 none, 1 view, 2 edit, 3 manage (the highest of: its owner
-- while in its workspace, its collection, a direct invite).
CREATE OR REPLACE FUNCTION scene_access_level(p_scene UUID, p_user UUID) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(MAX(level), 0) FROM (
    SELECT 3 AS level
    FROM scenes s
    JOIN workspace_members wm ON wm.workspace_id = s.workspace_id AND wm.user_id = p_user
    WHERE s.id = p_scene AND s.owner_id = p_user
    UNION ALL
    SELECT collection_access_level(s.collection_id, p_user)
    FROM scenes s WHERE s.id = p_scene AND s.collection_id IS NOT NULL
    UNION ALL
    SELECT CASE sm.role WHEN 'manage' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END
    FROM scene_members sm
    JOIN scenes s ON s.id = sm.scene_id
    LEFT JOIN collections c ON c.id = s.collection_id
    WHERE sm.scene_id = p_scene AND sm.user_id = p_user
      AND (c.visibility = 'workspace' OR c.is_personal OR EXISTS (
        SELECT 1 FROM workspace_members m WHERE m.workspace_id = s.workspace_id AND m.user_id = p_user))
  ) levels
$$;
