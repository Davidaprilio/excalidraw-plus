-- Track who uploaded each file so only the uploader (or scene owner) can delete it
ALTER TABLE files ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);

UPDATE files f
SET owner_id = s.owner_id
FROM scenes s
WHERE f.scene_id = s.id AND f.owner_id IS NULL;

-- Autosave checks the latest snapshot time per scene
CREATE INDEX IF NOT EXISTS idx_scene_versions_scene_created
  ON scene_versions(scene_id, created_at DESC);
