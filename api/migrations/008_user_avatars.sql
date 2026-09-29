-- Profile photos (resized to a small square by the client)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar BYTEA,
  ADD COLUMN IF NOT EXISTS avatar_mime VARCHAR(50),
  -- cache-busting version for the public avatar URL
  ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
