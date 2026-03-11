import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { canManageUsers, requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await requireSessionUser();
    if (!canManageUsers(me.role)) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const userId = Number(body?.userId);
    const channelIdRaw = body?.channelId;
    const channelId =
      channelIdRaw === null || channelIdRaw === undefined ? null : Number(channelIdRaw);

    if (!Number.isFinite(userId) || userId <= 0) {
      return NextResponse.json({ error: "INVALID_USER" }, { status: 400 });
    }
    if (channelId !== null && (!Number.isFinite(channelId) || channelId <= 0)) {
      return NextResponse.json({ error: "INVALID_CHANNEL" }, { status: 400 });
    }

    const pool = getPool();
    await pool.execute(
      "UPDATE users SET current_channel_id = :channel_id WHERE id = :id",
      { id: userId, channel_id: channelId },
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    const status = message === "UNAUTHORIZED" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
