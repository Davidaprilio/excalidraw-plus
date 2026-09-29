import { query, queryOne } from "../db";
import { signAccessToken, signRefreshToken } from "../middleware/auth";

export const AVATAR_VERSION_SQL = "(extract(epoch from avatar_updated_at) * 1000)::bigint as avatar_version";

/** Issue an access + refresh token pair (a new signed-in session) and the user payload */
export async function issueSession(userId: string) {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);
  await query(
    "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
    [userId, refreshToken]
  );
  const user = await queryOne(`SELECT id, email, name, created_at, ${AVATAR_VERSION_SQL} FROM users WHERE id = $1`, [
    userId,
  ]);
  return { accessToken, refreshToken, user };
}

/** Marks a signed challenge/token as used; false if it already was (replay) */
export async function consumeChallenge(challenge: string): Promise<boolean> {
  const inserted = await queryOne(
    "INSERT INTO used_auth_challenges (challenge) VALUES ($1) ON CONFLICT DO NOTHING RETURNING challenge",
    [challenge]
  );
  // opportunistic cleanup: tokens expire after minutes, keep a day of history
  query("DELETE FROM used_auth_challenges WHERE used_at < NOW() - INTERVAL '1 day'").catch(() => {});
  return !!inserted;
}
