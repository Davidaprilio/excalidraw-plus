import { PoolClient } from "pg";
import { query, queryOne } from "./db";

type Db = Pick<PoolClient, "query">;

const run = async <T>(client: Db | null, text: string, params: any[]): Promise<T | null> =>
  client ? ((await client.query(text, params)).rows[0] ?? null) : queryOne<T>(text, params);

export type WorkspaceRole = "admin" | "member";

/** Access levels (see collection_access_level in migration 015) */
export const ACCESS = { none: 0, view: 1, edit: 2, manage: 3 } as const;
export type CollectionRole = "view" | "edit" | "manage";
export const COLLECTION_ROLES: CollectionRole[] = ["view", "edit", "manage"];
export const levelToRole = (level: number): CollectionRole | null =>
  level >= 3 ? "manage" : level === 2 ? "edit" : level === 1 ? "view" : null;

/** SQL: the user's access level on scene `s` (see scene_access_level in migration 017) */
export const sceneLevelSql = (userParam: string) => `scene_access_level(s.id, ${userParam})`;

/**
 * SQL for "scenes `s` the user in `$userParam` may open" in a live workspace: their
 * own scenes (while they belong to its workspace) or scenes of a collection they
 * can access, which may be shared with them from another workspace. Exposes
 * `wm.role` (null for guests), `c` (the collection) and the level through `level`.
 */
export const sceneAccessSql = (userParam: string) => ({
  joins: `JOIN workspaces sw ON sw.id = s.workspace_id AND sw.deleted_at IS NULL
          LEFT JOIN workspace_members wm ON wm.workspace_id = s.workspace_id AND wm.user_id = ${userParam}
          LEFT JOIN collections c ON c.id = s.collection_id`,
  where: `(${sceneLevelSql(userParam)} > 0)`,
  level: sceneLevelSql(userParam),
});

export type AccessibleScene = {
  id: string;
  owner_id: string;
  workspace_id: string;
  collection_id: string | null;
  version: number;
  deleted_at: string | null;
  /** role in the scene's workspace; null for a guest (collection shared from elsewhere) */
  role: WorkspaceRole | null;
  /** 1 view, 2 edit, 3 manage */
  access_level: number;
};

/** The scene may be changed (saved, renamed, moved, trashed...) by this user */
export const canEditScene = (scene: AccessibleScene) => scene.access_level >= ACCESS.edit;

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
    `SELECT s.id, s.owner_id, s.workspace_id, s.collection_id, s.version, s.deleted_at, wm.role,
            ${access.level} as access_level
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
  /** null for a guest */
  role: WorkspaceRole | null;
  access_level: number;
};

/**
 * A collection the user can access, else null. By default one they can put
 * scenes in (edit); pass `minLevel` for other checks.
 */
export async function findCollection(
  collectionId: string,
  userId: string,
  minLevel: number = ACCESS.edit
): Promise<AccessibleCollection | null> {
  return queryOne<AccessibleCollection>(
    `SELECT * FROM (
       SELECT c.id, c.workspace_id, c.owner_id, c.name, c.visibility, c.is_personal, wm.role,
              collection_access_level(c.id, $2) as access_level
       FROM collections c
       JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
       LEFT JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $2
       WHERE c.id = $1
     ) x WHERE access_level >= $3`,
    [collectionId, userId, minLevel]
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
