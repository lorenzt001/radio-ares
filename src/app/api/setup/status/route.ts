import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { ensureSchema } from "@/lib/migrate";

export async function GET() {
  try {
    await ensureSchema();
    const pool = getPool();
    const [rows] = await pool.execute("SELECT COUNT(*) AS c FROM utenti_radio");
    const count = Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);
    return NextResponse.json({ ready: true, hasUsers: count > 0 });
  } catch (err) {
    return NextResponse.json(
      { ready: false, error: err instanceof Error ? err.message : "ERROR" },
      { status: 500 },
    );
  }
}
