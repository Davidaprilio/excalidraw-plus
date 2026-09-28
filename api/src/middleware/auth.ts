import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set");
}
if (JWT_SECRET.startsWith("change-")) {
  console.warn("WARNING: JWT_SECRET is still a placeholder value, set a random secret in production");
}

export interface AuthRequest extends Request {
  userId?: string;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ userId, type: "access" }, JWT_SECRET, { expiresIn: "1d" });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId, type: "refresh" }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyRefreshToken(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; type: string };
    if (payload.type !== "refresh") return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { userId: string; type: string };
    if (payload.type !== "access") {
      return res.status(401).json({ error: "Invalid token type" });
    }
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
