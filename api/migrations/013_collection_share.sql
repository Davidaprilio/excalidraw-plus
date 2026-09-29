-- Read-only link to a whole collection: every scene in it (current and future).
-- NULL = not shared; stopping the share drops the token, so sharing again gives a new link.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS share_token VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_share_token
  ON collections(share_token) WHERE share_token IS NOT NULL;
