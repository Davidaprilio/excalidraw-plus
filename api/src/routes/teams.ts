import { Router } from "express";
import { query, queryOne } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireUuidParam, serverError } from "../utils/http";
import { v4 as uuidv4 } from "uuid";

const router = Router();

router.param("id", requireUuidParam);
router.param("userId", requireUuidParam);

// List user's teams
router.get("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const teams = await query(
      `SELECT t.*, tm.role,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
       FROM teams t
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = $1
       ORDER BY t.created_at DESC`,
      [req.userId]
    );
    res.json({ teams });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Create team
router.post("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Team name required" });
    }

    const team = await queryOne(
      `INSERT INTO teams (id, name, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [uuidv4(), name, req.userId]
    );

    // Add creator as owner
    await query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [team!.id, req.userId]
    );

    res.status(201).json({ team });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Get team with members
router.get("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    // Check membership
    const member = await queryOne(
      "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (!member) {
      return res.status(403).json({ error: "Not a team member" });
    }

    const team = await queryOne("SELECT * FROM teams WHERE id = $1", [req.params.id]);
    const members = await query(
      `SELECT u.id, u.email, u.name, tm.role, tm.joined_at
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1`,
      [req.params.id]
    );

    res.json({ team, members });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Add member
router.post("/:id/members", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { email } = req.body;
    const role = req.body.role || "member";
    if (!["member", "admin"].includes(role)) {
      return res.status(400).json({ error: "Role must be member or admin" });
    }

    // Check if requester is admin/owner
    const requester = await queryOne(
      "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (!requester || !["owner", "admin"].includes(requester.role)) {
      return res.status(403).json({ error: "Only owners/admins can add members" });
    }
    if (role === "admin" && requester.role !== "owner") {
      return res.status(403).json({ error: "Only the owner can add admins" });
    }

    const user = await queryOne("SELECT id FROM users WHERE email = $1", [email]);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [req.params.id, user.id, role]
    );

    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Remove member (or leave the team when removing yourself)
router.delete("/:id/members/:userId", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const [requester, target] = await Promise.all(
      [req.userId, req.params.userId].map((userId) =>
        queryOne("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2", [req.params.id, userId])
      )
    );
    if (!requester) {
      return res.status(403).json({ error: "Not a team member" });
    }
    if (!target) {
      return res.status(404).json({ error: "Member not found" });
    }
    if (target.role === "owner") {
      return res.status(403).json({ error: "The team owner cannot be removed" });
    }

    const isSelf = req.params.userId === req.userId;
    const canRemove =
      isSelf ||
      requester.role === "owner" ||
      (requester.role === "admin" && target.role === "member");
    if (!canRemove) {
      return res.status(403).json({ error: "Not allowed to remove this member" });
    }

    await query(
      "DELETE FROM team_members WHERE team_id = $1 AND user_id = $2",
      [req.params.id, req.params.userId]
    );

    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
