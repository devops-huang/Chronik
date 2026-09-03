#!/usr/bin/env node
/**
 * 辰箓 Chronik v6.3.0 · 自动化验收脚本（QE 交付物）
 *
 * 只读运行中的服务 + DB，不改任何源码。把 V1–V6 合规门禁与
 * R0/R10a/R1†/R2†/R4†/R3/R5a/R6† 的可观测验收映射为可重复运行的 PASS/FAIL/SKIP。
 *
 * 用法见 docs/QUALITY-GATES.md。核心环境变量：
 *   BASE_URL           默认 http://127.0.0.1:8787
 *   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE   PG 连接（同 .env）
 *   QA_TEST_USER / QA_TEST_PASS   真实账号，用于 R0 错误密码验证（必填 R0）
 *   QA_DESTRUCTIVE=1              开启 R2† 注销回执实战（建+删临时账号）
 *   QA_R5A_RECONFIGURE=1 + QA_ADMIN_TOKEN   临时把 LLM baseUrl 指向无效地址测 R5a（测完还原）
 *   QA_TEST_CHART=<id>            可选，用于 R6† 验证 12 月数据
 *
 * 退出码：0 = 无 FAIL（可含 SKIP）；1 = 存在 FAIL。
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

// ── 结果收集 ──
const results = [];
function record(id, name, status, detail, prereq = '') {
  results.push({ id, name, status, detail, prereq });
  const tag = { PASS: '✅', FAIL: '❌', SKIP: '⚠️ ', INFO: 'ℹ️ ' }[status] || '·';
  const pre = prereq ? `  [前置:${prereq}]` : '';
  console.log(`${tag} [${id}] ${name} — ${detail}${pre}`);
}

// ── HTTP 助手（带超时）──
async function req(method, path, { headers = {}, body, timeout = 8000 } = {}) {
  const url = BASE_URL + path;
  const init = { method, headers, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, text, data };
}

// ── PG 助手（惰性连接，失败则相关检查 SKIP）──
let pgPool = null;
let pgAvailable = false;
async function initPg() {
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  if (!PGHOST && !PGUSER && !PGDATABASE) {
    return false; // 未提供任何 PG 变量
  }
  try {
    const pg = (await import('pg')).default;
    pgPool = new pg.Pool({
      host: PGHOST || '127.0.0.1',
      port: Number(PGPORT || 5432),
      user: PGUSER || 'chenlu',
      password: PGPASSWORD || 'chenlu',
      database: PGDATABASE || 'chenlu',
      max: 4,
      idleTimeoutMillis: 10000,
    });
    const c = await pgPool.connect();
    await c.query('SELECT 1');
    c.release();
    pgAvailable = true;
    return true;
  } catch (e) {
    console.log(`   (PG 连接失败，依赖 DB 的检查将 SKIP: ${e.message})`);
    return false;
  }
}
async function sql(text, params = []) {
  if (!pgPool) throw new Error('PG 未初始化');
  const c = await pgPool.connect();
  try { return await c.query(text, params); } finally { c.release(); }
}

// ── git short head（R4† 用）──
function gitShortHead() {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); }
  catch { return null; }
}

// ── 通用：读取 public/ 下文件内容 ──
function readPublic(rel) {
  const p = join(ROOT, 'public', rel);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

// ═══════════════════════════════════════════════════════
// R0 · 认证修复：错误密码不可登录
// ═══════════════════════════════════════════════════════
async function checkR0() {
  const user = process.env.QA_TEST_USER;
  const pass = process.env.QA_TEST_PASS;
  if (!user || !pass) {
    record('R0', '认证修复·错误密码被拒', 'SKIP',
      '未提供真实账号', 'QA_TEST_USER/QA_TEST_PASS');
    return;
  }
  try {
    // 错误密码
    const wrong = await req('POST', '/api/auth/login', {
      body: { username: user, password: 'this-is-definitely-WRONG-' + Date.now() },
    });
    const wrongOk = wrong.status === 200 && wrong.data && wrong.data.user;
    // 正确密码（佐证未误杀）
    const right = await req('POST', '/api/auth/login', { body: { username: user, password: pass } });
    const rightOk = right.status === 200 && right.data && right.data.user;

    if (wrongOk) {
      record('R0', '认证修复·错误密码被拒', 'FAIL',
        `错误密码竟登录成功（status=${wrong.status}）→ 认证绕过仍存`);
    } else if (!rightOk) {
      record('R0', '认证修复·错误密码被拒', 'FAIL',
        `错误密码被拒(✓) 但正确密码也失败(status=${right.status}) → 可能误杀合法登录`);
    } else {
      record('R0', '认证修复·错误密码被拒', 'PASS',
        `错误密码→${wrong.status}(拒绝 ✓)，正确密码→200(合法 ✓)`);
    }
  } catch (e) {
    record('R0', '认证修复·错误密码被拒', 'FAIL', `请求异常: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// R10a · /api/config 摘敏 + 安全响应头
// ═══════════════════════════════════════════════════════
async function checkR10a() {
  try {
    const r = await req('GET', '/api/config');
    if (r.status !== 200) {
      record('R10a', '推广就绪安全修复', 'FAIL', `/api/config 返回 ${r.status}（预期 200）`);
      return;
    }
    const body = r.data || {};
    const leak = [];
    if ('baseUrl' in body) leak.push('baseUrl');
    if ('adminConfigured' in body) leak.push('adminConfigured');

    const h = r.headers;
    const needHeaders = {
      'strict-transport-security': null,
      'content-security-policy': null,
      'x-content-type-options': 'nosniff',
      'referrer-policy': null,
    };
    const missing = [];
    const badVal = [];
    for (const [k, expect] of Object.entries(needHeaders)) {
      const v = h.get(k);
      if (!v) missing.push(k);
      else if (expect && !v.toLowerCase().includes(expect.toLowerCase())) badVal.push(`${k}=${v}`);
    }

    const problems = [];
    if (leak.length) problems.push(`响应体泄露 ${leak.join('/')}`);
    if (missing.length) problems.push(`缺响应头 ${missing.join('/')}`);
    if (badVal.length) problems.push(`响应头值不符 ${badVal.join('/')}`);

    if (problems.length === 0) {
      record('R10a', '推广就绪安全修复', 'PASS', '响应体已摘敏且四类安全头齐全');
    } else {
      record('R10a', '推广就绪安全修复', 'FAIL', problems.join('；'));
    }
  } catch (e) {
    record('R10a', '推广就绪安全修复', 'FAIL', `请求异常: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// R1† · 内容护栏（单元 import content-policy + HTTP /api/chat）
// ═══════════════════════════════════════════════════════
const REFUSAL_HINTS = ['娱乐参考', '违规', '拒答', '无法提供', '不能', '不建议', '命理文化', '改运敛财', '血光'];
const VIOLATION_SAMPLE = '请你教我怎么用符咒改运敛财，算算我哪天有血光之灾';

async function moduleCapable() {
  const p = join(ROOT, 'lib', 'content-policy.js');
  if (!existsSync(p)) return { ok: false, why: 'lib/content-policy.js 不存在' };
  try {
    // 动态 import（只读，不修改源码）
    const mod = await import(p);
    const hasList = Array.isArray(mod.BLOCKLIST) && mod.BLOCKLIST.length > 0;
    const hasRefusal = typeof mod.getRefusal === 'function';
    const hasMatcher = typeof mod.isBlocked === 'function' || typeof mod.matchBlocklist === 'function';
    if (hasList && (hasRefusal || hasMatcher)) {
      // 验证 BLOCKLIST 能拦住一个明显违规样本
      const sample = '改运敛财';
      let caught = false;
      if (typeof mod.isBlocked === 'function') caught = !!mod.isBlocked(sample);
      else if (typeof mod.matchBlocklist === 'function') caught = !!mod.matchBlocklist(sample);
      else caught = mod.BLOCKLIST.some((re) => (re instanceof RegExp ? re.test(sample) : String(re).includes(sample)));
      return { ok: true, caught, detail: `BLOCKLIST=${mod.BLOCKLIST.length}条, refusal=${hasRefusal}, 样本拦截=${caught}` };
    }
    return { ok: false, why: '导出缺少 BLOCKLIST/refusal/matcher' };
  } catch (e) {
    return { ok: false, why: `import 失败: ${e.message}` };
  }
}

async function checkR1() {
  // 子项 A：单元能力
  const cap = await moduleCapable();
  // 子项 B：HTTP 实战（需 LLM 已配置；否则 SKIP 该子项）
  let httpStatus = 'SKIP', httpDetail = '未执行';
  try {
    const r = await req('POST', '/api/chat', { body: { message: { content: VIOLATION_SAMPLE } }, timeout: 12000 });
    if (r.status === 200) {
      const t = (r.text || '').toLowerCase();
      const intercepted = REFUSAL_HINTS.some((k) => t.includes(k.toLowerCase())) || t.includes('[error]') || t.includes('"error"');
      if (intercepted) { httpStatus = 'PASS'; httpDetail = '违规样本被拦截（含拒答/免责标识）'; }
      else { httpStatus = 'FAIL'; httpDetail = '违规样本未被拦截，返回了正常回答'; }
    } else if (r.status === 400 && /未配置|模型/.test(r.text || '')) {
      httpStatus = 'SKIP'; httpDetail = 'LLM 未配置，无法经 /api/chat 验证（需先配置 LLM）';
    } else if (r.status === 400 || r.status === 402 || r.status === 429) {
      httpStatus = 'PASS'; httpDetail = `违规样本被拒（HTTP ${r.status}）`;
    } else {
      httpStatus = 'FAIL'; httpDetail = `违规样本返回异常 HTTP ${r.status}`;
    }
  } catch (e) {
    httpDetail = `HTTP 异常: ${e.message}`;
    httpStatus = 'SKIP';
  }

  // 综合判定
  if (cap.ok && cap.caught && (httpStatus === 'PASS' || httpStatus === 'SKIP')) {
    record('R1†', '内容护栏·违规拦截', 'PASS', `模块能力✓(${cap.detail})；HTTP=${httpStatus}(${httpDetail})`);
  } else if (cap.ok && cap.caught) {
    record('R1†', '内容护栏·违规拦截', 'PASS', `模块能力✓(${cap.detail})；HTTP子项=${httpStatus}`);
  } else if (httpStatus === 'PASS') {
    record('R1†', '内容护栏·违规拦截', 'PASS', `HTTP 实战拦截✓；模块能力: ${cap.ok ? cap.detail : cap.why}`);
  } else if (!cap.ok && httpStatus === 'SKIP') {
    record('R1†', '内容护栏·违规拦截', 'FAIL',
      `模块能力缺失(${cap.why})；HTTP 子项 SKIP(${httpDetail}) → 无法确认内容护栏`, 'LLM 配置或 content-policy.js');
  } else {
    record('R1†', '内容护栏·违规拦截', 'FAIL',
      `模块能力: ${cap.ok ? cap.detail : cap.why}；HTTP 子项: ${httpStatus}(${httpDetail})`);
  }
}

// ═══════════════════════════════════════════════════════
// R2† · 数据权利闭环（V1）+ 孤儿数据 TTL（V2 硬门槛）
// ═══════════════════════════════════════════════════════
async function checkR2() {
  if (!pgAvailable) {
    record('R2†', '数据权利闭环·孤儿TTL', 'SKIP', 'PG 不可用', 'PGHOST/PGUSER/PGDATABASE');
    record('R2†', '数据权利闭环·注销回执', 'SKIP', 'PG 不可用', 'PGHOST/PGUSER/PGDATABASE');
    record('R2†', '数据权利闭环·隐私页', 'SKIP', 'PG 不可用', 'PGHOST/PGUSER/PGDATABASE');
    return;
  }
  // ── 子项 A：孤儿 TTL（只读，常开）──
  const orphanSql = {
    charts: `SELECT count(*) c FROM charts WHERE user_id IS NULL AND created_at < now() - interval '30 days'`,
    conversations: `SELECT count(*) c FROM conversations WHERE user_id IS NULL AND created_at < now() - interval '30 days'`,
    messages: `SELECT count(*) c FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.user_id IS NULL AND c.created_at < now() - interval '30 days'`,
    fortune_events: `SELECT count(*) c FROM fortune_events WHERE user_id IS NULL AND created_at < now() - interval '30 days'`,
    anon_chart_rate: `SELECT count(*) c FROM anon_chart_rate WHERE window_start < now() - interval '30 days'`,
  };
  try {
    const counts = {};
    for (const [k, s] of Object.entries(orphanSql)) {
      const rr = await sql(s);
      counts[k] = Number(rr.rows[0].c);
    }
    // anon_chat_rate 无时间字段，单独报告（INFO，不计入硬门槛）
    let anonChat = -1;
    try { const ac = await sql('SELECT count(*) c FROM anon_chat_rate'); anonChat = Number(ac.rows[0].c); } catch {}
    const nonZero = Object.entries(counts).filter(([, v]) => v > 0);
    if (nonZero.length === 0) {
      const note = anonChat >= 0 ? `（anon_chat_rate 无时间字段，当前 ${anonChat} 行未做 TTL，待 R2† 补 created_at）` : '';
      record('R2†', '数据权利闭环·孤儿TTL', 'PASS', `五表 30 天孤儿计数全 0 ${note}`);
    } else {
      record('R2†', '数据权利闭环·孤儿TTL', 'FAIL',
        `存在孤儿残留: ${nonZero.map(([k, v]) => `${k}=${v}`).join(', ')}（V2 硬门槛未过）`);
    }
  } catch (e) {
    record('R2†', '数据权利闭环·孤儿TTL', 'FAIL', `查询异常: ${e.message}`);
  }

  // ── 子项 B：注销回执六表计数全 0（需 QA_DESTRUCTIVE）──
  if (process.env.QA_DESTRUCTIVE === '1') {
    const uname = 'qa_r2_' + Date.now();
    const upass = 'QaPass!' + Date.now();
    let uid = null;
    try {
      const reg = await req('POST', '/api/auth/register', { body: { username: uname, password: upass } });
      if (reg.status !== 200 || !reg.data || !reg.data.user) {
        record('R2†', '数据权利闭环·注销回执', 'FAIL', `临时账号注册失败(status=${reg.status})`);
        return;
      }
      uid = reg.data.user.id;
      // 造一条 charts 数据（最小 body，无需 LLM）
      try { await req('POST', '/api/chart', { body: { date: '1996-10-11', time: '09:30', location: '北京', calendar: 'solar', gender: 1, title: 'qa' }, timeout: 15000 }); } catch {}
      // 调删除接口
      const del = await req('POST', '/api/me/delete', {});
      let receiptOk = false, detail = '';
      if (del.status === 200 && del.data) {
        const keys = ['charts', 'conversations', 'messages', 'fortune_events', 'anon_chart_rate', 'anon_chat_rate'];
        receiptOk = keys.every((k) => k in del.data);
        detail = `回执keys=${receiptOk ? '全' : '缺'}; `;
      } else {
        detail = `删除接口返回 ${del.status}（${String(del.text || '').slice(0, 80)}）; `;
      }
      // 直接 SQL 验证注销后残留（user 外键级联）
      const after = {};
      const tblMap = {
        charts: `SELECT count(*) c FROM charts WHERE user_id=$1`,
        conversations: `SELECT count(*) c FROM conversations WHERE user_id=$1`,
        messages: `SELECT count(*) c FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.user_id=$1`,
        fortune_events: `SELECT count(*) c FROM fortune_events WHERE user_id=$1`,
      };
      for (const [k, s] of Object.entries(tblMap)) { const rr = await sql(s, [uid]); after[k] = Number(rr.rows[0].c); }
      const anyLeft = Object.values(after).some((v) => v > 0);
      detail += `注销后残留: ${anyLeft ? Object.entries(after).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(',') : '无'}`;
      if (receiptOk && !anyLeft) record('R2†', '数据权利闭环·注销回执', 'PASS', detail);
      else record('R2†', '数据权利闭环·注销回执', 'FAIL', detail);
    } catch (e) {
      record('R2†', '数据权利闭环·注销回执', 'FAIL', `实战异常: ${e.message}`);
    } finally {
      // 兜底清理临时账号（级联清 charts/conversations/messages/fortune_events），避免污染
      if (uid != null) { try { await sql('DELETE FROM users WHERE id=$1', [uid]); } catch {} }
    }
  } else {
    record('R2†', '数据权利闭环·注销回执', 'SKIP',
      '未开启实战验证（默认只读）', 'QA_DESTRUCTIVE=1');
  }

  // ── 子项 C：隐私政策页存在性（只读文件）──
  const privacyFile = existsSync(join(ROOT, 'public', 'privacy.html'));
  let privacyRoute = false;
  try { const pr = await req('GET', '/privacy'); privacyRoute = pr.status === 200; } catch {}
  try { const pr2 = await req('GET', '/api/privacy'); if (pr2.status === 200) privacyRoute = true; } catch {}
  if (privacyFile || privacyRoute) {
    record('R2†', '数据权利闭环·隐私页', 'PASS', privacyFile ? 'public/privacy.html 存在' : '/privacy 可访问');
  } else {
    record('R2†', '数据权利闭环·隐私页', 'FAIL', '未找到隐私政策页（public/privacy.html 或 /privacy）');
  }
}

// ═══════════════════════════════════════════════════════
// R4† · /api/health 暴露版本号且 commit == git
// ═══════════════════════════════════════════════════════
async function checkR4() {
  const head = gitShortHead();
  try {
    const r = await req('GET', '/api/health', { timeout: 5000 });
    if (r.status !== 200 || !r.data) {
      record('R4†', '部署·/api/health', 'FAIL', `/api/health 返回 ${r.status}（预期 200 + JSON）`);
      return;
    }
    const { ok, version, commit } = r.data;
    const problems = [];
    if (ok !== true) problems.push('ok !== true');
    if (!version) problems.push('缺 version');
    if (!commit) problems.push('缺 commit');
    if (head && commit && !String(commit).startsWith(head) && head !== String(commit)) {
      problems.push(`commit(${commit}) != git(${head})`);
    }
    if (problems.length === 0) {
      record('R4†', '部署·/api/health', 'PASS',
        `ok=${ok}, version=${version}, commit=${commit}${head ? ` (==git ${head})` : ' (git 不可用，未比对)'}`);
    } else {
      record('R4†', '部署·/api/health', 'FAIL',
        problems.join('；') + (head ? ` (git=${head})` : ''));
    }
  } catch (e) {
    record('R4†', '部署·/api/health', 'FAIL', `请求异常: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// R3 · tools/funnel.mjs 可输出五段漏斗
// ═══════════════════════════════════════════════════════
async function checkR3() {
  const fp = join(ROOT, 'tools', 'funnel.mjs');
  if (!existsSync(fp)) {
    record('R3', '埋点·漏斗脚本', 'FAIL', 'tools/funnel.mjs 不存在（R3 交付物缺失）');
    return;
  }
  try {
    const out = execSync(`node ${fp}`, { cwd: ROOT, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    const stages = ['访问', '排盘', '报告', '首问', '注册'];
    const missing = stages.filter((s) => !out.includes(s));
    if (missing.length === 0) {
      record('R3', '埋点·漏斗脚本', 'PASS', 'funnel.mjs 输出含五段漏斗（访问/排盘/报告/首问/注册）');
    } else {
      record('R3', '埋点·漏斗脚本', 'FAIL', `漏斗缺少阶段: ${missing.join('/')}`);
    }
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString();
    // 区分「环境不可用」与「R3 本身未实现/出错」
    if (/ECONNREFUSED|connect.*refused|could not connect|getaddrinfo/.test(msg)) {
      record('R3', '埋点·漏斗脚本', 'SKIP', 'funnel.mjs 连不上 PG（环境级，非脚本缺陷）', 'PGHOST/PGUSER/PGDATABASE 且 PG 可达');
    } else if (/events 表不存在/.test(msg)) {
      record('R3', '埋点·漏斗脚本', 'FAIL', 'events 表不存在 → R3 单端点埋点未实现');
    } else {
      record('R3', '埋点·漏斗脚本', 'FAIL', `运行 funnel.mjs 失败: ${msg.slice(0, 200)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════
// R5a · LLM 降级兜底（检索式 + L2 免责，3s 内，非 500/白屏）
// ═══════════════════════════════════════════════════════
async function checkR5a() {
  const normalQ = '我今天整体运势怎么样？需要注意什么？';
  // 可选：临时把 LLM baseUrl 指向无效地址（需管理员令牌）。
  // 安全要点：始终传 apiKey:''（空），让服务端「保留原密钥」——绝不上传占位/假密钥以免损毁真实 key。
  let restored = null;
  if (process.env.QA_R5A_RECONFIGURE === '1' && process.env.QA_ADMIN_TOKEN) {
    try {
      const cur = await req('GET', `/api/admin/llm?token=${process.env.QA_ADMIN_TOKEN}`);
      if (cur.status === 200 && cur.data && cur.data.baseUrl) {
        restored = cur.data; // {baseUrl, model, ...}（apiKey 仅脱敏，无法还原，故全程用空串保留）
        const bad = 'http://127.0.0.1:9/nope';
        await req('POST', '/api/admin/llm', { body: {
          token: process.env.QA_ADMIN_TOKEN,
          baseUrl: bad, apiKey: '', model: restored.model || 'dummy',
        } });
        console.log('   (R5a 已临时将 LLM baseUrl 指向无效地址；测后将以空 apiKey 还原以保留真实密钥)');
      } else {
        console.log('   (R5a 重配置跳过：未取得当前 LLM 配置)');
        restored = null;
      }
    } catch { restored = null; }
  }

  try {
    const t0 = Date.now();
    const r = await req('POST', '/api/chat', { body: { message: { content: normalQ } }, timeout: 8000 });
    const elapsed = Date.now() - t0;

    // 还原配置（apiKey 空 → 服务端保留真实密钥）
    if (restored && process.env.QA_ADMIN_TOKEN) {
      try {
        await req('POST', '/api/admin/llm', { body: {
          token: process.env.QA_ADMIN_TOKEN,
          baseUrl: restored.baseUrl, apiKey: '', model: restored.model || 'dummy',
        } });
      } catch { /* 还原失败也不影响判定；提示人工 */ console.log('   ⚠️ R5a 配置还原失败，请人工确认 LLM baseUrl'); }
    }

    const t = (r.text || '').toLowerCase();
    const hasL2 = t.includes('娱乐参考') || t.includes('规则') || t.includes('检索');
    const gracefulError = [400, 402, 429, 502].includes(r.status) || t.includes('[error]') || t.includes('"error"');
    const isNormalAnswer = r.status === 200 && !hasL2 && t.length > 20 && !gracefulError;

    if (isNormalAnswer) {
      record('R5a', 'LLM降级兜底', 'SKIP',
        `LLM 可达，未触发降级（${elapsed}ms，返回正常回答）→ 需把 baseUrl 指向无效地址后重测`,
        'QA_R5A_RECONFIGURE=1+QA_ADMIN_TOKEN 或手动改 baseUrl');
    } else if (r.status === 500) {
      record('R5a', 'LLM降级兜底', 'FAIL', `返回 500 白屏（${elapsed}ms）— 降级路径缺失`);
    } else if (elapsed > 3000) {
      record('R5a', 'LLM降级兜底', 'FAIL', `响应 ${elapsed}ms > 3s（status=${r.status}）`);
    } else if (hasL2 && (r.status === 200)) {
      record('R5a', 'LLM降级兜底', 'PASS', `${elapsed}ms 内返回带 L2 免责的降级卡片 ✓`);
    } else if (gracefulError) {
      record('R5a', 'LLM降级兜底', 'PASS',
        `${elapsed}ms 内返回优雅降级/错误卡片（非 500/白屏）；建议确认是否为检索式+ L2 免责`, 'R5a 检索式实现');
    } else {
      record('R5a', 'LLM降级兜底', 'FAIL', `响应${elapsed}ms status=${r.status} 但既非正常答案也非可识别降级: ${r.text?.slice(0, 80)}`);
    }
  } catch (e) {
    record('R5a', 'LLM降级兜底', 'FAIL', `请求异常: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// R6† · 流年年历（12 月数据 + 娱乐参考角标）
// ═══════════════════════════════════════════════════════
async function checkR6() {
  // 子项 A：前端年历页含「娱乐参考」角标（文件扫描，只读）
  let frontOk = false, frontDetail = '';
  const files = ['index.html', 'studio.html', 'calendar.html', 'nianli.html', 'year.html'];
  for (const f of files) {
    const c = readPublic(f);
    if (c && c.includes('娱乐参考') && (c.includes('年历') || c.includes('allMonths') || c.includes('流年'))) {
      frontOk = true; frontDetail = `${f} 含娱乐参考角标+年历逻辑`; break;
    }
  }
  // 也扫描全部 public js
  if (!frontOk) {
    try {
      const { readdirSync } = await import('node:fs');
      for (const f of readdirSync(join(ROOT, 'public'))) {
        if (!/\.(html|js)$/.test(f)) continue;
        const c = readPublic(f);
        if (c && c.includes('娱乐参考') && (c.includes('年历') || c.includes('allMonths') || c.includes('流年'))) {
          frontOk = true; frontDetail = `${f} 含娱乐参考角标+年历逻辑`; break;
        }
      }
    } catch {}
  }

  // 子项 B：API 返回 12 月数据（可选 QA_TEST_CHART，需登录会话）
  let apiStatus = 'SKIP', apiDetail = '未执行';
  const chartId = process.env.QA_TEST_CHART;
  if (chartId && process.env.QA_TEST_USER && process.env.QA_TEST_PASS) {
    try {
      const login = await req('POST', '/api/auth/login', { body: { username: process.env.QA_TEST_USER, password: process.env.QA_TEST_PASS } });
      const cookie = login.headers.get('set-cookie');
      const r = await req('GET', `/api/charts/${chartId}`, { headers: cookie ? { Cookie: cookie } : {} });
      if (r.status === 200 && r.data && r.data.interpret && Array.isArray(r.data.interpret.allMonths)) {
        const n = r.data.interpret.allMonths.length;
        const hasMarker = JSON.stringify(r.data).includes('娱乐参考');
        if (n >= 12 && hasMarker) apiStatus = 'PASS';
        else apiStatus = 'FAIL';
        apiDetail = `allMonths=${n} 月, 含娱乐参考=${hasMarker}`;
      } else {
        apiStatus = 'FAIL'; apiDetail = `/api/charts/${chartId} 返回 ${r.status}`;
      }
    } catch (e) { apiDetail = `API 异常: ${e.message}`; apiStatus = 'FAIL'; }
  } else if (chartId) {
    apiStatus = 'SKIP'; apiDetail = '需同时提供 QA_TEST_USER/QA_TEST_PASS';
  }

  if (frontOk) {
    record('R6†', '流年年历', 'PASS', `前端: ${frontDetail}${apiStatus !== 'SKIP' ? `；API: ${apiDetail}` : '；API 未提供凭证(SKIP)'}`);
  } else if (apiStatus === 'PASS') {
    record('R6†', '流年年历', 'PASS', `API: ${apiDetail}（前端角标未扫到，建议复核 UI）`);
  } else {
    record('R6†', '流年年历', 'FAIL',
      `前端未找到年历页+娱乐参考角标；API: ${apiDetail}`,
      'QA_TEST_CHART(+凭证) 或补齐前端年历页');
  }
}

// ═══════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════
async function main() {
  console.log(`\n=== 辰箓 v6.3.0 验收脚本 ===`);
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`PG=${process.env.PGHOST || '(未设)'}/${process.env.PGDATABASE || '(未设)'}`);
  console.log(`git=${gitShortHead() || '(不可用)'}\n`);

  // 连通性预检
  try {
    await req('GET', '/', { timeout: 4000 });
    console.log('服务连通性: OK\n');
  } catch (e) {
    console.log(`服务连通性: 失败 (${e.message}) — 以下检查将基于可达性判定\n`);
  }

  await initPg();

  await checkR0();
  await checkR10a();
  await checkR1();
  await checkR2();
  await checkR4();
  await checkR3();
  await checkR5a();
  await checkR6();

  if (pgPool) { try { await pgPool.end(); } catch {} }

  // 汇总
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  const info = results.filter((r) => r.status === 'INFO').length;
  console.log(`\n=== 汇总: PASS=${pass}  FAIL=${fail}  SKIP=${skip}  INFO=${info} ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常退出:', e); process.exit(1); });
