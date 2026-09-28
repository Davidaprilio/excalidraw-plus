import { Router } from "express";
import { query, queryOne } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireUuidParam, serverError } from "../utils/http";
import { v4 as uuidv4 } from "uuid";

const router = Router();

router.param("id", requireUuidParam);

// List user's libraries
router.get("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const libraries = await query(
      `SELECT l.*, u.name as owner_name
       FROM libraries l
       LEFT JOIN users u ON l.owner_id = u.id
       WHERE l.owner_id = $1 OR l.is_public = TRUE
       ORDER BY l.updated_at DESC`,
      [req.userId]
    );
    res.json({ libraries });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Create library
router.post("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { name, items, isPublic } = req.body;
    const library = await queryOne(
      `INSERT INTO libraries (id, owner_id, name, items, is_public)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [uuidv4(), req.userId, name || "My Library", JSON.stringify(items || []), isPublic || false]
    );
    res.status(201).json({ library });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Update library
router.put("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { name, items, isPublic } = req.body;
    const library = await queryOne(
      `UPDATE libraries
       SET name = COALESCE($1, name),
           items = COALESCE($2, items),
           is_public = COALESCE($3, is_public),
           updated_at = NOW()
       WHERE id = $4 AND owner_id = $5
       RETURNING *`,
      [name, items ? JSON.stringify(items) : null, isPublic, req.params.id, req.userId]
    );
    if (!library) {
      return res.status(404).json({ error: "Library not found" });
    }
    res.json({ library });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Delete library
router.delete("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    await query("DELETE FROM libraries WHERE id = $1 AND owner_id = $2", [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
