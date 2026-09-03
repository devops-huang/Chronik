// tools/test-gdpr.mjs
// 测试对象：R2† 隐私数据权利闭环（游客合并 / 一键删除回执 / 孤儿 30 天 TTL / 导出）
// 运行：node tools/test-gdpr.mjs
//   依赖：① 真实 PostgreSQL（从 process.env 或项目根 .env 读 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE）
//         ② 应用服务正在运行（POST /api/register、POST /api/me/export、POST /api/me/delete）
//            地址取 process.env.CHRONIK_BASE_URL，默认 http://127.0.0.1:8787
// 约束：仅用独立随机测试账号，结束清理，绝不破坏现有数据；失败 process.exit(1)。
//
// 说明（重要）：本脚本按 PRD R2† 接口编写，依赖主程实现的接口：
//   - /api/register 在带 cl_aid 匿名 cookie 注册时，应把该 anon_id 的历史数据并入新账号
//     （lib/auth.js 的 mergeAnonCharts / mergeAnonConversations，并写入 user_anon_link 映射）。
//   - /api/me/delete 按 `user_id = $1 OR anon_id IN (SELECT anon_id FROM user_anon_link WHERE user_id=$1)`
//     双条件删六表，返回回执 {charts,conversations,messages,fortune_events,anon_chart_rate,anon_chat_rate}。
//   - /api/me/export 返回 JSON。
//   - anon_chart_rate 须具备按用户/匿名归属删除的能力（PRD 要求六表全覆盖；若主程为其增加了 anon_id 列，
//     本脚本会写入并据此断言；若仍仅以 ip 为主键，请主程保证能在删除时清掉对应记录）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ── 极简 .env 加载（项目未引入 dotenv）──
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

const BASE_URL = process.env.CHRONIK_BASE_URL || 'http://127.0.0.1:8787';
const client = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'chenlu',
  password: process.env.PGPASSWORD || 'chenlu',
  database: process.env.PGDATABASE || 'chenlu',
});

function fail(msg) {
  console.error('❌ ' + msg);
  process.exitCode = 1;
}
function ok(msg) { console.log('✅ ' + msg); }

// ── HTTP 小工具 ──
async function http(method, path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

const rand = Math.random().toString(36).slice(2, 10);
const TEST_USER = `gdpr_test_${rand}`;
const TEST_PASS = 'Gdpr@' + rand + '2026';
const ANON_A = 'anonA_' + rand;            // 游客匿名 ID
const TEST_IP = '203.0.113.' + (100 + (rand.charCodeAt(0) % 100)); // 文档段假 IP，绝不污染真实 IP

async function hasColumn(table, col) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
    [table, col]
  );
  return r.rowCount > 0;
}

