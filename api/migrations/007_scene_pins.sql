-- Per-user pinned scenes (shown first in lists)
CREATE TABLE IF NOT EXISTS scene_pins (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, scene_id)
);
