import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const user = await requireSessionUser();
    const body = await req.json().catch(() => null);
    const channelIdRaw = body?.channelId;
    const channelId =
      channelIdRaw === null || channelIdRaw === undefined ? null : Number(channelIdRaw);
    if (channelId !== null && !Number.isFinite(channelId)) {
      return NextResponse.json({ error: "INVALID_CHANNEL" }, { status: 400 });
    }

    const pool = getPool();
    await pool.execute(
      "UPDATE users SET last_seen = NOW(), current_channel_id = :channel_id WHERE id = :id",
      { id: user.id, channel_id: channelId },
    );

    const [rows] = await pool.execute(
      "SELECT current_channel_id AS currentChannelId FROM users WHERE id = :id LIMIT 1",
      { id: user.id },
    );
    const currentChannelId =
      (rows as unknown as Array<{ currentChannelId: number | null }>)[0]?.currentChannelId ??
      null;

    return NextResponse.json({ ok: true, currentChannelId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    const status = message === "UNAUTHORIZED" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
