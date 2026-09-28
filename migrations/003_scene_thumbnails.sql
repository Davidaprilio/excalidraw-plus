-- Dashboard preview images, rendered by the client. Kept out of `scenes`,
-- which is rewritten on every autosave.
CREATE TABLE IF NOT EXISTS scene_thumbnails (
  scene_id UUID PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
  data BYTEA NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  -- scenes.version the image was rendered from; older than scenes.version = stale
  scene_version INT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
