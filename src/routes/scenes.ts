import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";

const router = Router();

// List user's scenes
router.get("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const scenes = await query(
      `SELECT s.id, s.title, s.version, s.is_shared, s.created_at, s.updated_at,
              u.name as owner_name
       FROM scenes s
       LEFT JOIN users u ON s.owner_id = u.id
       WHERE s.owner_id = $1
       ORDER BY s.updated_at DESC`,
      [req.userId]
    );
    res.json({ scenes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new scene
router.post("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { title, elements, appState } = req.body;
    const scene = await queryOne(
      `INSERT INTO scenes (id, owner_id, title, elements, app_state)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [uuidv4(), req.userId, title || "Untitled", JSON.stringify(elements || []), JSON.stringify(appState || {})]
    );
    res.status(201).json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get scene
router.get("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const scene = await queryOne(
      `SELECT * FROM scenes WHERE id = $1 AND owner_id = $2`,
      [req.params.id, req.userId]
    );
    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update scene (auto-save)
router.put("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { elements, appState, title } = req.body;

    // Get current version
    const current = await queryOne(
      "SELECT version FROM scenes WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.userId]
    );
    if (!current) {
      return res.status(404).json({ error: "Scene not found" });
    }

    const newVersion = current.version + 1;

    // Save version history
    await query(
      `INSERT INTO scene_versions (scene_id, version, elements, app_state, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, current.version, JSON.stringify(elements), JSON.stringify(appState || {}), req.userId]
    );

    // Update scene
    const scene = await queryOne(
      `UPDATE scenes
       SET elements = $1, app_state = $2, version = $3, updated_at = NOW(),
           title = COALESCE($4, title)
       WHERE id = $5 AND owner_id = $6
       RETURNING *`,
      [JSON.stringify(elements), JSON.stringify(appState || {}), newVersion, title, req.params.id, req.userId]
    );

    res.json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Rename scene
router.patch("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }
    const scene = await queryOne(
      `UPDATE scenes SET title = $1, updated_at = NOW()
       WHERE id = $2 AND owner_id = $3
       RETURNING id, title, updated_at`,
      [title.trim(), req.params.id, req.userId]
    );
    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete scene
router.delete("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    await query("DELETE FROM scenes WHERE id = $1 AND owner_id = $2", [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get version history
router.get("/:id/versions", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const versions = await query(
      `SELECT sv.id, sv.version, sv.created_at, u.name as created_by_name
       FROM scene_versions sv
       LEFT JOIN users u ON sv.created_by = u.id
       WHERE sv.scene_id = $1
       ORDER BY sv.version DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json({ versions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific version
router.get("/:id/versions/:version", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const version = await queryOne(
      `SELECT * FROM scene_versions
       WHERE scene_id = $1 AND version = $2`,
      [req.params.id, parseInt(req.params.version as string)]
    );
    if (!version) {
      return res.status(404).json({ error: "Version not found" });
    }
    res.json({ version });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restore version
router.post("/:id/restore/:version", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const version = await queryOne(
      `SELECT * FROM scene_versions WHERE scene_id = $1 AND version = $2`,
      [req.params.id, parseInt(req.params.version as string)]
    );
    if (!version) {
      return res.status(404).json({ error: "Version not found" });
    }

    // Save current as new version before restoring
    const current = await queryOne(
      "SELECT version, elements, app_state FROM scenes WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.userId]
    );
    if (current) {
      await query(
        `INSERT INTO scene_versions (scene_id, version, elements, app_state, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.params.id, current.version, current.elements, current.app_state, req.userId]
      );
    }

    const newVersion = (current?.version || 0) + 1;
    const scene = await queryOne(
      `UPDATE scenes
       SET elements = $1, app_state = $2, version = $3, updated_at = NOW()
       WHERE id = $4 AND owner_id = $5
       RETURNING *`,
      [version.elements, version.app_state, newVersion, req.params.id, req.userId]
    );

    res.json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Generate share token
router.post("/:id/share", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const shareToken = uuidv4().replace(/-/g, "").slice(0, 20);
    const scene = await queryOne(
      `UPDATE scenes SET is_shared = TRUE, share_token = $1
       WHERE id = $2 AND owner_id = $3
       RETURNING id, share_token, is_shared`,
      [shareToken, req.params.id, req.userId]
    );
    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get shared scene (public, no auth)
router.get("/shared/:token", async (req, res) => {
  try {
    const scene = await queryOne(
      `SELECT id, title, elements, app_state, version, created_at, updated_at
       FROM scenes WHERE share_token = $1 AND is_shared = TRUE`,
      [req.params.token]
    );
    if (!scene) {
      return res.status(404).json({ error: "Shared scene not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
