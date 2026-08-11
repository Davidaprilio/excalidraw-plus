import { Router } from "express";
import { query, queryOne } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";

const router = Router();

// Get collab room scene
router.get("/scenes/:roomId", async (req, res) => {
  try {
    const room = await queryOne(
      "SELECT * FROM collab_rooms WHERE room_id = $1",
      [req.params.roomId]
    );
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    res.json({
      sceneVersion: room.scene_version,
      ciphertext: room.encrypted_elements ? Buffer.from(room.encrypted_elements).toString("base64") : null,
      iv: room.iv ? Buffer.from(room.iv).toString("base64") : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Save collab room scene
router.put("/scenes/:roomId", async (req, res) => {
  try {
    const { sceneVersion, ciphertext, iv } = req.body;

    const ciphertextBuf = ciphertext ? Buffer.from(ciphertext, "base64") : null;
    const ivBuf = iv ? Buffer.from(iv, "base64") : null;

    await query(
      `INSERT INTO collab_rooms (room_id, scene_version, encrypted_elements, iv, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (room_id) DO UPDATE SET
         scene_version = $2,
         encrypted_elements = $3,
         iv = $4,
         updated_at = NOW()`,
      [req.params.roomId, sceneVersion || 0, ciphertextBuf, ivBuf]
    );

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload collab file
router.post("/files", async (req, res) => {
  try {
    const { id, roomId, data, mimeType } = req.body;
    const dataBuf = data ? Buffer.from(data, "base64") : null;

    await query(
      `INSERT INTO collab_files (id, room_id, data, mime_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET data = $3, mime_type = $4`,
      [id, roomId || null, dataBuf, mimeType]
    );

    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get collab file
router.get("/files/:id", async (req, res) => {
  try {
    const file = await queryOne(
      "SELECT * FROM collab_files WHERE id = $1",
      [req.params.id]
    );
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.send(file.data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
