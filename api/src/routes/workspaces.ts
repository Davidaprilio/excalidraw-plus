import { Router, Response } from "express";
import crypto from "crypto";
import { query, queryOne, withTransaction } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireUuidParam, serverError } from "../utils/http";
import { createWorkspace, defaultWorkspaceName, getMembership, Membership, WorkspaceRole } from "../access";
import { avatarVersionSql, parseAvatarDataUrl } from "../utils/avatar";

const router = Router();

router.use(authMiddleware);
for (const param of ["wid", "uid", "iid", "cid"]) {
  router.param(param, requireUuidParam);
}

const ROLES: WorkspaceRole[] = ["admin", "member"];
const INVITE_TTL = "7 days";

/** Resolve the caller's membership, answering 404/403 itself when access is denied. */
async function requireMembership(
  req: AuthRequest,
  res: Response,
  needed: "any" | "admin" | "owner"
): Promise<Membership | null> {
  const membership = await getMembership(req.params.wid as string, req.userId!);
  if (!membership) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  if (needed === "admin" && membership.role !== "admin") {
    res.status(403).json({ error: "Only workspace admins can do this" });
    return null;
  }
  if (needed === "owner" && !membership.is_owner) {
    res.status(403).json({ error: "Only the workspace owner can do this" });
    return null;
  }
  return membership;
}

const requireRole = async (req: AuthRequest, res: Response, needed: "any" | "admin") =>
  (await requireMembership(req, res, needed))?.role ?? null;

const WORKSPACE_COLUMNS = `w.id, w.name, w.created_at, w.is_personal, w.owner_id, u.name as owner_name,
  (w.owner_id = $1) as is_owner,
  (SELECT COUNT(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) as member_count,
  (SELECT COUNT(*)::int FROM scenes s WHERE s.workspace_id = w.id AND s.deleted_at IS NULL) as scene_count,
  ${avatarVersionSql("w")}`;

/** Soft delete: members lose access at once; the owner can restore it from their trash. */
const softDeleteWorkspace = (workspaceId: string, userId: string) =>
  query("UPDATE workspaces SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1", [workspaceId, userId]);

// ---- Workspaces ----

