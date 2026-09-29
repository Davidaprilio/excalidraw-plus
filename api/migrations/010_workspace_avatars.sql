-- Workspace photos (cropped to a small square by the client, like user avatars)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS avatar BYTEA,
  ADD COLUMN IF NOT EXISTS avatar_mime VARCHAR(50),
  ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
