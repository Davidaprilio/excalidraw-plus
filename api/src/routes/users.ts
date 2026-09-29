import { Router } from "express";
import { queryOne } from "../db";
import { requireUuidParam, serverError } from "../utils/http";

// Public profile photos: <img> can't send the auth header, and avatars aren't
// sensitive. URLs carry ?v=<avatar_version>, so they can be cached for long.
const router = Router();

router.param("id", requireUuidParam);

router.get("/:id/avatar", async (req, res) => {
  try {
    const user = await queryOne("SELECT avatar, avatar_mime FROM users WHERE id = $1 AND avatar IS NOT NULL", [
      req.params.id,
    ]);
    if (!user) {
      return res.status(404).json({ error: "No avatar" });
    }
    res.setHeader("Content-Type", user.avatar_mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(user.avatar);
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
