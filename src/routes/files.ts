import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { query, queryOne } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";

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

    await query(
      `INSERT INTO files (id, scene_id, mime_type, size, filename)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET mime_type = $3, size = $4, filename = $5`,
      [id, sceneId || null, req.file.mimetype, req.file.size, req.file.filename]
    );

    res.status(201).json({
      id,
      filename: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// Delete file
router.delete("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const file = await queryOne("SELECT * FROM files WHERE id = $1", [req.params.id]);
    if (file) {
      const filePath = path.join(UPLOAD_DIR, file.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      await query("DELETE FROM files WHERE id = $1", [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
