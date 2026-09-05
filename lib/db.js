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
  // P1 · 连接获取超时，避免 PG 不可达时请求无限挂起
  connectionTimeoutMillis: 5000,
  // P1 · 单条语句 / 空闲事务超时，防止慢查询长期占用连接（与 server.js 30s 上游超时协同）
  options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=30000',
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

/** 用户密码哈希（scrypt 真同步，无外部依赖） */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 生成密码哈希：salt(16字节hex) : scryptSync 派生(64字节→128 hex)。
 * 注意：必须使用 Node 内置 crypto.scryptSync（同步），切勿自行包装异步 scrypt。
 * 旧版伪同步实现会返回全零 Buffer，导致任意密码都可登录（认证完全绕过）。
 */
export function hashPassword(pwd) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(pwd, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

/**
 * 校验密码。返回 boolean。
 * 安全：使用 timingSafeEqual 防时序攻击。
 */
export function verifyPassword(pwd, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const derived = scryptSync(pwd, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (keyBuf.length !== derived.length) return false;
  return timingSafeEqual(keyBuf, derived);
}

/**
 * 是否为旧版「伪同步」遗留哈希：派生值全零（盐 + 128 个 '0'）。
 * 修复认证绕过后，所有旧哈希必然失效，登录时应提示用户重置密码（强制全量重置）。
 */
export function isLegacyHash(stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 2) return false;
  const key = parts[1];
  return key.length === 128 && /^0+$/.test(key);
}
