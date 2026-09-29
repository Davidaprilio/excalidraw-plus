import { Router } from "express";
import { query, queryOne } from "../db";
import { isUuid, serverError } from "../utils/http";

/**
 * Public (no login) read-only access to a collection shared by link:
 * its scene list, each scene and their thumbnails.
 */
const router = Router();

// A shared collection of a live workspace
const findSharedCollection = (token: string) =>
  queryOne<{ id: string; name: string; workspace_name: string; allow_save: boolean }>(
    `SELECT c.id, c.name, w.name as workspace_name, c.share_allow_save as allow_save
     FROM collections c JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
     WHERE c.share_token = $1`,
    [token]
  );

router.get("/:token", async (req, res) => {
  try {
    const collection = await findSharedCollection(req.params.token);
    if (!collection) {
      return res.status(404).json({ error: "Shared collection not found" });
    }
    const scenes = await query(
      `SELECT s.id, s.title, s.updated_at, (t.scene_id IS NOT NULL) as has_thumbnail
       FROM scenes s LEFT JOIN scene_thumbnails t ON t.scene_id = s.id
       WHERE s.collection_id = $1 AND s.deleted_at IS NULL
       ORDER BY s.updated_at DESC`,
      [collection.id]
    );
    res.json({
      collection: {
        name: collection.name,
        workspace_name: collection.workspace_name,
        allow_save: collection.allow_save,
      },
      scenes,
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

/** A scene of the shared collection (only scenes currently in it) */
const findSharedScene = async (token: string, sceneId: string) => {
  if (!isUuid(sceneId)) return null;
  const collection = await findSharedCollection(token);
  if (!collection) return null;
  const scene = await queryOne<any>(
    `SELECT id, title, elements, app_state, updated_at FROM scenes
     WHERE id = $1 AND collection_id = $2 AND deleted_at IS NULL`,
    [sceneId, collection.id]
  );
  return scene && { ...scene, allow_save: collection.allow_save };
};

router.get("/:token/scenes/:sceneId", async (req, res) => {
  try {
    const scene = await findSharedScene(req.params.token, req.params.sceneId);
    if (!scene) {
      return res.status(404).json({ error: "Shared scene not found" });
    }
    res.json({ scene });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.get("/:token/scenes/:sceneId/thumbnail", async (req, res) => {
  try {
    const scene = await findSharedScene(req.params.token, req.params.sceneId);
    const thumbnail =
      scene &&
      (await queryOne("SELECT data, mime_type FROM scene_thumbnails WHERE scene_id = $1", [scene.id]));
    if (!thumbnail) {
      return res.status(404).json({ error: "Thumbnail not found" });
    }
    res.setHeader("Content-Type", thumbnail.mime_type);
    res.setHeader("Cache-Control", "no-cache");
    res.send(thumbnail.data);
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
