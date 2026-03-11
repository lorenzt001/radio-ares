import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSessionUser, roleFromRuoli } from "@/lib/auth";
import { ensureSchema } from "@/lib/migrate";

type Role = "owner" | "moderator" | "user";

export async function GET() {
  try {
    await ensureSchema();
    const me = await requireSessionUser();

    const pool = getPool();
    const [channelRows] = await pool.execute(
      "SELECT id, name FROM channels ORDER BY id ASC",
    );
    const channels = (channelRows as unknown as Array<{ id: number; name: string }>).map((c) => ({
      id: Number(c.id),
      name: String(c.name),
    }));

    const [userRows] = await pool.execute(
      "SELECT id, nome, cognome, ruoli, current_channel_id AS currentChannelId FROM users WHERE last_seen IS NOT NULL AND last_seen > DATE_SUB(NOW(), INTERVAL 20 SECOND) ORDER BY cognome ASC, nome ASC, id ASC",
    );
    const users = (userRows as unknown as Array<{
      id: number;
      nome: string | null;
      cognome: string | null;
      ruoli: string | null;
      currentChannelId: number | null;
    }>).map((u) => ({
      id: Number(u.id),
      nome: u.nome === null ? null : String(u.nome),
      cognome: u.cognome === null ? null : String(u.cognome),
      role: roleFromRuoli(u.ruoli) as Role,
      currentChannelId: u.currentChannelId === null ? null : Number(u.currentChannelId),
    }));

    const [meRow] = await pool.execute(
      "SELECT current_channel_id AS currentChannelId, ruoli, nome, cognome FROM users WHERE id = :id LIMIT 1",
      { id: me.id },
    );
    const meDb = (meRow as unknown as Array<{
      currentChannelId: number | null;
      ruoli: string | null;
      nome: string | null;
      cognome: string | null;
    }>)[0];

    return NextResponse.json({
      me: {
        id: me.id,
        nome: meDb?.nome === null || meDb?.nome === undefined ? me.nome : String(meDb.nome),
        cognome:
          meDb?.cognome === null || meDb?.cognome === undefined ? me.cognome : String(meDb.cognome),
        role: (roleFromRuoli(meDb?.ruoli) as Role) ?? me.role,
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

