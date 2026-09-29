import { Router, Response } from "express";
import { query, queryOne, withTransaction } from "../db";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { isUuid, serverError } from "../utils/http";
import { findScene, AccessibleScene } from "../access";

// Comment threads pinned on a scene. Mounted at /api/scenes/:sceneId/comments.
// Anyone who can open the scene can comment; edits are the author's; deleting
// is for the author, the scene owner or a workspace admin.
const router = Router({ mergeParams: true });

router.use(authMiddleware);

const MAX_BODY = 5000;

type SceneRequest = AuthRequest & { scene?: AccessibleScene };

router.use(async (req: SceneRequest, res, next) => {
  try {
    const sceneId = req.params.sceneId;
    const scene = isUuid(sceneId) ? await findScene(sceneId, req.userId!) : null;
    if (!scene) {
      return res.status(404).json({ error: "Scene not found" });
    }
    req.scene = scene;
    next();
  } catch (err: any) {
    serverError(res, err);
  }
});

for (const param of ["threadId", "commentId"]) {
  router.param(param, (_req, res, next, value) =>
    isUuid(value) ? next() : res.status(404).json({ error: "Comment not found" })
  );
}

const parseBody = (body: unknown) =>
  typeof body === "string" && body.trim() && body.length <= MAX_BODY ? body.trim() : null;

const isCoordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const canModerate = (req: SceneRequest) => req.scene!.owner_id === req.userId || req.scene!.role === "admin";

const THREADS_SQL = `
  SELECT t.id, t.x, t.y, t.created_by, t.created_at, t.updated_at, t.resolved_at,
         ru.name as resolved_by_name,
         COALESCE(json_agg(json_build_object(
           'id', c.id,
           'body', c.body,
           'author_id', c.author_id,
           'author_name', u.name,
           'author_avatar_version', (extract(epoch from u.avatar_updated_at) * 1000)::bigint::text,
           'created_at', c.created_at,
           'edited_at', c.edited_at,
           'reactions', COALESCE((
             SELECT json_agg(json_build_object('emoji', r.emoji, 'count', r.count, 'mine', r.mine)
                             ORDER BY r.first_at)
             FROM (SELECT emoji, COUNT(*)::int as count, bool_or(user_id = $3) as mine,
                          MIN(created_at) as first_at
                   FROM comment_reactions WHERE comment_id = c.id GROUP BY emoji) r
           ), '[]')
         ) ORDER BY c.created_at) FILTER (WHERE c.id IS NOT NULL), '[]') as comments
  FROM comment_threads t
  LEFT JOIN comments c ON c.thread_id = t.id
  LEFT JOIN users u ON u.id = c.author_id
  LEFT JOIN users ru ON ru.id = t.resolved_by
  WHERE t.scene_id = $1 AND ($2::uuid IS NULL OR t.id = $2)
  GROUP BY t.id, ru.name
  ORDER BY t.created_at`;

const loadThread = (sceneId: string, threadId: string, userId: string) =>
  queryOne(THREADS_SQL, [sceneId, threadId, userId]);

const findThread = async (req: SceneRequest, res: Response) => {
  const thread = await queryOne("SELECT id, created_by FROM comment_threads WHERE id = $1 AND scene_id = $2", [
    req.params.threadId,
    req.params.sceneId,
  ]);
  if (!thread) {
    res.status(404).json({ error: "Comment not found" });
  }
  return thread;
};

router.get("/", async (req: SceneRequest, res) => {
  try {
    res.json({ threads: await query(THREADS_SQL, [req.params.sceneId, null, req.userId]) });
  } catch (err: any) {
    serverError(res, err);
  }
});

