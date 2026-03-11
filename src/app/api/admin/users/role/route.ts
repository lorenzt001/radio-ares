import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { canCreatePrivilegedUsers, requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await requireSessionUser();
    if (!canCreatePrivilegedUsers(me.role)) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const userId = Number(body?.userId);
    const role = body?.role;
    if (!Number.isFinite(userId) || userId <= 0) {
      return NextResponse.json({ error: "INVALID_USER" }, { status: 400 });
    }
    if (role !== "moderator" && role !== "user") {
      return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });
    }

    const pool = getPool();
    await pool.execute("UPDATE users SET role = :role WHERE id = :id", {
      role,
      id: userId,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

