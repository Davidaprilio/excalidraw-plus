import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne, withTransaction } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { isUuid, requireUuidParam, serverError } from "../utils/http";
import {
  ensurePersonalCollection,
  findCollection,
  findScene,
  getDefaultWorkspaceId,
  getWorkspaceRole,
  sceneAccessSql,
} from "../access";

const router = Router();

router.param("id", requireUuidParam);

const THUMBNAIL_DATA_URL_RE = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/;
const MAX_THUMBNAIL_BYTES = 512 * 1024;

// Autosave runs every few seconds; keep at most one history snapshot per interval
const SNAPSHOT_INTERVAL = "10 minutes";

const LIST_VIEWS = ["all", "recent", "visited", "trash"] as const;
type ListView = (typeof LIST_VIEWS)[number];

function parseVersion(value: string): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * List scenes in a workspace.
 * Query: workspaceId (required), collectionId, view=all|recent|visited|trash, q (title search), limit
 */
router.get("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { workspaceId, collectionId, q } = req.query;
    const view = (req.query.view || "all") as ListView;
    if (!isUuid(workspaceId) || !LIST_VIEWS.includes(view) || (collectionId && !isUuid(collectionId))) {
      return res.status(400).json({ error: "Invalid workspaceId, collectionId or view" });
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 200, 1), 500);

    const access = sceneAccessSql("$1");
    const params: any[] = [req.userId, workspaceId];
    const filters = [access.where, "s.workspace_id = $2"];
    filters.push(view === "trash" ? "s.deleted_at IS NOT NULL" : "s.deleted_at IS NULL");
    if (view === "recent") filters.push("s.updated_by = $1");
    if (view === "visited") filters.push("v.visited_at IS NOT NULL");
    if (collectionId) {
      params.push(collectionId);
      filters.push(`s.collection_id = $${params.length}`);
    }
    if (typeof q === "string" && q.trim()) {
      params.push(`%${escapeLike(q.trim())}%`);
      filters.push(`s.title ILIKE $${params.length}`);
    }
    const orderBy = {
      all: "s.updated_at DESC",
      recent: "s.updated_at DESC",
      visited: "v.visited_at DESC",
      trash: "s.deleted_at DESC",
    }[view];

    const scenes = await query(
      `SELECT s.id, s.title, s.version, s.is_shared, s.created_at, s.updated_at,
              s.owner_id, u.name as owner_name, ub.name as updated_by_name,
              s.collection_id, c.name as collection_name,
              s.deleted_at, db.name as deleted_by_name, v.visited_at,
              t.scene_version as thumbnail_version,
              EXISTS (
                SELECT 1 FROM jsonb_array_elements(s.elements) e
                WHERE NOT COALESCE((e->>'isDeleted')::boolean, false)
              ) as has_content,
              (s.owner_id = $1 OR wm.role = 'admin') as can_delete_permanently
       FROM scenes s
       ${access.joins}
       LEFT JOIN users u ON u.id = s.owner_id
       LEFT JOIN users ub ON ub.id = s.updated_by
       LEFT JOIN users db ON db.id = s.deleted_by
       LEFT JOIN scene_thumbnails t ON t.scene_id = s.id
       LEFT JOIN scene_visits v ON v.scene_id = s.id AND v.user_id = $1
       WHERE ${filters.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ${limit}`,
      params
    );
    res.json({ scenes });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Create new scene, in `collectionId` or else the user's Private collection of `workspaceId`
