import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { canCreatePrivilegedUsers, hashPassword, requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await requireSessionUser();
    if (!canCreatePrivilegedUsers(me.role)) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const role =
      body?.role === "moderator" || body?.role === "user" ? (body.role as string) : "user";

    if (username.length < 3 || username.length > 64 || password.length < 8) {
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    }

    const passwordHash = hashPassword(password);
    const pool = getPool();
    const ruoli = role === "moderator" ? "Referente Operatori" : null;
    await pool.execute("INSERT INTO users (username, password, ruoli, last_seen) VALUES (:u, :p, :r, NOW())", {
      u: username,
      p: passwordHash,
      r: ruoli,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

