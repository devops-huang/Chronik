/**
 * PostgreSQL 连接层 + 幂等建表。
 * 连接信息来自环境变量（部署时写入 .env）：
 *   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
 * 本地未配置时给出明确报错，不静默。
 */
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const cfg = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'chenlu',
  password: process.env.PGPASSWORD || 'chenlu',
  database: process.env.PGDATABASE || 'chenlu',
  max: 10,
  idleTimeoutMillis: 30000,
};

export const pool = new pg.Pool(cfg);

pool.on('error', (e) => {
  console.error('[pg] 连接池异常：', e.message);
});

/** 执行 schema.sql（CREATE TABLE IF NOT EXISTS …），幂等。 */
export async function initSchema() {
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[pg] schema 已就绪');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function query(text, params = []) {
  return pool.query(text, params);
}

/** 用户密码哈希（scrypt，无外部依赖） */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
export function hashPassword(pwd) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(pwd, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}
function scryptSync(pwd, salt, len) {
  const out = Buffer.alloc(len);
  scrypt(Buffer.from(pwd, 'utf8'), Buffer.from(salt, 'utf8'), len, (err, d) => {
    if (err) throw err;
    d.copy(out);
  });
  return out;
}
export function verifyPassword(pwd, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const derived = scryptSync(pwd, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (keyBuf.length !== derived.length) return false;
  return timingSafeEqual(keyBuf, derived);
}