router.post("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { title, elements, appState, workspaceId, collectionId } = req.body;

    let targetWorkspaceId: string | null;
    let targetCollectionId: string | null = null;
    if (collectionId) {
      const collection = isUuid(collectionId) ? await findCollection(collectionId, req.userId!) : null;
      if (!collection) {
        return res.status(404).json({ error: "Collection not found" });
      }
      targetWorkspaceId = collection.workspace_id;
      targetCollectionId = collection.id;
    } else if (workspaceId) {
      if (!isUuid(workspaceId) || !(await getWorkspaceRole(workspaceId, req.userId!))) {
        return res.status(404).json({ error: "Workspace not found" });
      }
      targetWorkspaceId = workspaceId;
    } else {
      targetWorkspaceId = await getDefaultWorkspaceId(req.userId!);
    }
    if (!targetWorkspaceId) {
      return res.status(400).json({ error: "No workspace" });
    }

    const scene = await withTransaction(async (client) => {
      const collection = targetCollectionId ?? (await ensurePersonalCollection(client, targetWorkspaceId!, req.userId!));
      const { rows: [created] } = await client.query(
        `INSERT INTO scenes (id, owner_id, updated_by, workspace_id, collection_id, title, elements, app_state)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
         RETURNING id, title, version, workspace_id, collection_id, created_at, updated_at`,
        [
          uuidv4(),
          req.userId,
          targetWorkspaceId,
          collection,
          title || "Untitled",
          JSON.stringify(elements || []),
          JSON.stringify(appState || {}),
        ]
      );
      return created;
    });
    res.status(201).json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Get scene
router.get("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Scene not found" });
    }
    const scene = await queryOne(
      `SELECT s.id, s.title, s.elements, s.app_state, s.version, s.is_shared, s.share_token,
              s.workspace_id, s.collection_id, c.name as collection_name,
              s.owner_id, s.created_at, s.updated_at
       FROM scenes s LEFT JOIN collections c ON c.id = s.collection_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Record that the user opened the scene (for "Recently visited by you")
router.post("/:id/visit", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Scene not found" });
    }
    await query(
      `INSERT INTO scene_visits (user_id, scene_id) VALUES ($1, $2)
       ON CONFLICT (user_id, scene_id) DO UPDATE SET visited_at = NOW()`,
      [req.userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Update scene (auto-save)
router.put("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { elements, appState, title } = req.body;
    if (!Array.isArray(elements)) {
      return res.status(400).json({ error: "elements must be an array" });
    }

    const scene = await withTransaction(async (client) => {
      const current = await findScene(req.params.id as string, req.userId!, { client, forUpdate: true });
      if (!current) {
        return null;
      }

      // Snapshot the state being overwritten, unless a recent snapshot exists
      await client.query(
        `INSERT INTO scene_versions (scene_id, version, elements, app_state, created_by)
         SELECT id, version, elements, app_state, $2 FROM scenes
         WHERE id = $1
           AND jsonb_array_length(elements) > 0
           AND NOT EXISTS (
             SELECT 1 FROM scene_versions
             WHERE scene_id = $1 AND created_at > NOW() - INTERVAL '${SNAPSHOT_INTERVAL}'
           )`,
        [req.params.id, req.userId]
      );

      const { rows: [updated] } = await client.query(
        `UPDATE scenes
         SET elements = $1, app_state = $2, version = version + 1, updated_at = NOW(),
             updated_by = $5, title = COALESCE($3, title)
         WHERE id = $4
         RETURNING id, title, version, updated_at`,
        [JSON.stringify(elements), JSON.stringify(appState || {}), title, req.params.id, req.userId]
      );
      return updated;
    });

    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Rename and/or move to another collection of the same workspace
router.patch("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { title, collectionId } = req.body;
    if (title === undefined && collectionId === undefined) {
      return res.status(400).json({ error: "title or collectionId is required" });
    }
    if (title !== undefined && (typeof title !== "string" || !title.trim())) {
      return res.status(400).json({ error: "Title is required" });
    }

    const current = await findScene(req.params.id as string, req.userId!);
    if (!current) {
      return res.status(404).json({ error: "Scene not found" });
    }
    if (collectionId !== undefined) {
      const collection = isUuid(collectionId) ? await findCollection(collectionId, req.userId!) : null;
      if (!collection || collection.workspace_id !== current.workspace_id) {
        return res.status(404).json({ error: "Collection not found" });
      }
    }

    const scene = await queryOne(
      `UPDATE scenes
       SET title = COALESCE($1, title), collection_id = COALESCE($2, collection_id),
           updated_at = NOW(), updated_by = $4
       WHERE id = $3
       RETURNING id, title, collection_id, updated_at`,
      [title?.trim() ?? null, collectionId ?? null, req.params.id, req.userId]
    );
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

/**
 * Move a scene to another workspace the user belongs to (into `collectionId`, or
 * their Private collection there). Only the scene's owner or a workspace admin may,
 * and the mover becomes the owner: the old owner may not be a member of the target.
 */
router.post("/:id/transfer", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { workspaceId, collectionId } = req.body;
    const scene = await findScene(req.params.id as string, req.userId!);
    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }
    if (scene.owner_id !== req.userId && scene.role !== "admin") {
      return res.status(403).json({ error: "Only the scene owner or a workspace admin can move it to another workspace" });
    }
    if (!isUuid(workspaceId) || !(await getWorkspaceRole(workspaceId, req.userId!))) {
      return res.status(404).json({ error: "Workspace not found" });
    }
    if (workspaceId === scene.workspace_id) {
      return res.status(400).json({ error: "The scene is already in this workspace" });
    }
    if (collectionId !== undefined) {
      const collection = isUuid(collectionId) ? await findCollection(collectionId, req.userId!) : null;
      if (!collection || collection.workspace_id !== workspaceId) {
        return res.status(404).json({ error: "Collection not found" });
      }
    }

    const moved = await withTransaction(async (client) => {
      const target = collectionId ?? (await ensurePersonalCollection(client, workspaceId, req.userId!));
      const { rows: [row] } = await client.query(
        `UPDATE scenes
         SET workspace_id = $2, collection_id = $3, owner_id = $4, updated_by = $4, updated_at = NOW()
         WHERE id = $1
         RETURNING id, title, workspace_id, collection_id`,
        [req.params.id, workspaceId, target, req.userId]
      );
      // "Recently visited" entries of people outside the new workspace are meaningless now
      await client.query(
        `DELETE FROM scene_visits v WHERE v.scene_id = $1 AND NOT EXISTS (
           SELECT 1 FROM workspace_members m WHERE m.workspace_id = $2 AND m.user_id = v.user_id)`,
        [req.params.id, workspaceId]
      );
      return row;
    });
    res.json({ scene: moved });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Duplicate scene ("Save as copy") into the same collection. Sharing and history are not copied.
router.post("/:id/duplicate", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Scene not found" });
    }
    const scene = await withTransaction(async (client) => {
      const { rows: [copy] } = await client.query(
        `INSERT INTO scenes (id, owner_id, updated_by, workspace_id, collection_id, title, elements, app_state)
         SELECT $1, $3, $3, workspace_id, collection_id, LEFT(title || ' (copy)', 255), elements, app_state
         FROM scenes WHERE id = $2
         RETURNING id, title, version, is_shared, workspace_id, collection_id, created_at, updated_at`,
        [uuidv4(), req.params.id, req.userId]
      );
      // Reuse the thumbnail only if it's current, re-pointed at the copy's version
      await client.query(
        `INSERT INTO scene_thumbnails (scene_id, data, mime_type, scene_version)
         SELECT $1, t.data, t.mime_type, $3
         FROM scene_thumbnails t JOIN scenes s ON s.id = t.scene_id
         WHERE t.scene_id = $2 AND t.scene_version = s.version`,
        [copy.id, req.params.id, copy.version]
      );
      return copy;
    });
    res.status(201).json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Thumbnail image for the dashboard (also for scenes in the trash)
router.get("/:id/thumbnail", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!, { includeDeleted: true }))) {
      return res.status(404).json({ error: "Thumbnail not found" });
    }
    const thumbnail = await queryOne(
      "SELECT data, mime_type FROM scene_thumbnails WHERE scene_id = $1",
      [req.params.id]
    );
    if (!thumbnail) {
      return res.status(404).json({ error: "Thumbnail not found" });
    }
    res.setHeader("Content-Type", thumbnail.mime_type);
    res.setHeader("Cache-Control", "private, no-cache");
    res.send(thumbnail.data);
  } catch (err: any) {
    serverError(res, err);
  }
});

// Store a client-rendered thumbnail. `version` is the scene version it was rendered from.
router.put("/:id/thumbnail", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { image, version } = req.body;
    const match = typeof image === "string" && THUMBNAIL_DATA_URL_RE.exec(image);
    if (!match || !Number.isInteger(version)) {
      return res.status(400).json({ error: "image (png/webp/jpeg data URL) and version are required" });
    }
    const data = Buffer.from(match[2], "base64");
    if (data.length > MAX_THUMBNAIL_BYTES) {
      return res.status(413).json({ error: "Thumbnail too large" });
    }

    const scene = await findScene(req.params.id as string, req.userId!, { includeDeleted: true });
    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }

    // Never replace a thumbnail with one rendered from older content
    const thumbnail = await queryOne(
      `INSERT INTO scene_thumbnails (scene_id, data, mime_type, scene_version, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (scene_id) DO UPDATE
         SET data = EXCLUDED.data, mime_type = EXCLUDED.mime_type,
             scene_version = EXCLUDED.scene_version, updated_at = NOW()
         WHERE scene_thumbnails.scene_version <= EXCLUDED.scene_version
       RETURNING scene_version`,
      [req.params.id, data, match[1], Math.min(version, scene.version)]
    );
    res.json({ thumbnailVersion: thumbnail?.scene_version ?? null });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Move scene to the trash
router.delete("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Scene not found" });
    }
    await query(
      "UPDATE scenes SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1",
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Restore scene from the trash (into the restorer's Private collection if its collection is gone)
router.post("/:id/untrash", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const scene = await findScene(req.params.id as string, req.userId!, { includeDeleted: true });
    if (!scene?.deleted_at) {
      return res.status(404).json({ error: "Scene not found in trash" });
    }
    await withTransaction(async (client) => {
      const collectionId =
        scene.collection_id ?? (await ensurePersonalCollection(client, scene.workspace_id, req.userId!));
      await client.query(
        "UPDATE scenes SET deleted_at = NULL, deleted_by = NULL, collection_id = $2 WHERE id = $1",
        [req.params.id, collectionId]
      );
    });
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Delete forever: only trashed scenes, only by their owner or a workspace admin
router.delete("/:id/permanent", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const scene = await findScene(req.params.id as string, req.userId!, { includeDeleted: true });
    if (!scene?.deleted_at) {
      return res.status(404).json({ error: "Scene not found in trash" });
    }
    if (scene.owner_id !== req.userId && scene.role !== "admin") {
      return res.status(403).json({ error: "Only the owner or a workspace admin can delete this permanently" });
    }
    await query("DELETE FROM scenes WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Get version history
router.get("/:id/versions", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Scene not found" });
    }
    const versions = await query(
      `SELECT sv.id, sv.version, sv.created_at, u.name as created_by_name
       FROM scene_versions sv
       LEFT JOIN users u ON sv.created_by = u.id
       WHERE sv.scene_id = $1
       ORDER BY sv.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json({ versions });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Get specific version
router.get("/:id/versions/:version", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const versionNumber = parseVersion(req.params.version as string);
    if (!versionNumber || !(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Version not found" });
    }
    const version = await queryOne(
      `SELECT * FROM scene_versions
       WHERE scene_id = $1 AND version = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.params.id, versionNumber]
    );
    if (!version) {
      return res.status(404).json({ error: "Version not found" });
    }
    res.json({ version });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Restore version
router.post("/:id/restore/:version", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const versionNumber = parseVersion(req.params.version as string);
    if (!versionNumber) {
      return res.status(404).json({ error: "Version not found" });
    }

    const scene = await withTransaction(async (client) => {
      const current = await findScene(req.params.id as string, req.userId!, { client, forUpdate: true });
      if (!current) {
        return null;
      }

      const { rows: [target] } = await client.query(
        `SELECT id FROM scene_versions
         WHERE scene_id = $1 AND version = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [req.params.id, versionNumber]
      );
      if (!target) {
        return null;
      }

      // Always keep the pre-restore state so a restore can be undone
      await client.query(
        `INSERT INTO scene_versions (scene_id, version, elements, app_state, created_by)
         SELECT id, version, elements, app_state, $2 FROM scenes WHERE id = $1`,
        [req.params.id, req.userId]
      );

      // Copy in SQL: passing JSONB arrays back as params would serialize them as PG arrays
      const { rows: [updated] } = await client.query(
        `UPDATE scenes s
         SET elements = sv.elements, app_state = sv.app_state, version = s.version + 1,
             updated_at = NOW(), updated_by = $3
         FROM scene_versions sv
         WHERE s.id = $1 AND sv.id = $2
         RETURNING s.id, s.title, s.elements, s.app_state, s.version, s.updated_at`,
        [req.params.id, target.id, req.userId]
      );
      return updated;
    });

    if (!scene) {
      return res.status(404).json({ error: "Scene or version not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Enable read-only link sharing. Reuses the existing token so links already sent keep working.
router.post("/:id/share", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Scene not found" });
    }
    const scene = await queryOne(
      `UPDATE scenes SET is_shared = TRUE, share_token = COALESCE(share_token, $1)
       WHERE id = $2
       RETURNING id, share_token, is_shared`,
      [uuidv4().replace(/-/g, ""), req.params.id]
    );
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Revoke link sharing. The old token is dropped, so re-sharing creates a new link.
router.delete("/:id/share", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await findScene(req.params.id as string, req.userId!))) {
      return res.status(404).json({ error: "Scene not found" });
    }
    const scene = await queryOne(
      `UPDATE scenes SET is_shared = FALSE, share_token = NULL
       WHERE id = $1
       RETURNING id, share_token, is_shared`,
      [req.params.id]
    );
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Get shared scene (public, no auth)
router.get("/shared/:token", async (req, res) => {
  try {
    const scene = await queryOne(
      `SELECT id, title, elements, app_state, version, created_at, updated_at
       FROM scenes s
       WHERE s.share_token = $1 AND s.is_shared = TRUE AND s.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id AND w.deleted_at IS NULL)`,
      [req.params.token]
    );
    if (!scene) {
      return res.status(404).json({ error: "Shared scene not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
