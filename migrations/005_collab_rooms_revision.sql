-- Optimistic locking for collab room saves (replaces Firestore transactions):
-- a save must name the revision it was based on, or it's rejected and retried.
ALTER TABLE collab_rooms ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 0;

-- Files are encrypted with their room's key, so the same file id in two rooms
-- is two different blobs: key files by (room_id, id).
DELETE FROM collab_files WHERE room_id IS NULL;
ALTER TABLE collab_files DROP CONSTRAINT IF EXISTS collab_files_pkey;
ALTER TABLE collab_files ALTER COLUMN room_id SET NOT NULL;
ALTER TABLE collab_files ADD PRIMARY KEY (room_id, id);
