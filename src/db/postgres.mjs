import 'dotenv/config';

let poolPromise;

function hasPostgresConfig() {
  return Boolean(
    process.env.DATABASE_URL
      || process.env.PGHOST
      || process.env.POSTGRES_HOST,
  );
}

async function loadPgModule() {
  try {
    return await import('pg');
  } catch (error) {
    throw new Error(
      'PostgreSQL driver "pg" is not installed. Run "npm install pg" before using DATABASE_URL.',
      { cause: error },
    );
  }
}

function getConnectionConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    host: process.env.PGHOST || process.env.POSTGRES_HOST || '127.0.0.1',
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'bts_dss',
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '',
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };
}

export async function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const { Pool } = await loadPgModule();
      return new Pool(getConnectionConfig());
    })();
  }

  return poolPromise;
}

export async function query(text, params = []) {
  const pool = await getPool();
  return pool.query(text, params);
}

export async function withTransaction(handler) {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export { hasPostgresConfig };
