import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, queryOne } from "../db";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  authMiddleware,
  AuthRequest,
} from "../middleware/auth";

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
    const user = await queryOne(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at",
      [email, passwordHash, name || email.split("@")[0]]
    );

    const accessToken = signAccessToken(user!.id);
    const refreshToken = signRefreshToken(user!.id);

    await query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
      [user!.id, refreshToken]
    );

    res.status(201).json({ accessToken, refreshToken, user });
  } catch (err: any) {
    console.error("Register error:", err, "stack:", err?.stack, "keys:", Object.keys(err || {}));
    res.status(500).json({ error: err.message || err.code || String(err) });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await queryOne(
      "SELECT id, email, name, password_hash FROM users WHERE email = $1",
      [email]
    );
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const accessToken = signAccessToken(user.id);
    const refreshToken = signRefreshToken(user.id);

    await query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
      [user.id, refreshToken]
    );

    res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

router.get("/me", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne(
      "SELECT id, email, name, created_at FROM users WHERE id = $1",
      [req.userId]
    );
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
