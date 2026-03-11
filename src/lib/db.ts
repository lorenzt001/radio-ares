import mysql, { type Pool } from "mysql2/promise";

type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

function readDbConfig(): DbConfig {
  const host = process.env.DB_HOST;
  const portRaw = process.env.DB_PORT ?? "3306";
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;

  if (!host || !user || !password || !database) {
    throw new Error("Missing DB_* environment variables");
  }

  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    throw new Error("Invalid DB_PORT");
  }

  return { host, port, user, password, database };
}

declare global {
  var __radioAresPool: Pool | undefined;
}

export function getPool(): Pool {
  if (globalThis.__radioAresPool) return globalThis.__radioAresPool;

  const cfg = readDbConfig();
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    decimalNumbers: true,
    namedPlaceholders: true,
  });

  globalThis.__radioAresPool = pool;
  return pool;
}

