import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, queryOne, withTransaction } from "../db";
import { createWorkspace, defaultWorkspaceName } from "../access";
import {
  signAccessToken,
  signPurposeToken,
  verifyRefreshToken,
  authMiddleware,
  AuthRequest,
} from "../middleware/auth";
import { serverError } from "../utils/http";
import { issueSession } from "../utils/session";
import { parseAvatarDataUrl } from "../utils/avatar";
import crypto from "crypto";

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const existing = await queryOne("SELECT id FROM users WHERE email = $1", [email]);
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // Every account starts with its own workspace (and Private collection)
    const user = await withTransaction(async (client) => {
      const { rows: [created] } = await client.query(
        "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at, NULL::bigint as avatar_version",
        [email, passwordHash, name || email.split("@")[0]]
      );
      await createWorkspace(client, created.id, defaultWorkspaceName(created), { personal: true });
      return created;
    });

    res.status(201).json(await issueSession(user.id));
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await queryOne(
      "SELECT id, password_hash, (totp_secret IS NOT NULL) as totp_enabled FROM users WHERE email = $1",
      [email]
    );
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Two-factor: no tokens yet, the client completes with POST /auth/login/mfa
    if (user.totp_enabled) {
      return res.json({
        mfaRequired: true,
        mfaToken: signPurposeToken("mfa", { userId: user.id, nonce: crypto.randomUUID() }),
      });
    }

    res.json(await issueSession(user.id));
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "Refresh token required" });
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    const stored = await queryOne(
      "SELECT id FROM refresh_tokens WHERE token = $1 AND user_id = $2 AND expires_at > NOW()",
      [refreshToken, payload.userId]
    );
    if (!stored) {
      return res.status(401).json({ error: "Refresh token revoked" });
    }

    const accessToken = signAccessToken(payload.userId);
    res.json({ accessToken });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/logout", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await query("DELETE FROM refresh_tokens WHERE token = $1", [refreshToken]);
    }
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.get("/me", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne(
      "SELECT id, email, name, created_at, (extract(epoch from avatar_updated_at) * 1000)::bigint as avatar_version FROM users WHERE id = $1",
      [req.userId]
    );
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ user });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Update profile (display name)
router.patch("/me", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }
    const user = await queryOne(
      "UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, created_at, (extract(epoch from avatar_updated_at) * 1000)::bigint as avatar_version",
      [name.slice(0, 255), req.userId]
    );
    res.json({ user });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Upload profile photo (a data URL, already resized by the client)
router.put("/me/avatar", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const avatar = parseAvatarDataUrl(req.body.image);
    if ("error" in avatar) {
      return res.status(avatar.status).json({ error: avatar.error });
    }
    const user = await queryOne(
      `UPDATE users SET avatar = $1, avatar_mime = $2, avatar_updated_at = NOW(), updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, name, created_at, ${"(extract(epoch from avatar_updated_at) * 1000)::bigint as avatar_version"}`,
      [avatar.data, avatar.mime, req.userId]
    );
    res.json({ user });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.delete("/me/avatar", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne(
      `UPDATE users SET avatar = NULL, avatar_mime = NULL, avatar_updated_at = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, created_at, NULL::bigint as avatar_version`,
      [req.userId]
    );
    res.json({ user });
  } catch (err: any) {
    serverError(res, err);
  }
});

const MIN_PASSWORD_LENGTH = 8;

/**
 * Change password. Other devices are signed out (their refresh tokens are
 * revoked); pass `refreshToken` to keep the current device's session.
 */
router.post("/change-password", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { currentPassword, newPassword, refreshToken } = req.body;
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `The new password needs at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    const user = await queryOne("SELECT password_hash FROM users WHERE id = $1", [req.userId]);
    if (!user || typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: "The current password is incorrect" });
    }
    await withTransaction(async (client) => {
      await client.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [
        await bcrypt.hash(newPassword, 10),
        req.userId,
      ]);
      await client.query("DELETE FROM refresh_tokens WHERE user_id = $1 AND token IS DISTINCT FROM $2", [
        req.userId,
        typeof refreshToken === "string" ? refreshToken : null,
      ]);
    });
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