// List my workspaces, personal one first. Every user has a personal workspace: recreate it if missing.
router.get("/", async (req: AuthRequest, res) => {
  try {
    const list = () =>
      query(
        `SELECT ${WORKSPACE_COLUMNS}, wm.role
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
         LEFT JOIN users u ON u.id = w.owner_id
         WHERE w.deleted_at IS NULL
         ORDER BY (w.is_personal AND w.owner_id = $1) DESC, wm.joined_at`,
        [req.userId]
      );
    let workspaces = await list();
    if (!workspaces.some((w) => w.is_personal && w.is_owner)) {
      const user = await queryOne("SELECT name, email FROM users WHERE id = $1", [req.userId]);
      await withTransaction((client) =>
        createWorkspace(client, req.userId!, defaultWorkspaceName(user), { personal: true })
      );
      workspaces = await list();
    }
    res.json({ workspaces });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/", async (req: AuthRequest, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ error: "Workspace name is required" });
    }
    const workspace = await withTransaction((client) => createWorkspace(client, req.userId!, name.slice(0, 255)));
    res.status(201).json({
      workspace: { ...workspace, role: "admin", is_owner: true, member_count: 1, scene_count: 0 },
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---- Deleted workspaces (the owner's trash). Registered before /:wid routes. ----

router.get("/deleted", async (req: AuthRequest, res) => {
  try {
    const workspaces = await query(
      `SELECT ${WORKSPACE_COLUMNS}, w.deleted_at, db.name as deleted_by_name
       FROM workspaces w
       LEFT JOIN users u ON u.id = w.owner_id
       LEFT JOIN users db ON db.id = w.deleted_by
       WHERE w.owner_id = $1 AND w.deleted_at IS NOT NULL
       ORDER BY w.deleted_at DESC`,
      [req.userId]
    );
    res.json({ workspaces });
  } catch (err: any) {
    serverError(res, err);
  }
});

const findDeletedOwnedWorkspace = (workspaceId: string, userId: string) =>
  queryOne("SELECT id FROM workspaces WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL", [
    workspaceId,
    userId,
  ]);

router.post("/:wid/restore", async (req: AuthRequest, res) => {
  try {
    if (!(await findDeletedOwnedWorkspace(req.params.wid as string, req.userId!))) {
      return res.status(404).json({ error: "Workspace not found in trash" });
    }
    await withTransaction(async (client) => {
      await client.query("UPDATE workspaces SET deleted_at = NULL, deleted_by = NULL WHERE id = $1", [req.params.wid]);
      // The owner may have been the last member when it was deleted by leaving
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'admin'`,
        [req.params.wid, req.userId]
      );
    });
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Delete forever, with all its scenes and collections
router.delete("/:wid/permanent", async (req: AuthRequest, res) => {
  try {
    if (!(await findDeletedOwnedWorkspace(req.params.wid as string, req.userId!))) {
      return res.status(404).json({ error: "Workspace not found in trash" });
    }
    await query("DELETE FROM workspaces WHERE id = $1", [req.params.wid]);
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---- Live workspace ----

router.get("/:wid", async (req: AuthRequest, res) => {
  try {
    const membership = await requireMembership(req, res, "any");
    if (!membership) return;
    const workspace = await queryOne(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id WHERE w.id = $2`,
      [req.userId, req.params.wid]
    );
    res.json({ workspace: { ...workspace, role: membership.role } });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.patch("/:wid", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ error: "Workspace name is required" });
    }
    const workspace = await queryOne(
      "UPDATE workspaces SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name",
      [name.slice(0, 255), req.params.wid]
    );
    res.json({ workspace });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Workspace photo (admins); served publicly by routes/avatars.ts
router.put("/:wid/avatar", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    const avatar = parseAvatarDataUrl(req.body.image);
    if ("error" in avatar) {
      return res.status(avatar.status).json({ error: avatar.error });
    }
    const workspace = await queryOne(
      `UPDATE workspaces SET avatar = $1, avatar_mime = $2, avatar_updated_at = NOW(), updated_at = NOW()
       WHERE id = $3
       RETURNING id, ${avatarVersionSql()}`,
      [avatar.data, avatar.mime, req.params.wid]
    );
    res.json({ workspace });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.delete("/:wid/avatar", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    await query(
      "UPDATE workspaces SET avatar = NULL, avatar_mime = NULL, avatar_updated_at = NULL, updated_at = NOW() WHERE id = $1",
      [req.params.wid]
    );
    res.json({ workspace: { id: req.params.wid, avatar_version: null } });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Move the workspace (with its scenes) to the owner's trash. Personal workspaces can't be deleted.
router.delete("/:wid", async (req: AuthRequest, res) => {
  try {
    const membership = await requireMembership(req, res, "owner");
    if (!membership) return;
    if (membership.is_personal) {
      return res.status(400).json({ error: "Your personal workspace can't be deleted" });
    }
    await softDeleteWorkspace(req.params.wid as string, req.userId!);
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Hand ownership to another member (who becomes admin). The old owner stays as admin.
router.post("/:wid/transfer", async (req: AuthRequest, res) => {
  try {
    const membership = await requireMembership(req, res, "owner");
    if (!membership) return;
    if (membership.is_personal) {
      return res.status(400).json({ error: "A personal workspace can't change owner" });
    }
    const { userId } = req.body;
    if (userId === req.userId) {
      return res.status(400).json({ error: "You already own this workspace" });
    }
    const target = await queryOne("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
      req.params.wid,
      userId,
    ]);
    if (!target) {
      return res.status(404).json({ error: "The new owner must be a member of the workspace" });
    }
    await withTransaction(async (client) => {
      await client.query("UPDATE workspaces SET owner_id = $2, updated_at = NOW() WHERE id = $1", [
        req.params.wid,
        userId,
      ]);
      await client.query("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2", [
        req.params.wid,
        userId,
      ]);
    });
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

/**
 * Leave the workspace. Members just leave; the owner must name `newOwnerId` (another
 * member). An owner with nobody to hand it to must delete the workspace instead
 * (409 `code: "last_member"`). Nobody can leave their personal workspace.
 */
router.post("/:wid/leave", async (req: AuthRequest, res) => {
  try {
    const membership = await requireMembership(req, res, "any");
    if (!membership) return;
    if (membership.is_personal && membership.is_owner) {
      return res.status(400).json({ error: "You can't leave your personal workspace" });
    }

    if (membership.is_owner) {
      const others = await query("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id <> $2", [
        req.params.wid,
        req.userId,
      ]);
      if (!others.length) {
        return res.status(409).json({
          code: "last_member",
          error: "You're the only member. Delete the workspace instead.",
        });
      }
      const { newOwnerId } = req.body;
      if (!others.some((m) => m.user_id === newOwnerId)) {
        return res.status(400).json({ error: "Choose a new owner among the members before leaving" });
      }
      await withTransaction(async (client) => {
        await client.query("UPDATE workspaces SET owner_id = $2, updated_at = NOW() WHERE id = $1", [
          req.params.wid,
          newOwnerId,
        ]);
        await client.query(
          "UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2",
          [req.params.wid, newOwnerId]
        );
        await client.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
          req.params.wid,
          req.userId,
        ]);
      });
    } else {
      await query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
        req.params.wid,
        req.userId,
      ]);
    }
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---- Members ----

router.get("/:wid/members", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "any"))) return;
    const members = await query(
      `SELECT u.id, u.email, u.name, wm.role, wm.joined_at, (w.owner_id = u.id) as is_owner,
              (extract(epoch from u.avatar_updated_at) * 1000)::bigint as avatar_version
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = $1
       ORDER BY (w.owner_id = u.id) DESC, wm.joined_at`,
      [req.params.wid]
    );
    res.json({ members });
  } catch (err: any) {
    serverError(res, err);
  }
});

const isWorkspaceOwner = async (workspaceId: string, userId: string) =>
  !!(await queryOne("SELECT 1 FROM workspaces WHERE id = $1 AND owner_id = $2", [workspaceId, userId]));

router.patch("/:wid/members/:uid", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    const { role } = req.body;
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: "Role must be admin or member" });
    }
    if (await isWorkspaceOwner(req.params.wid as string, req.params.uid as string)) {
      return res.status(400).json({ error: "The owner is always an admin" });
    }
    const updated = await queryOne(
      "UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3 RETURNING user_id",
      [role, req.params.wid, req.params.uid]
    );
    if (!updated) {
      return res.status(404).json({ error: "Member not found" });
    }
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Admins remove other members; nobody can remove the owner (they leave via /leave).
// Their scenes stay in the workspace; shared ones remain visible to others.
router.delete("/:wid/members/:uid", async (req: AuthRequest, res) => {
  try {
    const isSelf = req.params.uid === req.userId;
    if (isSelf) {
      return res.status(400).json({ error: "Use leave to leave the workspace" });
    }
    if (!(await requireRole(req, res, "admin"))) return;
    if (await isWorkspaceOwner(req.params.wid as string, req.params.uid as string)) {
      return res.status(403).json({ error: "The workspace owner can't be removed" });
    }
    const removed = await queryOne(
      "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id",
      [req.params.wid, req.params.uid]
    );
    if (!removed) {
      return res.status(404).json({ error: "Member not found" });
    }
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---- Invites ----

router.get("/:wid/invites", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    const invites = await query(
      `SELECT i.id, i.email, i.role, i.token, i.created_at, i.expires_at, u.name as invited_by_name
       FROM workspace_invites i LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.workspace_id = $1 AND i.expires_at > NOW()
       ORDER BY i.created_at DESC`,
      [req.params.wid]
    );
    res.json({ invites });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Invite by email (single use, only that email can accept) or, without email, a shareable link
// Suggest registered users while typing an invite (INVITE_USER_SUGGESTIONS=false turns it off)
const INVITE_SUGGESTIONS_ENABLED = process.env.INVITE_USER_SUGGESTIONS !== "false";
const SUGGESTION_LIMIT = 8;

router.get("/:wid/invite-suggestions", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    if (!INVITE_SUGGESTIONS_ENABLED) {
      return res.json({ enabled: false, users: [] });
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 100) : "";
    // a couple of characters at least, so the list can't be dumped in one go
    if (q.length < 2) {
      return res.json({ enabled: true, users: [] });
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const users = await query(
      `SELECT u.id, u.name, u.email, (extract(epoch from u.avatar_updated_at) * 1000)::bigint as avatar_version
       FROM users u
       WHERE (LOWER(u.email) LIKE $2 OR LOWER(COALESCE(u.name, '')) LIKE $2)
         AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = $1 AND wm.user_id = u.id)
       ORDER BY (LOWER(u.email) LIKE $3 OR LOWER(COALESCE(u.name, '')) LIKE $3) DESC, LOWER(COALESCE(u.name, u.email))
       LIMIT ${SUGGESTION_LIMIT}`,
      [req.params.wid, like, `${like.slice(1)}`]
    );
    res.json({ enabled: true, users });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/:wid/invites", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    const role = req.body.role || "member";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: "Role must be admin or member" });
    }
    if (email) {
      const member = await queryOne(
        `SELECT 1 FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1 AND LOWER(u.email) = $2`,
        [req.params.wid, email]
      );
      if (member) {
        return res.status(409).json({ error: "This person is already a member" });
      }
    }
    const invite = await queryOne(
      `INSERT INTO workspace_invites (workspace_id, email, role, token, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${INVITE_TTL}')
       RETURNING id, email, role, token, created_at, expires_at`,
      [req.params.wid, email || null, role, crypto.randomBytes(24).toString("hex"), req.userId]
    );
    res.status(201).json({ invite });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.delete("/:wid/invites/:iid", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "admin"))) return;
    await query("DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2", [req.params.iid, req.params.wid]);
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---- Collections ----

// Collections I can see: my own (incl. my Private one) and those shared with the workspace
router.get("/:wid/collections", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "any"))) return;
    const collections = await query(
      `SELECT c.id, c.name, c.visibility, c.is_personal, c.owner_id, u.name as owner_name, c.created_at,
              (SELECT COUNT(*)::int FROM scenes s
               WHERE s.collection_id = c.id AND s.deleted_at IS NULL
                 AND (s.owner_id = $2 OR c.visibility = 'workspace')) as scene_count
       FROM collections c LEFT JOIN users u ON u.id = c.owner_id
       WHERE c.workspace_id = $1 AND (c.visibility = 'workspace' OR c.owner_id = $2)
       ORDER BY c.is_personal DESC, LOWER(c.name)`,
      [req.params.wid, req.userId]
    );
    res.json({ collections });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/:wid/collections", async (req: AuthRequest, res) => {
  try {
    if (!(await requireRole(req, res, "any"))) return;
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const visibility = req.body.visibility || "workspace";
    if (!name || !["private", "workspace"].includes(visibility)) {
      return res.status(400).json({ error: "name and a valid visibility are required" });
    }
    const collection = await queryOne(
      `INSERT INTO collections (workspace_id, owner_id, name, visibility)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, visibility, is_personal, owner_id, created_at`,
      [req.params.wid, req.userId, name.slice(0, 255), visibility]
    );
    res.status(201).json({ collection: { ...collection, scene_count: 0 } });
  } catch (err: any) {
    serverError(res, err);
  }
});

/** Collection the caller may manage: its owner or a workspace admin; never someone's Private. */
async function findManageableCollection(req: AuthRequest, res: Response) {
  const role = await requireRole(req, res, "any");
  if (!role) return null;
  const collection = await queryOne(
    `SELECT id, owner_id, visibility, is_personal FROM collections
     WHERE id = $1 AND workspace_id = $2 AND (visibility = 'workspace' OR owner_id = $3)`,
    [req.params.cid, req.params.wid, req.userId]
  );
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return null;
  }
  if (collection.is_personal) {
    res.status(400).json({ error: "The Private collection can't be changed" });
    return null;
  }
  if (collection.owner_id !== req.userId && role !== "admin") {
    res.status(403).json({ error: "Only the collection owner or a workspace admin can do this" });
    return null;
  }
  return collection;
}

router.patch("/:wid/collections/:cid", async (req: AuthRequest, res) => {
  try {
    if (!(await findManageableCollection(req, res))) return;
    const name = typeof req.body.name === "string" ? req.body.name.trim() : undefined;
    const { visibility } = req.body;
    if (name === "" || (visibility !== undefined && !["private", "workspace"].includes(visibility))) {
      return res.status(400).json({ error: "Invalid name or visibility" });
    }
    const collection = await queryOne(
      `UPDATE collections SET name = COALESCE($1, name), visibility = COALESCE($2, visibility), updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, visibility, is_personal, owner_id`,
      [name?.slice(0, 255) ?? null, visibility ?? null, req.params.cid]
    );
    res.json({ collection });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Deleting a collection moves its scenes to the trash (restoring puts them in Private)
router.delete("/:wid/collections/:cid", async (req: AuthRequest, res) => {
  try {
    if (!(await findManageableCollection(req, res))) return;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE scenes SET deleted_at = COALESCE(deleted_at, NOW()), deleted_by = COALESCE(deleted_by, $2)
         WHERE collection_id = $1`,
        [req.params.cid, req.userId]
      );
      await client.query("DELETE FROM collections WHERE id = $1", [req.params.cid]);
    });
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
