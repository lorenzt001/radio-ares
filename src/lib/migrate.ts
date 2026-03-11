import { getPool } from "@/lib/db";

export async function ensureSchema(): Promise<void> {
  const pool = getPool();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS utenti_radio (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(64) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('owner','moderator','user') NOT NULL DEFAULT 'user',
      current_channel_id BIGINT UNSIGNED NULL,
      last_seen DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS channels (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(64) NOT NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_channels_name (name),
      KEY idx_channels_created_by (created_by),
      CONSTRAINT fk_channels_created_by FOREIGN KEY (created_by) REFERENCES utenti_radio(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id CHAR(64) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sessions_user_id (user_id),
      KEY idx_sessions_expires_at (expires_at),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES utenti_radio(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS signals (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      channel_id BIGINT UNSIGNED NOT NULL,
      from_user_id BIGINT UNSIGNED NOT NULL,
      to_user_id BIGINT UNSIGNED NULL,
      kind VARCHAR(16) NOT NULL,
      payload LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_signals_channel_id (channel_id),
      KEY idx_signals_to_user_id (to_user_id),
      KEY idx_signals_created_at (created_at),
      CONSTRAINT fk_signals_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      CONSTRAINT fk_signals_from_user FOREIGN KEY (from_user_id) REFERENCES utenti_radio(id) ON DELETE CASCADE,
      CONSTRAINT fk_signals_to_user FOREIGN KEY (to_user_id) REFERENCES utenti_radio(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

