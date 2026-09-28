import { Request, Response, NextFunction } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Log the real error server-side, never leak DB/internal details to clients
export function serverError(res: Response, err: unknown) {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

// For router.param(): malformed ids would otherwise surface as Postgres errors (500)
export function requireUuidParam(_req: Request, res: Response, next: NextFunction, value: string) {
  if (!isUuid(value)) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}