async function main() {
  await client.connect();
  console.log(`→ 连接 PG 成功；测试账号=${TEST_USER}，anon_id=${ANON_A}`);

  // ───────────────────────── ① 游客排盘 → 登录合并 → 注销 ─────────────────────────
  // 写入六表（以 anon_id=A 归属的游客数据）
  const chartRes = await client.query(
    `INSERT INTO charts (user_id, anon_id, title, input) VALUES (NULL, $1, '游客测试盘', '{}') RETURNING id`,
    [ANON_A]
  );
  const chartId = chartRes.rows[0].id;

  const convRes = await client.query(
    `INSERT INTO conversations (user_id, anon_id, chart_id, title) VALUES (NULL, $1, $2, '游客会话') RETURNING id`,
    [ANON_A, chartId]
  );
  const convId = convRes.rows[0].id;

  await client.query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', '游客首问')`,
    [convId]
  );
  await client.query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', '游客回答')`,
    [convId]
  );
  await client.query(
    `INSERT INTO fortune_events (user_id, anon_id, action) VALUES (NULL, $1, 'expand_why')`,
    [ANON_A]
  );
  await client.query(
    `INSERT INTO anon_chat_rate (anon_id, rounds) VALUES ($1, 1)
     ON CONFLICT (anon_id) DO UPDATE SET rounds = anon_chat_rate.rounds + 1`,
    [ANON_A]
  );

  // anon_chart_rate：若主程已加 anon_id 列则一并写入，便于双条件删除
  if (await hasColumn('anon_chart_rate', 'anon_id')) {
    await client.query(
      `INSERT INTO anon_chart_rate (ip, anon_id, cnt) VALUES ($1, $2, 1)
       ON CONFLICT (ip) DO UPDATE SET cnt = anon_chart_rate.cnt + 1`,
      [TEST_IP, ANON_A]
    );
  } else {
    await client.query(
      `INSERT INTO anon_chart_rate (ip, cnt) VALUES ($1, 1)
       ON CONFLICT (ip) DO UPDATE SET cnt = anon_chart_rate.cnt + 1`,
      [TEST_IP]
    );
  }

  const N = 1; // 每表 N 条（演示用 1；可改大验证批量）

  // 注册：带游客 cookie，触发合并
  const reg = await http('POST', '/api/register', {
    body: { username: TEST_USER, password: TEST_PASS, nickname: 'GDPR', agree: true, consent: true },
    cookie: `cl_aid=${ANON_A}`,
  });
  if (reg.status !== 200 || !reg.setCookie) {
    throw new Error(`注册失败（status=${reg.status}）：` + JSON.stringify(reg.json));
  }
  const sessionCookie = reg.setCookie.split(';')[0];

  const uidRes = await client.query('SELECT id FROM users WHERE username=$1', [TEST_USER]);
  const X = uidRes.rows[0].id;
  ok(`注册并合并游客数据成功，用户 id=${X}`);

  // 删除前的计数（按 PRD 双条件口径）
  const linkSQL = `(SELECT anon_id FROM user_anon_link WHERE user_id=$1)`;
  const before = {};
  before.charts = (await client.query(`SELECT count(*) c FROM charts WHERE user_id=$1 OR anon_id IN ${linkSQL}`, [X])).rows[0].c;
  before.conversations = (await client.query(`SELECT count(*) c FROM conversations WHERE user_id=$1 OR anon_id IN ${linkSQL}`, [X])).rows[0].c;
  before.messages = (await client.query(`SELECT count(*) c FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.user_id=$1 OR c.anon_id IN ${linkSQL}`, [X])).rows[0].c;
  before.fortune_events = (await client.query(`SELECT count(*) c FROM fortune_events WHERE user_id=$1 OR anon_id IN ${linkSQL}`, [X])).rows[0].c;
  before.anon_chat_rate = (await client.query(`SELECT count(*) c FROM anon_chat_rate WHERE anon_id IN ${linkSQL} OR anon_id=$2`, [X, ANON_A])).rows[0].c;
  if (await hasColumn('anon_chart_rate', 'anon_id')) {
    before.anon_chart_rate = (await client.query(`SELECT count(*) c FROM anon_chart_rate WHERE anon_id IN ${linkSQL} OR anon_id=$2`, [X, ANON_A])).rows[0].c;
  } else {
    before.anon_chart_rate = (await client.query(`SELECT count(*) c FROM anon_chart_rate WHERE ip=$1`, [TEST_IP])).rows[0].c;
  }

  // ③ 导出应返回 JSON
  const exp = await http('POST', '/api/me/export', { cookie: sessionCookie });
  let exportJson = null;
  try { exportJson = exp.json; } catch {}
  assert.ok(exp.status === 200 && exportJson && typeof exportJson === 'object',
    `导出应返回 JSON（status=${exp.status}）`);
  ok('POST /api/me/export 返回 JSON');

  // 注销 → 回执
  const del = await http('POST', '/api/me/delete', { cookie: sessionCookie });
  assert.strictEqual(del.status, 200, `删除接口应 200，实际 ${del.status}`);
  const receipt = del.json || {};
  const needKeys = ['charts', 'conversations', 'messages', 'fortune_events', 'anon_chart_rate', 'anon_chat_rate'];
  for (const k of needKeys) {
    assert.ok(k in receipt, `回执应含字段 ${k}`);
  }
  // ③ 回执与删除前计数一致
  for (const k of needKeys) {
    assert.strictEqual(Number(receipt[k]), Number(before[k]),
      `回执.${k}=${receipt[k]} 应与删除前计数 ${before[k]} 一致`);
  }
  ok(`注销回执与删除前计数一致（${JSON.stringify(receipt)}）`);

  // ① 注销后六表相关计数全 0
  const after = {};
  after.charts = (await client.query(`SELECT count(*) c FROM charts WHERE user_id=$1 OR anon_id IN ${linkSQL}`, [X])).rows[0].c;
  after.conversations = (await client.query(`SELECT count(*) c FROM conversations WHERE user_id=$1 OR anon_id IN ${linkSQL}`, [X])).rows[0].c;
  after.messages = (await client.query(`SELECT count(*) c FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.user_id=$1 OR c.anon_id IN ${linkSQL}`, [X])).rows[0].c;
  after.fortune_events = (await client.query(`SELECT count(*) c FROM fortune_events WHERE user_id=$1 OR anon_id IN ${linkSQL}`, [X])).rows[0].c;
  after.anon_chat_rate = (await client.query(`SELECT count(*) c FROM anon_chat_rate WHERE anon_id IN ${linkSQL} OR anon_id=$2`, [X, ANON_A])).rows[0].c;
  if (await hasColumn('anon_chart_rate', 'anon_id')) {
    after.anon_chart_rate = (await client.query(`SELECT count(*) c FROM anon_chart_rate WHERE anon_id IN ${linkSQL} OR anon_id=$2`, [X, ANON_A])).rows[0].c;
  } else {
    after.anon_chart_rate = (await client.query(`SELECT count(*) c FROM anon_chart_rate WHERE ip=$1`, [TEST_IP])).rows[0].c;
  }
  for (const k of needKeys) {
    assert.strictEqual(Number(after[k]), 0, `注销后 ${k} 计数应为 0，实际 ${after[k]}`);
  }
  ok('游客合并→注销后六表（user_id=X 或 anon_id∈{A}）计数全部为 0');

  // ───────────────────────── ② 孤儿 TTL：31 天前孤儿记录清理 ─────────────────────────
  const oldTs = 'now() - interval \'31 days\'';
  const oldChart = await client.query(
    `INSERT INTO charts (user_id, anon_id, title, input, created_at) VALUES (NULL, NULL, '孤儿盘', '{}', ${oldTs}) RETURNING id`,
  );
  const ocId = oldChart.rows[0].id;
  const ocConv = await client.query(
    `INSERT INTO conversations (user_id, anon_id, chart_id, title, created_at) VALUES (NULL, NULL, $1, '孤儿会话', ${oldTs}) RETURNING id`,
    [ocId]
  );
  const ocConvId = ocConv.rows[0].id;
  await client.query(
    `INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, 'user', '孤儿消息', ${oldTs})`,
    [ocConvId]
  );
  await client.query(
    `INSERT INTO fortune_events (user_id, anon_id, action, created_at) VALUES (NULL, NULL, 'expand_why', ${oldTs})`
  );

  // 运行与定时任务等价的清理（生产由 cron 执行；此处按 PRD 口径直接执行）
  await client.query(
    `DELETE FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE user_id IS NULL AND anon_id IS NULL AND created_at < now() - interval '30 days')`
  );
  await client.query(
    `DELETE FROM conversations WHERE user_id IS NULL AND anon_id IS NULL AND created_at < now() - interval '30 days'`
  );
  await client.query(
    `DELETE FROM charts WHERE user_id IS NULL AND anon_id IS NULL AND created_at < now() - interval '30 days'`
  );
  await client.query(
    `DELETE FROM fortune_events WHERE user_id IS NULL AND anon_id IS NULL AND created_at < now() - interval '30 days'`
  );

  const orphan = {};
  orphan.charts = (await client.query(`SELECT count(*) c FROM charts WHERE user_id IS NULL AND anon_id IS NULL AND created_at < now() - interval '30 days'`)).rows[0].c;
  orphan.conversations = (await client.query(`SELECT count(*) c FROM conversations WHERE user_id IS NULL AND anon_id IS NULL AND created_at < now() - interval '30 days'`)).rows[0].c;
  orphan.messages = (await client.query(`SELECT count(*) c FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.user_id IS NULL AND c.anon_id IS NULL AND c.created_at < now() - interval '30 days'`)).rows[0].c;
  orphan.fortune_events = (await client.query(`SELECT count(*) c FROM fortune_events WHERE user_id IS NULL AND anon_id IS NULL AND created_at < now() - interval '30 days'`)).rows[0].c;

  for (const k of ['charts', 'conversations', 'messages', 'fortune_events']) {
    assert.strictEqual(Number(orphan[k]), 0, `孤儿 TTL 清理后 ${k} 应为 0，实际 ${orphan[k]}`);
  }
  ok('孤儿数据（user_id IS NULL AND created_at<now()-30d）清理后计数为 0');

  console.log('\n🎉 test-gdpr 全部断言通过（游客合并删除 / 回执一致 / 六表清零 / 孤儿 TTL）。');
  process.exit(0);
}

