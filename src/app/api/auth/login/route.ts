import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { createSession, setSessionCookie, sha256Hex, verifyPassword } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) {
      return NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 400 });
    }

    const pool = getPool();
    const [rows] = await pool.execute(
      "SELECT id, password FROM users WHERE username = :username LIMIT 1",
      { username },
    );
    const row = (rows as unknown as Array<{ id: number; password: string }>)[0];
    if (!row) {
      return NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
    }

    const stored = String(row.password ?? "");
    const sha256Like = /^[a-f0-9]{64}$/i.test(stored);
    const ok = stored.includes("pbkdf2_sha256$")
      ? verifyPassword(password, stored)
      : sha256Like
        ? sha256Hex(password).toLowerCase() === stored.toLowerCase()
        : stored === password;
    if (!ok) {
      return NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
    }

    const userId = Number(row.id);
    await pool.execute("UPDATE users SET last_seen = NOW() WHERE id = :id", { id: userId });

    const session = await createSession(userId);
    await setSessionCookie(session);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ERROR" },
      { status: 500 },
    );
  }
}
