import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

export async function GET(req: Request) {
  try {
    await ensureSchema();
    const user = await requireSessionUser();
    const url = new URL(req.url);
    const channelId = Number(url.searchParams.get("channelId"));
    const afterId = Number(url.searchParams.get("afterId") ?? "0");

    if (!Number.isFinite(channelId) || channelId <= 0) {
      return NextResponse.json({ error: "INVALID_CHANNEL" }, { status: 400 });
    }

    const pool = getPool();
    await pool.execute(
      "DELETE FROM signals WHERE created_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)",
    );

    const [rows] = await pool.execute(
      "SELECT id, from_user_id AS fromUserId, to_user_id AS toUserId, kind, payload, created_at AS createdAt FROM signals WHERE channel_id = :channel_id AND id > :after_id AND (to_user_id IS NULL OR to_user_id = :me) ORDER BY id ASC LIMIT 200",
      { channel_id: channelId, after_id: afterId, me: user.id },
    );

    const signals = (rows as unknown as Array<{
      id: number;
      fromUserId: number;
      toUserId: number | null;
      kind: string;
      payload: string;
      createdAt: string | Date;
    }>).map((r) => ({
      id: Number(r.id),
      fromUserId: Number(r.fromUserId),
      toUserId: r.toUserId === null ? null : Number(r.toUserId),
      kind: String(r.kind),
      payload: JSON.parse(String(r.payload)),
      createdAt: new Date(r.createdAt).toISOString(),
    }));

    return NextResponse.json({ signals });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    const status = message === "UNAUTHORIZED" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
