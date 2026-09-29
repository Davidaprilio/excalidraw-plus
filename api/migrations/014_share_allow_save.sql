-- Whether viewers of a read-only share link may "Save to..." a copy of the scene
-- file. Off by default, and reset to off whenever a link is (re)created.
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS share_allow_save BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS share_allow_save BOOLEAN NOT NULL DEFAULT FALSE;
