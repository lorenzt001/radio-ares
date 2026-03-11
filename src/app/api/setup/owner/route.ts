import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { hashPassword, createSession, setSessionCookie } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (username.length < 3 || password.length < 8) {
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    }

    const pool = getPool();
    const [rows] = await pool.execute("SELECT COUNT(*) AS c FROM utenti_radio");
    const count = Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);
    if (count > 0) {
      return NextResponse.json({ error: "ALREADY_SETUP" }, { status: 409 });
    }

    const passwordHash = hashPassword(password);
    const [result] = await pool.execute(
      "INSERT INTO utenti_radio (username, password_hash, role, last_seen) VALUES (:username, :password_hash, 'owner', NOW())",
      { username, password_hash: passwordHash },
    );

    const userId = Number((result as unknown as { insertId: number }).insertId);
    await pool.execute(
      "INSERT IGNORE INTO channels (name, created_by) VALUES ('Generale', :created_by)",
      { created_by: userId },
    );

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
