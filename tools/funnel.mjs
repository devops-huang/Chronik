// tools/funnel.mjs
// 测试/运营对象：R3 业务漏斗（访问→排盘→报告→首问→注册）+ 报告→注册转化率
// 运行：node tools/funnel.mjs
//   依赖：真实 PostgreSQL（从 process.env 或项目根 .env 读 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE）
//   聚合来源：events 表（action 白名单见 PRD R3：page_view / chart_done / report_viewed / ai_first_q / anon_to_signup / calendar_viewed 等）
//   要求：30 秒内完成并打印。无参数，可经环境变量微调：
//     FUNNEL_DAYS   时间窗口天数（默认 30；'all' = 全量）
//     FUNNEL_REPORT_ACTION  报告阶段对应的事件名（默认 report_viewed；不存在时回退 fortune_expand）
//
// 漏斗口径：每个阶段统计「去重参与者」数（COALESCE(user_id, 'anon:'||anon_id)），
// 即触发过该事件的不同用户/游客数，符合转化漏斗语义。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function loadEnv() {
  try {
    const txt = readFileSync(resolve(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* 无 .env 则全部依赖 process.env */ }
}
loadEnv();

const DAYS = process.env.FUNNEL_DAYS && process.env.FUNNEL_DAYS !== 'all'
  ? Number(process.env.FUNNEL_DAYS) : null;
const REPORT_ACTION = process.env.FUNNEL_REPORT_ACTION || 'report_viewed';

const client = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'chenlu',
  password: process.env.PGPASSWORD || 'chenlu',
  database: process.env.PGDATABASE || 'chenlu',
});

async function distinctCount(action) {
  const timeFilter = DAYS ? `AND created_at >= now() - interval '${DAYS} days'` : '';
  const r = await client.query(
    `SELECT count(DISTINCT COALESCE(user_id::text, 'anon:'||anon_id)) AS c
       FROM events WHERE action = $1 ${timeFilter}`,
    [action]
  );
  return Number(r.rows[0].c);
}

async function actionExists(action) {
  const r = await client.query('SELECT 1 FROM events WHERE action=$1 LIMIT 1', [action]);
  return r.rowCount > 0;
}

async function main() {
  const t0 = Date.now();
  await client.connect();

  // 校验 events 表存在
  const tbl = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name='events'`
  );
  if (tbl.rowCount === 0) {
    console.error('❌ events 表不存在：请先由主程实现 R3 单端点埋点（POST /api/track + events 表）。');
    process.exit(1);
  }

  const reportAction = (await actionExists(REPORT_ACTION)) ? REPORT_ACTION
    : (await actionExists('fortune_expand')) ? 'fortune_expand' : REPORT_ACTION;

  const STAGES = [
    { name: '访问', action: 'page_view' },
    { name: '排盘', action: 'chart_done' },
    { name: '报告', action: reportAction },
    { name: '首问', action: 'ai_first_q' },
    { name: '注册', action: 'anon_to_signup' },
  ];

  for (const s of STAGES) s.count = await distinctCount(s.action);

  const width = 8;
  console.log('\n=== 辰箓 v6.3.0 · 业务漏斗 ===');
  console.log(`窗口：${DAYS ? `近 ${DAYS} 天` : '全量'}  | 阶段口径：去重参与者数\n`);
  console.log(`${'阶段'.padEnd(width)} | ${'事件'.padEnd(16)} | ${'人数'.padStart(8)}`);
  console.log('-'.repeat(width + 3 + 18 + 10));
  for (const s of STAGES) {
    console.log(`${s.name.padEnd(width)} | ${s.action.padEnd(16)} | ${String(s.count).padStart(8)}`);
  }

  const report = STAGES.find(s => s.name === '报告').count;
  const signup = STAGES.find(s => s.name === '注册').count;
  const conv = report > 0 ? (signup / report * 100) : 0;
  console.log('\n报告→注册 转化率：' +
    (report > 0 ? `${conv.toFixed(2)}%  (${signup}/${report})` : 'N/A（报告阶段无数据）'));

  const elapsed = Date.now() - t0;
  console.log(`\n⏱  耗时 ${elapsed}ms（要求 ≤ 30000ms）`);
  await client.end();
  if (elapsed > 30000) process.exit(1);
  process.exit(0);
}

main().catch(async (e) => {
  console.error('❌ funnel 执行失败：', e && e.message ? e.message : e);
  try { await client.end(); } catch {}
  process.exit(1);
});
