import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const user = await requireSessionUser();
    const body = await req.json().catch(() => null);

    const channelId = Number(body?.channelId);
    const kind = typeof body?.kind === "string" ? body.kind : "";
    const toUserIdRaw = body?.toUserId;
    const toUserId =
      toUserIdRaw === null || toUserIdRaw === undefined ? null : Number(toUserIdRaw);
    const payload = body?.payload;

    if (!Number.isFinite(channelId) || channelId <= 0) {
      return NextResponse.json({ error: "INVALID_CHANNEL" }, { status: 400 });
    }
    if (!kind || kind.length > 16) {
      return NextResponse.json({ error: "INVALID_KIND" }, { status: 400 });
    }
    if (toUserId !== null && (!Number.isFinite(toUserId) || toUserId <= 0)) {
      return NextResponse.json({ error: "INVALID_TO" }, { status: 400 });
    }

    const payloadStr = JSON.stringify(payload ?? null);
    const pool = getPool();
    await pool.execute(
      "INSERT INTO signals (channel_id, from_user_id, to_user_id, kind, payload) VALUES (:channel_id, :from_user_id, :to_user_id, :kind, :payload)",
      {
        channel_id: channelId,
        from_user_id: user.id,
        to_user_id: toUserId,
        kind,
        payload: payloadStr,
      },
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    const status = message === "UNAUTHORIZED" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

