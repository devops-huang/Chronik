/**
 * I0 迭代验证脚本（DB-free，可在无 Postgres 的本地/CI 环境运行）。
 *
 * 覆盖：
 *   1. 拆登录墙：游客态首页数据路径（buildTodayFortune(null, …, null)）不抛错、结构合法、
 *      个性化运势降级为 null（前端走通用文案，不报错）。
 *   2. 埋点骨架：server.js TRACK_ACTIONS 白名单已包含 I0 新增的 7 个 action。
 *
 * 用法：
 *   node tools/verify-i0.mjs            # 静态 + 逻辑校验（无需 DB）
 *   DATABASE_URL=... node tools/verify-i0.mjs   # 额外做 /api/track 端到端记录+查询校验
 */
import { buildTodayFortune, buildMonthGrid, todayInShanghai } from '../lib/home.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let failures = 0;
const ok = (name) => console.log(`  ✅ ${name}`);
const fail = (name, e) => { failures++; console.error(`  ❌ ${name}: ${e?.message || e}`); };

console.log('— I0 验证开始 —\n');

// ── 1. 游客态首页数据路径（拆登录墙核心）──
console.log('[1] 游客态首页数据路径（handleHome 的游客分支）');
try {
  const { dateStr } = todayInShanghai();
  const fortune = buildTodayFortune(null, dateStr, null);
  if (!fortune || typeof fortune !== 'object') throw new Error('fortune 非对象');
  if (!Array.isArray(fortune.yi) || !Array.isArray(fortune.ji)) throw new Error('宜忌字段缺失');
  if (!fortune.fortune || !fortune.fortune.headline) throw new Error('通用运势 headline 缺失');
  if (fortune.personal != null) throw new Error('游客态 personal 应降级为 null，实际=' + JSON.stringify(fortune.personal));
  ok(`buildTodayFortune(null, ${dateStr}, null) 返回合法运势且 personal 已降级`);

  const [y, m] = dateStr.split('-').map(Number);
  const grid = buildMonthGrid(y, m, dateStr);
  if (!Array.isArray(grid) || grid.length === 0) throw new Error('日历网格为空');
  ok(`buildMonthGrid(${y}, ${m}) 返回 ${grid.length} 天`);
} catch (e) { fail('游客态首页数据路径', e); }

// ── 2. 埋点白名单（Task 3）──
console.log('\n[2] 埋点 action 白名单（server.js TRACK_ACTIONS）');
try {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const m = src.match(/const TRACK_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error('未在 server.js 找到 TRACK_ACTIONS 定义');
  const actions = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const required = ['pricing_viewed', 'paywall_hit', 'redeem_success',
    'login_wall_view', 'home_anon_view', 'share_generated', 'source_self_report'];
  const missing = required.filter((a) => !actions.includes(a));
  if (missing.length) throw new Error('白名单缺少: ' + missing.join(', '));
  ok(`白名单含全部 7 个 I0 新增 action（共 ${actions.length} 项）`);
} catch (e) { fail('埋点白名单', e); }

// ── 3. （可选）端到端记录+查询：需要 DATABASE_URL 指向可达的 Postgres ──
if (process.env.DATABASE_URL || process.env.PGHOST) {
  console.log('\n[3] 端到端 /api/track（需要 DB，已检测到连接配置）');
  try {
    const base = process.env.BASE_URL || 'http://localhost:8787';
    const res = await fetch(`${base}/api/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'home_anon_view', payload: { verify: true } }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.ok !== true) throw new Error('track 返回 ' + res.status + ' ' + JSON.stringify(d));
    ok(`POST /api/track {action:'home_anon_view'} => 200 {ok:true}`);
    console.log('  ℹ️ 记录后可在 Postgres 查询：SELECT * FROM events WHERE action=\'home_anon_view\';');
  } catch (e) { fail('端到端 /api/track', e); }
} else {
  console.log('\n[3] 端到端 /api/track 校验跳过（未设置 DATABASE_URL/PGHOST）。');
  console.log('    测试/生产环境（含 Postgres）请设置 DATABASE_URL 后重跑本脚本。');
}

console.log('\n— I0 验证结束 —');
if (failures) { console.error(`结果：失败 ${failures} 项`); process.exit(1); }
console.log('结果：全部通过 ✅');
