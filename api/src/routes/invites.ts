import { Router } from "express";
import { queryOne, withTransaction } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { serverError } from "../utils/http";
import { ensurePersonalCollection } from "../access";

const router = Router();

router.use(authMiddleware);

const findInvite = (token: string) =>
  queryOne(
    `SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, w.name as workspace_name,
            (extract(epoch from w.avatar_updated_at) * 1000)::bigint as workspace_avatar_version,
            u.name as invited_by_name
     FROM workspace_invites i
     JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
     LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.token = $1`,
    [token]
  );

// Invite details for the accept screen
router.get("/:token", async (req: AuthRequest, res) => {
  try {
    const invite = await findInvite(req.params.token as string);
    if (!invite || new Date(invite.expires_at) < new Date()) {
      return res.status(404).json({ error: "This invite is invalid or has expired" });
    }
    const member = await queryOne(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [invite.workspace_id, req.userId]
    );
    res.json({
      invite: {
        workspaceId: invite.workspace_id,
        workspaceName: invite.workspace_name,
        workspaceAvatarVersion: invite.workspace_avatar_version,
        invitedByName: invite.invited_by_name,
        role: invite.role,
        email: invite.email,
        alreadyMember: !!member,
      },
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/:token/accept", async (req: AuthRequest, res) => {
  try {
    const invite = await findInvite(req.params.token as string);
    if (!invite || new Date(invite.expires_at) < new Date()) {
      return res.status(404).json({ error: "This invite is invalid or has expired" });
    }
    if (invite.email) {
      const user = await queryOne("SELECT email FROM users WHERE id = $1", [req.userId]);
      if (user.email.toLowerCase() !== invite.email) {
        return res.status(403).json({ error: `This invite was sent to ${invite.email}` });
      }
    }
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [invite.workspace_id, req.userId, invite.role]
      );
      await ensurePersonalCollection(client, invite.workspace_id, req.userId!);
      // Email invites are single use; link invites stay valid until revoked or expired
      if (invite.email) {
        await client.query("DELETE FROM workspace_invites WHERE id = $1", [invite.id]);
      }
    });
    res.json({ workspaceId: invite.workspace_id });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
