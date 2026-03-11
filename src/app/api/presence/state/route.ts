import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSessionUser } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

type Role = "owner" | "moderator" | "user";

export async function GET() {
  try {
    await ensureSchema();
    const me = await requireSessionUser();

    const pool = getPool();
    const [channelRows] = await pool.execute(
      "SELECT id, name FROM channels ORDER BY name ASC",
    );
    const channels = (channelRows as unknown as Array<{ id: number; name: string }>).map((c) => ({
      id: Number(c.id),
      name: String(c.name),
    }));

    const [userRows] = await pool.execute(
      "SELECT id, username, role, current_channel_id AS currentChannelId FROM utenti_radio WHERE last_seen IS NOT NULL AND last_seen > DATE_SUB(NOW(), INTERVAL 20 SECOND) ORDER BY username ASC",
    );
    const users = (userRows as unknown as Array<{
      id: number;
      username: string;
      role: string;
      currentChannelId: number | null;
    }>).map((u) => ({
      id: Number(u.id),
      username: String(u.username),
      role: u.role as Role,
      currentChannelId: u.currentChannelId === null ? null : Number(u.currentChannelId),
    }));

    const [meRow] = await pool.execute(
      "SELECT current_channel_id AS currentChannelId, role FROM utenti_radio WHERE id = :id LIMIT 1",
      { id: me.id },
    );
    const meDb = (meRow as unknown as Array<{ currentChannelId: number | null; role: string }>)[0];

    return NextResponse.json({
      me: {
        id: me.id,
        username: me.username,
        role: (meDb?.role as Role) ?? me.role,
        currentChannelId:
          meDb?.currentChannelId === null || meDb?.currentChannelId === undefined
            ? null
            : Number(meDb.currentChannelId),
      },
      channels,
      users,
      serverTime: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERROR";
    const status = message === "UNAUTHORIZED" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

