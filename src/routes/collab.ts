import { Router } from "express";
import { query, queryOne } from "../db";
import { authMiddleware } from "../middleware/auth";
import { serverError } from "../utils/http";

// Storage for live-collaboration rooms (replaces Firebase). Content is end-to-end
// encrypted with the room key from the link's #fragment: the server only ever
// sees ciphertext. Access is any logged-in user who knows the (random) room id.
const router = Router();

router.use(authMiddleware);

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

router.param("roomId", (_req, res, next, value) =>
  ROOM_ID_RE.test(value) ? next() : res.status(404).json({ error: "Room not found" })
);
router.param("fileId", (_req, res, next, value) =>
  FILE_ID_RE.test(value) ? next() : res.status(404).json({ error: "File not found" })
);

router.get("/rooms/:roomId", async (req, res) => {
  try {
    const room = await queryOne(
      "SELECT scene_version, encrypted_elements, iv, revision FROM collab_rooms WHERE room_id = $1",
      [req.params.roomId]
    );
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    res.json({
      sceneVersion: room.scene_version,
      ciphertext: Buffer.from(room.encrypted_elements).toString("base64"),
      iv: Buffer.from(room.iv).toString("base64"),
      revision: room.revision,
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

/**
 * Save the room scene. `baseRevision` is the revision the client read (null when
 * the room didn't exist yet); if someone saved in between, answers 409 so the
 * client reloads, reconciles and retries.
 */
router.put("/rooms/:roomId", async (req, res) => {
  try {
    const { sceneVersion, ciphertext, iv, baseRevision } = req.body;
    if (typeof ciphertext !== "string" || typeof iv !== "string" || !Number.isInteger(sceneVersion)) {
      return res.status(400).json({ error: "sceneVersion, ciphertext and iv are required" });
    }
    const params = [req.params.roomId, sceneVersion, Buffer.from(ciphertext, "base64"), Buffer.from(iv, "base64")];

    const saved =
      baseRevision === null || baseRevision === undefined
        ? await queryOne(
            `INSERT INTO collab_rooms (room_id, scene_version, encrypted_elements, iv, revision, updated_at)
             VALUES ($1, $2, $3, $4, 1, NOW())
             ON CONFLICT (room_id) DO NOTHING
             RETURNING revision`,
            params
          )
        : await queryOne(
            `UPDATE collab_rooms
             SET scene_version = $2, encrypted_elements = $3, iv = $4, revision = revision + 1, updated_at = NOW()
             WHERE room_id = $1 AND revision = $5
             RETURNING revision`,
            [...params, baseRevision]
          );
    if (!saved) {
      return res.status(409).json({ error: "Room was modified, reload and retry" });
    }
    res.json({ revision: saved.revision });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Upload encrypted files (images) of a room: { files: [{ id, data: base64 }] }
router.post("/rooms/:roomId/files", async (req, res) => {
  try {
    const files = req.body.files;
    if (!Array.isArray(files) || files.some((f) => !FILE_ID_RE.test(f?.id) || typeof f?.data !== "string")) {
      return res.status(400).json({ error: "files must be [{ id, data }]" });
    }
    const savedFiles: string[] = [];
    const erroredFiles: string[] = [];
    for (const file of files) {
      const data = Buffer.from(file.data, "base64");
      if (data.length > MAX_FILE_BYTES) {
        erroredFiles.push(file.id);
        continue;
      }
      // Files are immutable per id (content hash), so an existing one is kept
      await query(
        `INSERT INTO collab_files (room_id, id, data, mime_type) VALUES ($1, $2, $3, 'application/octet-stream')
         ON CONFLICT (room_id, id) DO NOTHING`,
        [req.params.roomId, file.id, data]
      );
      savedFiles.push(file.id);
    }
    res.status(201).json({ savedFiles, erroredFiles });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.get("/rooms/:roomId/files/:fileId", async (req, res) => {
  try {
    const file = await queryOne(
      "SELECT data FROM collab_files WHERE room_id = $1 AND id = $2",
      [req.params.roomId, req.params.fileId]
    );
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(file.data);
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