// New thread: { body, x, y }
router.post("/", async (req: SceneRequest, res) => {
  try {
    const body = parseBody(req.body.body);
    const { x, y } = req.body;
    if (!body || !isCoordinate(x) || !isCoordinate(y)) {
      return res.status(400).json({ error: `A comment (up to ${MAX_BODY} characters) and a position are required` });
    }
    const threadId = await withTransaction(async (client) => {
      const { rows: [thread] } = await client.query(
        "INSERT INTO comment_threads (scene_id, created_by, x, y) VALUES ($1, $2, $3, $4) RETURNING id",
        [req.params.sceneId, req.userId, x, y]
      );
      await client.query("INSERT INTO comments (thread_id, author_id, body) VALUES ($1, $2, $3)", [
        thread.id,
        req.userId,
        body,
      ]);
      return thread.id;
    });
    res.status(201).json({ thread: await loadThread(req.params.sceneId as string, threadId, req.userId!) });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Resolve / reopen, or move the pin: { resolved?, x?, y? }
router.patch("/:threadId", async (req: SceneRequest, res) => {
  try {
    if (!(await findThread(req, res))) return;
    const { resolved, x, y } = req.body;
    if ((x !== undefined || y !== undefined) && !(isCoordinate(x) && isCoordinate(y))) {
      return res.status(400).json({ error: "x and y must be numbers" });
    }
    await query(
      `UPDATE comment_threads SET
         resolved_at = CASE WHEN $2::boolean IS NULL THEN resolved_at WHEN $2 THEN NOW() ELSE NULL END,
         resolved_by = CASE WHEN $2::boolean IS NULL THEN resolved_by WHEN $2 THEN $3::uuid ELSE NULL END,
         x = COALESCE($4, x), y = COALESCE($5, y), updated_at = NOW()
       WHERE id = $1`,
      [req.params.threadId, typeof resolved === "boolean" ? resolved : null, req.userId, x ?? null, y ?? null]
    );
    res.json({ thread: await loadThread(req.params.sceneId as string, req.params.threadId as string, req.userId!) });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.delete("/:threadId", async (req: SceneRequest, res) => {
  try {
    const thread = await findThread(req, res);
    if (!thread) return;
    if (thread.created_by !== req.userId && !canModerate(req)) {
      return res.status(403).json({ error: "Only its author, the scene owner or an admin can delete this thread" });
    }
    await query("DELETE FROM comment_threads WHERE id = $1", [req.params.threadId]);
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/:threadId/replies", async (req: SceneRequest, res) => {
  try {
    if (!(await findThread(req, res))) return;
    const body = parseBody(req.body.body);
    if (!body) {
      return res.status(400).json({ error: `A reply (up to ${MAX_BODY} characters) is required` });
    }
    await withTransaction(async (client) => {
      await client.query("INSERT INTO comments (thread_id, author_id, body) VALUES ($1, $2, $3)", [
        req.params.threadId,
        req.userId,
        body,
      ]);
      await client.query("UPDATE comment_threads SET updated_at = NOW() WHERE id = $1", [req.params.threadId]);
    });
    res.status(201).json({ thread: await loadThread(req.params.sceneId as string, req.params.threadId as string, req.userId!) });
  } catch (err: any) {
    serverError(res, err);
  }
});

const findComment = async (req: SceneRequest, res: Response) => {
  const comment = await queryOne(
    `SELECT c.id, c.author_id FROM comments c
     JOIN comment_threads t ON t.id = c.thread_id AND t.scene_id = $3
     WHERE c.id = $1 AND c.thread_id = $2`,
    [req.params.commentId, req.params.threadId, req.params.sceneId]
  );
  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
  }
  return comment;
};

router.patch("/:threadId/replies/:commentId", async (req: SceneRequest, res) => {
  try {
    const comment = await findComment(req, res);
    if (!comment) return;
    if (comment.author_id !== req.userId) {
      return res.status(403).json({ error: "You can only edit your own comments" });
    }
    const body = parseBody(req.body.body);
    if (!body) {
      return res.status(400).json({ error: `A comment (up to ${MAX_BODY} characters) is required` });
    }
    await query("UPDATE comments SET body = $1, edited_at = NOW() WHERE id = $2", [body, req.params.commentId]);
    res.json({ thread: await loadThread(req.params.sceneId as string, req.params.threadId as string, req.userId!) });
  } catch (err: any) {
    serverError(res, err);
  }
});

const EMOJI_RE = /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\u200d\ufe0f\p{Emoji_Modifier}]*$/u;

// Toggle my reaction on a comment: { emoji }
router.post("/:threadId/replies/:commentId/reactions", async (req: SceneRequest, res) => {
  try {
    if (!(await findComment(req, res))) return;
    const emoji = typeof req.body.emoji === "string" ? req.body.emoji : "";
    if (!EMOJI_RE.test(emoji) || emoji.length > 16) {
      return res.status(400).json({ error: "emoji must be a single emoji" });
    }
    const removed = await queryOne(
      "DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND emoji = $3 RETURNING emoji",
      [req.params.commentId, req.userId, emoji]
    );
    if (!removed) {
      await query("INSERT INTO comment_reactions (comment_id, user_id, emoji) VALUES ($1, $2, $3)", [
        req.params.commentId,
        req.userId,
        emoji,
      ]);
    }
    res.json({ thread: await loadThread(req.params.sceneId as string, req.params.threadId as string, req.userId!) });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Deleting the last comment of a thread deletes the thread
router.delete("/:threadId/replies/:commentId", async (req: SceneRequest, res) => {
  try {
    const comment = await findComment(req, res);
    if (!comment) return;
    if (comment.author_id !== req.userId && !canModerate(req)) {
      return res.status(403).json({ error: "Only its author, the scene owner or an admin can delete this comment" });
    }
    const thread = await withTransaction(async (client) => {
      await client.query("DELETE FROM comments WHERE id = $1", [req.params.commentId]);
      const { rows: [left] } = await client.query("SELECT COUNT(*)::int as count FROM comments WHERE thread_id = $1", [
        req.params.threadId,
      ]);
      if (left.count === 0) {
        await client.query("DELETE FROM comment_threads WHERE id = $1", [req.params.threadId]);
        return null;
      }
      return req.params.threadId;
    });
    res.json({ thread: thread ? await loadThread(req.params.sceneId as string, thread as string, req.userId!) : null });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
