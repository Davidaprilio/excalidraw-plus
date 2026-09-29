import { Router, Response } from "express";
import { queryOne } from "../db";
import { requireUuidParam, serverError } from "../utils/http";

// Public avatars of users and workspaces: <img> can't send the auth header and
// avatars aren't sensitive. URLs carry ?v=<avatar_version>, so they can be
// cached for long.
const router = Router();

router.param("id", requireUuidParam);

const sendAvatar = (res: Response, row: { avatar: Buffer; avatar_mime: string } | null) => {
  if (!row) {
    return res.status(404).json({ error: "No avatar" });
  }
  res.setHeader("Content-Type", row.avatar_mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(row.avatar);
};

router.get("/users/:id/avatar", async (req, res) => {
  try {
    sendAvatar(
      res,
      await queryOne("SELECT avatar, avatar_mime FROM users WHERE id = $1 AND avatar IS NOT NULL", [req.params.id])
    );
  } catch (err: any) {
    serverError(res, err);
  }
});

router.get("/workspaces/:id/avatar", async (req, res) => {
  try {
    sendAvatar(
      res,
      await queryOne(
        "SELECT avatar, avatar_mime FROM workspaces WHERE id = $1 AND avatar IS NOT NULL",
        [req.params.id]
      )
    );
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
