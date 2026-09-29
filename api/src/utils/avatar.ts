const AVATAR_DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_AVATAR_BYTES = 256 * 1024;

/** Cache-busting version of an avatar (users / workspaces), as `avatar_version` */
export const avatarVersionSql = (alias?: string) =>
  `(extract(epoch from ${alias ? `${alias}.` : ""}avatar_updated_at) * 1000)::bigint as avatar_version`;

/**
 * Validate an uploaded avatar: a png/jpeg/webp data URL (already cropped and
 * resized by the client) of at most 256 KB.
 */
export function parseAvatarDataUrl(
  image: unknown
): { data: Buffer; mime: string } | { status: number; error: string } {
  const match = typeof image === "string" && AVATAR_DATA_URL_RE.exec(image);
  if (!match) {
    return { status: 400, error: "image must be a png/jpeg/webp data URL" };
  }
  const data = Buffer.from(match[2], "base64");
  if (data.length > MAX_AVATAR_BYTES) {
    return { status: 413, error: "Photo too large" };
  }
  return { data, mime: match[1] };
}
