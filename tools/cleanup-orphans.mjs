// tools/cleanup-orphans.mjs
// R2† · 孤儿数据 TTL 清理（V2 硬门槛）：删除「无归属且超 30 天」的孤儿记录。
// 生产由 cron 调用（建议每日一次）；本脚本只删除，不改动业务代码。
// 运行：node tools/cleanup-orphans.mjs
//   依赖：PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE（或项目根 .env）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
try {
  const txt = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const client = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'chenlu',
  password: process.env.PGPASSWORD || 'chenlu',
  database: process.env.PGDATABASE || 'chenlu',
});

const TTL = "now() - interval '30 days'";

async function main() {
  await client.connect();
  // 先删子表（messages 依赖 conversations），再删父表
  const steps = [
    [`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id IS NULL AND anon_id IS NULL AND created_at < ${TTL})`, 'messages'],
    [`DELETE FROM conversations WHERE user_id IS NULL AND anon_id IS NULL AND created_at < ${TTL}`, 'conversations'],
    [`DELETE FROM charts WHERE user_id IS NULL AND anon_id IS NULL AND created_at < ${TTL}`, 'charts'],
    [`DELETE FROM fortune_events WHERE user_id IS NULL AND anon_id IS NULL AND created_at < ${TTL}`, 'fortune_events'],
  ];
  for (const [sql, name] of steps) {
    const r = await client.query(sql);
    console.log(`🧹 删除孤儿 ${name}: ${r.rowCount} 行`);
  }
  // anon_chart_rate / anon_chat_rate：清理未被任何用户关联的匿名计数（rate-limit 计数，非个人数据）
  const c1 = await client.query(
    `DELETE FROM anon_chart_rate WHERE anon_id IS NOT NULL AND anon_id NOT IN (SELECT anon_id FROM user_anon_link)`
  );
  const c2 = await client.query(
    `DELETE FROM anon_chat_rate WHERE anon_id IS NOT NULL AND anon_id NOT IN (SELECT anon_id FROM user_anon_link)`
  );
  console.log(`🧹 清理未关联匿名计数 anon_chart_rate: ${c1.rowCount} 行 / anon_chat_rate: ${c2.rowCount} 行`);
  console.log('✅ 孤儿 TTL 清理完成');
}

main().then(() => client.end().catch(() => {})).catch((e) => {
  console.error('❌ 清理失败：', e.message);
  process.exitCode = 1;
  client.end().catch(() => {});
});
