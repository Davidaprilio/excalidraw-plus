import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { query, queryOne } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { isUuid, serverError } from "../utils/http";
import { findScene } from "../access";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/uploads";

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const router = Router();

// Upload file
router.post("/", authMiddleware, upload.single("file"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { sceneId, fileId } = req.body;
    const id = fileId || req.file.filename;

    if (sceneId) {
      const scene = isUuid(sceneId) ? await findScene(sceneId, req.userId!) : null;
      if (!scene) {
        fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: "Scene not found" });
      }
    }

    // Excalidraw file ids are content hashes, so an existing id already holds this
    // content. Never overwrite it: another user's file must not be replaceable.
    const inserted = await queryOne(
      `INSERT INTO files (id, scene_id, owner_id, mime_type, size, filename)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, sceneId || null, req.userId, req.file.mimetype, req.file.size, req.file.filename]
    );
    if (!inserted) {
      fs.unlinkSync(req.file.path);
    }

    res.status(inserted ? 201 : 200).json({
      id,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Get file
router.get("/:id", async (req, res) => {
  try {
    const file = await queryOne("SELECT * FROM files WHERE id = $1", [req.params.id]);
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    const filePath = path.join(UPLOAD_DIR, file.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found on disk" });
    }

    res.setHeader("Content-Type", file.mime_type);
    res.setHeader("Cache-Control", "public, max-age=31536000");
    fs.createReadStream(filePath).pipe(res);
  } catch (err: any) {
    serverError(res, err);
  }
});

// Delete file
router.delete("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const file = await queryOne(
      `SELECT f.* FROM files f
       LEFT JOIN scenes s ON s.id = f.scene_id
       WHERE f.id = $1 AND (f.owner_id = $2 OR s.owner_id = $2)`,
      [req.params.id, req.userId]
    );
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }
    await query("DELETE FROM files WHERE id = $1", [req.params.id]);
    const filePath = path.join(UPLOAD_DIR, file.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
