import { Router } from "express";
import { query, queryOne } from "../db";
import { levelToRole } from "../access";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireUuidParam, serverError } from "../utils/http";

/**
 * Collections across workspaces: the ones shared with me from workspaces I'm not
 * in, and any collection I can access by id (its workspace included).
 */
const router = Router();
router.use(authMiddleware);
router.param("cid", requireUuidParam);

const COLUMNS = `c.id, c.name, c.visibility, c.workspace_role, c.is_personal, c.owner_id, u.name as owner_name,
  c.created_at, c.share_token, c.share_allow_save, c.workspace_id,
  w.name as workspace_name,
  (extract(epoch from w.avatar_updated_at) * 1000)::bigint as workspace_avatar_version,
  (SELECT COUNT(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) as workspace_member_count,
  collection_access_level(c.id, $1) as access_level,
  (SELECT COUNT(*)::int FROM scenes s WHERE s.collection_id = c.id AND s.deleted_at IS NULL) as scene_count,
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = c.workspace_id AND wm.user_id = $1) as in_workspace`;

const shape = ({ access_level, ...c }: any) => ({ ...c, my_role: levelToRole(access_level) });

router.get("/shared-with-me", async (req: AuthRequest, res) => {
  try {
    const rows = await query(
      `SELECT * FROM (
         SELECT ${COLUMNS}
         FROM collections c
         JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
         LEFT JOIN users u ON u.id = c.owner_id
         WHERE c.visibility = 'workspace' AND (
           EXISTS (SELECT 1 FROM collection_members cm WHERE cm.collection_id = c.id AND cm.user_id = $1)
           OR EXISTS (SELECT 1 FROM collection_teams ct
                      JOIN workspace_members tm ON tm.workspace_id = ct.workspace_id AND tm.user_id = $1
                      WHERE ct.collection_id = c.id)
         )
       ) x
       WHERE access_level > 0 AND NOT in_workspace
       ORDER BY LOWER(workspace_name), LOWER(name)`,
      [req.userId]
    );
    // scenes shared with me one by one, from workspaces I'm not in
    const scenes = await query(
      `SELECT * FROM (
         SELECT s.id, s.title, s.version, s.is_shared, s.share_token, s.created_at, s.updated_at,
                s.owner_id, u.name as owner_name, ub.name as updated_by_name,
                s.collection_id, c.name as collection_name, s.workspace_id, w.name as workspace_name,
                NULL::timestamptz as deleted_at, NULL as deleted_by_name, v.visited_at,
                (pin.scene_id IS NOT NULL) as pinned, t.scene_version as thumbnail_version,
                EXISTS (SELECT 1 FROM jsonb_array_elements(s.elements) e
                        WHERE NOT COALESCE((e->>'isDeleted')::boolean, false)) as has_content,
                FALSE as can_delete_permanently,
                scene_access_level(s.id, $1) as access_level,
                COALESCE(c.visibility = 'private' AND NOT c.is_personal, FALSE) as share_blocked
         FROM scene_members sm
         JOIN scenes s ON s.id = sm.scene_id AND s.deleted_at IS NULL
         JOIN workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
         LEFT JOIN collections c ON c.id = s.collection_id
         LEFT JOIN users u ON u.id = s.owner_id
         LEFT JOIN users ub ON ub.id = s.updated_by
         LEFT JOIN scene_thumbnails t ON t.scene_id = s.id
         LEFT JOIN scene_visits v ON v.scene_id = s.id AND v.user_id = $1
         LEFT JOIN scene_pins pin ON pin.scene_id = s.id AND pin.user_id = $1
         WHERE sm.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = s.workspace_id AND m.user_id = $1)
       ) x
       WHERE access_level > 0
       ORDER BY updated_at DESC`,
      [req.userId]
    );
    res.json({ collections: rows.map(shape), scenes });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.get("/:cid", async (req: AuthRequest, res) => {
  try {
    const row = await queryOne(
      `SELECT ${COLUMNS}
       FROM collections c
       JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
       LEFT JOIN users u ON u.id = c.owner_id
       WHERE c.id = $2`,
      [req.userId, req.params.cid]
    );
    if (!row || row.access_level < 1) {
      return res.status(404).json({ error: "Collection not found" });
    }
    res.json({ collection: shape(row) });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
