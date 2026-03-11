import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";
import { canManageUsers } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const user = await requireSessionUser();
    if (!canManageUsers(user.role)) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 64) {
      return NextResponse.json({ error: "INVALID_NAME" }, { status: 400 });
    }

    const pool = getPool();
    await pool.execute("INSERT INTO channels (name, created_by) VALUES (:name, :uid)", {
      name,
      uid: user.id,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

