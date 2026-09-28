import { PoolClient } from "pg";
import { query, queryOne } from "./db";

type Db = Pick<PoolClient, "query">;

const run = async <T>(client: Db | null, text: string, params: any[]): Promise<T | null> =>
  client ? ((await client.query(text, params)).rows[0] ?? null) : queryOne<T>(text, params);

export type WorkspaceRole = "admin" | "member";

/**
 * SQL for "scenes `s` the user in `$userParam` may open": they must belong to the
 * scene's (not deleted) workspace, and either own the scene or it sits in a
 * collection shared with the whole workspace. Exposes `wm.role` and `c` (the collection).
 */
export const sceneAccessSql = (userParam: string) => ({
  joins: `JOIN workspaces sw ON sw.id = s.workspace_id AND sw.deleted_at IS NULL
          JOIN workspace_members wm ON wm.workspace_id = s.workspace_id AND wm.user_id = ${userParam}
          LEFT JOIN collections c ON c.id = s.collection_id`,
  where: `(s.owner_id = ${userParam} OR c.visibility = 'workspace')`,
});

export type AccessibleScene = {
  id: string;
  owner_id: string;
  workspace_id: string;
  collection_id: string | null;
  version: number;
  deleted_at: string | null;
  role: WorkspaceRole;
};

/**
 * The scene if the user may access it, else null. Trashed scenes are hidden unless
 * `includeDeleted`. Pass a transaction client with `forUpdate` to lock the row.
 */
export async function findScene(
  sceneId: string,
  userId: string,
  opts: { includeDeleted?: boolean; client?: Db; forUpdate?: boolean } = {}
): Promise<AccessibleScene | null> {
  const access = sceneAccessSql("$2");
  return run<AccessibleScene>(
    opts.client ?? null,
    `SELECT s.id, s.owner_id, s.workspace_id, s.collection_id, s.version, s.deleted_at, wm.role
     FROM scenes s ${access.joins}
     WHERE s.id = $1 AND ${access.where}
       ${opts.includeDeleted ? "" : "AND s.deleted_at IS NULL"}
     ${opts.forUpdate ? "FOR UPDATE OF s" : ""}`,
    [sceneId, userId]
  );
}

export type Membership = {
  role: WorkspaceRole;
  is_owner: boolean;
  /** the workspace is the owner's personal one: it can't be deleted or left */
  is_personal: boolean;
};

/** The user's membership of a live (not deleted) workspace, else null. */
export async function getMembership(workspaceId: string, userId: string): Promise<Membership | null> {
  return queryOne<Membership>(
    `SELECT wm.role, (w.owner_id = wm.user_id) as is_owner, w.is_personal
     FROM workspace_members wm
     JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
     WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
    [workspaceId, userId]
  );
}

export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  return (await getMembership(workspaceId, userId))?.role ?? null;
}

export type AccessibleCollection = {
  id: string;
  workspace_id: string;
  owner_id: string | null;
  name: string;
  visibility: "private" | "workspace";
  is_personal: boolean;
  role: WorkspaceRole;
};

/** A collection the user can see (and put scenes in), else null. */
export async function findCollection(collectionId: string, userId: string): Promise<AccessibleCollection | null> {
  return queryOne<AccessibleCollection>(
    `SELECT c.id, c.workspace_id, c.owner_id, c.name, c.visibility, c.is_personal, wm.role
     FROM collections c
     JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $2
     WHERE c.id = $1 AND (c.visibility = 'workspace' OR c.owner_id = $2)`,
    [collectionId, userId]
  );
}

/** Every member has one built-in "Private" collection per workspace. */
export async function ensurePersonalCollection(client: Db, workspaceId: string, userId: string): Promise<string> {
  await client.query(
    `INSERT INTO collections (workspace_id, owner_id, name, visibility, is_personal)
     VALUES ($1, $2, 'Private', 'private', TRUE)
     ON CONFLICT DO NOTHING`,
    [workspaceId, userId]
  );
  const { rows: [row] } = await client.query(
    "SELECT id FROM collections WHERE workspace_id = $1 AND owner_id = $2 AND is_personal",
    [workspaceId, userId]
  );
  return row.id;
}

export async function createWorkspace(client: Db, userId: string, name: string, opts: { personal?: boolean } = {}) {
  const { rows: [workspace] } = await client.query(
    "INSERT INTO workspaces (name, created_by, owner_id, is_personal) VALUES ($1, $2, $2, $3) RETURNING *",
    [name, userId, !!opts.personal]
  );
  await client.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
    [workspace.id, userId]
  );
  await ensurePersonalCollection(client, workspace.id, userId);
  return workspace;
}

export const defaultWorkspaceName = (user: { name?: string | null; email: string }) =>
  `${user.name || user.email.split("@")[0]}'s workspace`;

/** Workspace used when a request doesn't name one: the user's personal one (else oldest membership). */
export async function getDefaultWorkspaceId(userId: string): Promise<string | null> {
  const rows = await query<{ workspace_id: string }>(
    `SELECT wm.workspace_id FROM workspace_members wm
     JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
     WHERE wm.user_id = $1
     ORDER BY (w.is_personal AND w.owner_id = $1) DESC, wm.joined_at
     LIMIT 1`,
    [userId]
  );
  return rows[0]?.workspace_id ?? null;
}
