import { getPool } from "@/lib/db";

type SchemaRow = { db: string | null };

function isSafeIdentifier(v: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(v);
}

export async function ensureSchema(): Promise<void> {
  const pool = getPool();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS channels (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(64) NOT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_channels_name (name),
      KEY idx_channels_created_by (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id CHAR(64) NOT NULL,
      user_id INT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sessions_user_id (user_id),
      KEY idx_sessions_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS signals (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      channel_id BIGINT UNSIGNED NOT NULL,
      from_user_id INT NOT NULL,
      to_user_id INT NULL,
      kind VARCHAR(16) NOT NULL,
      payload LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_signals_channel_id (channel_id),
      KEY idx_signals_to_user_id (to_user_id),
      KEY idx_signals_created_at (created_at),
      CONSTRAINT fk_signals_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const [dbRows] = await pool.query("SELECT DATABASE() AS db");
  const dbName = (dbRows as unknown as SchemaRow[])[0]?.db ?? null;
  if (!dbName) return;

  async function dropUtentiRadioForeignKeys(table: "sessions" | "channels" | "signals") {
    const [rows] = await pool.query(
      "SELECT DISTINCT CONSTRAINT_NAME AS name FROM information_schema.key_column_usage WHERE table_schema = :db AND table_name = :table AND referenced_table_name = 'utenti_radio'",
      { db: dbName, table },
    );
    const list = (rows as unknown as Array<{ name: string }>).map((r) => String(r.name));
    for (const name of list) {
      if (!isSafeIdentifier(name)) continue;
      await pool.query(`ALTER TABLE ${table} DROP FOREIGN KEY ${name}`).catch(() => null);
    }
  }

  await dropUtentiRadioForeignKeys("sessions");
  await dropUtentiRadioForeignKeys("channels");
  await dropUtentiRadioForeignKeys("signals");

  const [colRows] = await pool.query(
    "SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = :db AND table_name = 'users'",
    { db: dbName },
  );
  const existingCols = new Set((colRows as unknown as Array<{ c: string }>).map((r) => String(r.c)));

  if (!existingCols.has("current_channel_id")) {
    await pool
      .query("ALTER TABLE users ADD COLUMN current_channel_id BIGINT UNSIGNED NULL")
      .catch(() => null);
  }
  if (!existingCols.has("last_seen")) {
    await pool.query("ALTER TABLE users ADD COLUMN last_seen DATETIME NULL").catch(() => null);
  }
}

