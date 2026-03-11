import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getPool } from "@/lib/db";

const COOKIE_NAME = "ra_session";

export type UserRole = "owner" | "moderator" | "user";

export type SessionUser = {
  id: number;
  username: string;
  nome: string | null;
  cognome: string | null;
  role: UserRole;
  currentChannelId: number | null;
};

type PasswordParts = {
  iterations: number;
  saltHex: string;
  hashHex: string;
};

function serializePassword(parts: PasswordParts): string {
  return `pbkdf2_sha256$${parts.iterations}$${parts.saltHex}$${parts.hashHex}`;
}

function parsePasswordHash(stored: string): PasswordParts | null {
  const [alg, iterRaw, saltHex, hashHex] = stored.split("$");
  if (alg !== "pbkdf2_sha256") return null;
  const iterations = Number(iterRaw);
  if (!Number.isFinite(iterations) || iterations < 1) return null;
  if (!saltHex || !hashHex) return null;
  return { iterations, saltHex, hashHex };
}

export function hashPassword(password: string): string {
  const iterations = 210000;
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return serializePassword({
    iterations,
    saltHex: salt.toString("hex"),
    hashHex: hash.toString("hex"),
  });
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = parsePasswordHash(stored);
  if (!parts) return false;

  const salt = Buffer.from(parts.saltHex, "hex");
  const hash = crypto.pbkdf2Sync(password, salt, parts.iterations, 32, "sha256");
  const expected = Buffer.from(parts.hashHex, "hex");
  if (expected.length !== hash.length) return false;
  return crypto.timingSafeEqual(expected, hash);
}

function secureCookie(): boolean {
  return process.env.NODE_ENV === "production";
}

export function roleFromRuoli(ruoli: string | null | undefined): UserRole {
  const v = String(ruoli ?? "").toLowerCase();
  if (!v) return "user";

  const owner = ["direttore ares 118", "vice direttore ares 118", "gestore sito web"];
  for (const r of owner) {
    if (v.includes(r)) return "owner";
  }

  const moderator = [
    "referente emergenza",
    "referente materiali",
    "referente operatori",
    "referente formazione",
  ];
  for (const r of moderator) {
    if (v.includes(r)) return "moderator";
  }

  return "user";
}

export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const pool = getPool();
  await pool.execute(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES (:id, :user_id, DATE_ADD(NOW(), INTERVAL 7 DAY))",
    { id: token, user_id: userId },
  );
  return token;
}

export async function deleteSession(token: string): Promise<void> {
  const pool = getPool();
  await pool.execute("DELETE FROM sessions WHERE id = :id", { id: token });
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(),
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(),
    path: "/",
    maxAge: 0,
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT u.id, u.username, u.nome, u.cognome, u.ruoli, u.current_channel_id AS currentChannelId, s.expires_at AS expiresAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = :id LIMIT 1",
    { id: token },
  );

  const row = (rows as unknown as Array<{
    id: number;
    username: string;
    nome: string | null;
    cognome: string | null;
    ruoli: string | null;
    currentChannelId: number | null;
    expiresAt: string | Date;
  }>)[0];
  if (!row) return null;

  const expiresAt = new Date(row.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    await deleteSession(token);
    await clearSessionCookie();
    return null;
  }

  return {
    id: Number(row.id),
    username: String(row.username),
    nome: row.nome === null ? null : String(row.nome),
    cognome: row.cognome === null ? null : String(row.cognome),
    role: roleFromRuoli(row.ruoli),
    currentChannelId: row.currentChannelId === null ? null : Number(row.currentChannelId),
  };
}

export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error("UNAUTHORIZED");
  }
  return user;
}

export function canManageUsers(role: UserRole): boolean {
  return role === "owner" || role === "moderator";
}

export function canCreatePrivilegedUsers(role: UserRole): boolean {
  return role === "owner";
}