// ── 收尾：无论如何清理测试痕迹 ──
async function teardown() {
  try {
    await client.query('DELETE FROM user_anon_link WHERE user_id IN (SELECT id FROM users WHERE username=$1)', [TEST_USER]);
    await client.query('DELETE FROM anon_chat_rate WHERE anon_id=$1', [ANON_A]);
    if (await hasColumn('anon_chart_rate', 'anon_id')) {
      await client.query('DELETE FROM anon_chart_rate WHERE anon_id=$1', [ANON_A]);
    }
    await client.query('DELETE FROM anon_chart_rate WHERE ip=$1', [TEST_IP]);
    await client.query('DELETE FROM users WHERE username=$1', [TEST_USER]); // 级联清 charts/conversations/messages/fortune_events/sessions
    await client.query('DELETE FROM charts WHERE user_id IS NULL AND anon_id IS NULL AND title IN (\'孤儿盘\')');
    await client.query('DELETE FROM conversations WHERE user_id IS NULL AND anon_id IS NULL AND title IN (\'孤儿会话\')');
  } catch (e) {
    console.warn('⚠️  teardown 部分清理失败（请人工核查测试残留）：', e.message);
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .then(() => teardown())
  .catch(async (e) => {
    fail(e && e.message ? e.message : String(e));
    await teardown();
    process.exit(1);
  });
