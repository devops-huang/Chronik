/**
 * 辰箓 · 后端服务（Node 内置模块 + pg）。
 *
 * 公开：GET / /login.html / 静态；/api/config /api/cities /api/auth/register /api/auth/login
 * 受保护（需会话）：/api/auth/me /api/auth/logout /api/chart /api/charts /api/charts/:id
 *                  /api/home /api/chat
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execSync, execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, initSchema, query } from './lib/db.js';
import {
  register, login, createSession, destroySession, getUserFromRequest, updateProfile,
  requireUserOrAnon, getAnonId, mergeAnonCharts, mergeAnonConversations, ANON_COOKIE_NAME,
  requestPasswordReset, confirmPasswordReset,
} from './lib/auth.js';
import { computeAll, chartContextText } from './lib/core.js';
import { listAllCities, resolveLocation } from './lib/chart.js';
import { buildMonthGrid, buildTodayFortune, getWeather, getWeatherByLatLon, todayInShanghai } from './lib/home.js';
import { deriveNatalFromBirth } from './lib/fortuneEngine.js';
import { loadLlmConfig, saveLlmConfig, maskKey } from './lib/llmConfig.js';
import { isBlocked, getRefusal, DISCLAIMER_L2, DISCLAIMER_L3, isHighRisk, CHAT_ROLE_DECLARATION } from './lib/content-policy.js';
// I3 · 服务端权威配额（P0-6）：统一配额入口 + 付费授权查询
import { checkAiQuota, getQuotaInfo, getEntitlement, FREE_DAILY_ROUNDS, PAID_DAILY_ROUNDS } from './lib/quota.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 8787;

// P1-7 · AI 成本护栏：单用户（含游客 anon_id）每日 token 上限。
// 默认 50 万 token/日；可通过环境变量 AI_DAILY_TOKEN_CAP 调整。
const AI_DAILY_TOKEN_CAP = Number(process.env.AI_DAILY_TOKEN_CAP || 500000);
// 观察期（默认开启，首周）：只计量、不节流、不拦截。置 OBSERVE_ONLY=false 才真正限流。
const OBSERVE_ONLY = process.env.OBSERVE_ONLY !== 'false';

// R4† · 版本与 commit（commit == git HEAD，供 /api/health 校验线上==HEAD）
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version; } catch { return process.env.APP_VERSION || '6.3.0'; }
})();
const GIT_COMMIT = (() => {
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch { return process.env.APP_COMMIT || 'unknown'; }
})();

// 管理员配置令牌：env ADMIN_TOKEN 优先，否则读取 data/admin.token（文件权限 600）
function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  try {
    const p = join(__dirname, 'data', 'admin.token');
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  } catch {}
  return '';
}
const ADMIN_TOKEN = loadAdminToken();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

// P0 · 响应级 gzip：仅压缩文本类且非 SSE 的响应（SSE 流式由客户端/上游超时自然结束，不压缩）
const COMPRESSIBLE_RE = /^(text\/html|text\/css|text\/javascript|application\/javascript|application\/json|text\/xml|application\/xml|image\/svg\+xml|text\/plain)/i;
function maybeGzip(res, contentType, body) {
  const ae = res.req && res.req.headers && res.req.headers['accept-encoding'];
  if (typeof ae !== 'string' || !ae.includes('gzip')) return body;
  if (!COMPRESSIBLE_RE.test(contentType) || /event-stream/i.test(contentType)) return body;
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const out = gzipSync(buf);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return out;
  } catch { return body; }
}

function sendJson(res, code, obj) {
  applySecurityHeaders(res);
  const out = maybeGzip(res, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(obj), 'utf8'));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(out);
}
function sendText(res, code, text) {
  applySecurityHeaders(res);
  const out = maybeGzip(res, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(out);
}

/** R10a · 推广就绪安全头（R10a-2 / V4 基础） */
function applySecurityHeaders(res) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' https://ipwho.is; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; " +
    "report-uri /api/csp-report"
  );
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const st = await stat(file);
    if (st.isDirectory()) { res.writeHead(403); return res.end('forbidden'); }
    const data = await readFile(file);
    const mime = MIME[extname(file)] || 'application/octet-stream';
    applySecurityHeaders(res);
    // P1 · 静态资源缓存：vendor / 带 hash 的库 / 字体 → 1 年 immutable；HTML → no-cache 重新校验
    if (file.includes(join(PUBLIC, 'vendor')) || /\.(css|js|woff2?|ttf|otf)$/i.test(file)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
    const out = maybeGzip(res, mime, data);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(out);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

// ── 受保护接口统一鉴权 ──
async function requireUser(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) { sendJson(res, 401, { error: '未登录' }); return null; }
  return user;
}

// ── 匿名频次限制（防刷 LLM 额度，持久化到 DB）──
const CHART_RATE_LIMIT = 20;
const CHART_RATE_WINDOW_MS = 3600 * 1000;
async function checkChartRate(ip) {
  const r = await query('SELECT cnt, window_start FROM anon_chart_rate WHERE ip=$1', [ip]);
  const now = Date.now();
  if (r.rowCount === 0) {
    await query('INSERT INTO anon_chart_rate(ip, cnt, window_start) VALUES($1,1,now())', [ip]);
    return { ok: true, remaining: CHART_RATE_LIMIT - 1 };
  }
  const { cnt, window_start } = r.rows[0];
  const ws = new Date(window_start).getTime();
  if (now - ws > CHART_RATE_WINDOW_MS) {
    await query('UPDATE anon_chart_rate SET cnt=1, window_start=now() WHERE ip=$1', [ip]);
    return { ok: true, remaining: CHART_RATE_LIMIT - 1 };
  }
  if (cnt >= CHART_RATE_LIMIT) {
    const resetIn = Math.ceil((CHART_RATE_WINDOW_MS - (now - ws)) / 60000);
    return { ok: false, remaining: 0, resetIn };
  }
  await query('UPDATE anon_chart_rate SET cnt=cnt+1 WHERE ip=$1', [ip]);
  return { ok: true, remaining: CHART_RATE_LIMIT - cnt - 1 };
}

// I3 · 旧 checkChatGuest（仅游客限 3）已由统一 checkAiQuota 取代（见 handleChat）。
// 统一配额同时覆盖 guest(3/日) 与 user(30/日-if-paid)，并修复「终身 3 轮」硬伤。

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}

// ── 首页（万年历 + 今日运势 + 天气 + 阴阳；游客可免登录浏览） ──
async function handleHome(req, res) {
  // I0 · 拆登录墙：游客（匿名）可直接浏览首页全部内容；
  // 仅排盘 / AI 时才需登录（由对应接口负责 fail-open 引导，本接口不拦截游客）。
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  const isGuest = ctx.isGuest;
  const user = ctx.user;
  const { dateStr } = todayInShanghai();
  const [y, m] = dateStr.split('-').map(Number);
  const monthGrid = buildMonthGrid(y, m, dateStr);
  let fortune;
  if (!isGuest && user) {
    // 5.3：四元运势需要「日主天干 + 月令地支」。二者只由出生日期决定（与时辰无关），
    // 因此没填时辰、没排过盘的用户同样可以个性化：优先读已存字段，缺失则由出生日期现算并回填。
    let natal = (user.day_stem && user.month_zhi)
      ? { dayStem: user.day_stem, monthZhi: user.month_zhi, gender: user.gender }
      : deriveNatalFromBirth(user.birth_date, user.birth_calendar);
    if (natal && !user.day_stem) {
      updateProfile(user.id, { day_stem: natal.dayStem, month_zhi: natal.monthZhi }).catch(() => {});
    }
    fortune = buildTodayFortune(
      user.day_master ? { dayMasterElement: user.day_master } : null, dateStr, natal);
  } else {
    // 游客态：无命盘，展示通用运势（前端降级展示，不报错）
    fortune = buildTodayFortune(null, dateStr, null);
  }
  // 优先用前端传来的经纬度（当前定位），否则回退用户城市 / 北京
  const u = new URL(req.url, 'http://x');
  const lat = u.searchParams.get('lat'), lon = u.searchParams.get('lon');
  const haveLL = lat != null && lon != null
    && Number(lat) >= -90 && Number(lat) <= 90 && Number(lon) >= -180 && Number(lon) <= 180;
  let weather = null;
  try {
    if (haveLL) weather = await getWeatherByLatLon(Number(lat), Number(lon));
    else if (!isGuest && user?.weather_city) weather = await getWeather(user.weather_city);
    else weather = await getWeather('北京');
  } catch (e) { weather = { error: e.message }; }
  sendJson(res, 200, {
    user: user ? { nickname: user.nickname, username: user.username, weatherCity: user.weather_city } : null,
    isGuest,
    today: dateStr,
    monthGrid, monthLabel: `${y}年${m}月`,
    fortune, weather,
  });
}

/**
 * 5.3 埋点：记录「运势卡片展开为什么」。
 * 驱动指标 = 展开「为什么」的人数 / 运势卡片曝光人数。
 * 埋点失败不应影响用户使用，故数据库异常也返回 200。
 */
async function handleFortuneExpand(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  try {
    await query(
      `INSERT INTO fortune_events (user_id, anon_id, action) VALUES ($1,$2,'expand_why')`,
      [ctx.isGuest ? null : ctx.user.id, ctx.isGuest ? ctx.anonId : null]
    );
  } catch { /* 埋点失败静默忽略 */ }
  sendJson(res, 200, { ok: true });
}

// ── 万年历指定月份网格（无需鉴权，纯历法） ──
async function handleCalendar(req, res) {
  const u = new URL(req.url, 'http://x');
  const y = Number(u.searchParams.get('y')) || todayInShanghai().y;
  const m = Number(u.searchParams.get('m')) || todayInShanghai().m;
  const grid = buildMonthGrid(y, m, todayInShanghai().dateStr);
  sendJson(res, 200, { grid, today: todayInShanghai().dateStr });
}

// ── 排盘 + 存档（支持游客匿名）──
async function handleChart(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  // 游客频次限制：同 IP 每小时 ≤ 20 次排盘（防刷 LLM 额度）
  if (ctx.isGuest) {
    const rate = await checkChartRate(clientIp(req)).catch(() => ({ ok: true, remaining: 99 }));
    if (!rate.ok) {
      return sendJson(res, 429, { needLogin: true, error: `游客排盘过于频繁，请约 ${rate.resetIn} 分钟后再试；或登录后不限次数` });
    }
  }
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    const out = await computeAll(body, {
      fortune: body.fortune || undefined,
      interpret: { currentYear: body.currentYear, today: body.today },
    });
    const slim = {
      chart: {
        input: out.chart.input, pillars: out.chart.pillars, dayMaster: out.chart.dayMaster,
        lunarTimeText: out.chart.lunarTimeText, trueSolarTime: out.chart.trueSolarTime,
        pillarsData: out.chart.pillarsData, natal: out.chart.natal,
      },
      fortune: { years: out.fortune.result.years, months: out.fortune.result.months, dayun: out.fortune.natal?.大运 },
      interpret: out.interpret,
      reportHtml: out.reportHtml,
      chartContext: chartContextText(out.chart, out.interpret),
    };
    const title = body.title || `${out.chart.pillars.join(' ')} 命盘`;
    let chartId = null;
    if (ctx.isGuest) {
      // 游客：匿名存档（user_id 留空），注册后可并入账号
      const r = await query(
        `INSERT INTO charts (user_id, anon_id, title, input, chart, interpret, fortune, report_html)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [ctx.anonId, title, JSON.stringify(body),
         JSON.stringify(slim.chart), JSON.stringify(out.interpret), JSON.stringify(slim.fortune), out.reportHtml]
      );
      chartId = r.rows[0].id;
    } else {
      const r = await query(
        `INSERT INTO charts (user_id, title, input, chart, interpret, fortune, report_html)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.user.id, title, JSON.stringify(body),
         JSON.stringify(slim.chart), JSON.stringify(out.interpret), JSON.stringify(slim.fortune), out.reportHtml]
      );
      chartId = r.rows[0].id;
      // 同步出生信息 / 日主五行到用户资料（首次或补全）
      const patch = {};
      if (!ctx.user.birth_date && body.date) {
        patch.birth_calendar = body.calendar === 'lunar' ? 2 : 1;
        patch.birth_date = body.date; patch.birth_time = body.time || null; patch.birth_location = body.location || null;
      }
      patch.day_master = out.chart.dayMaster ? elementOfDayMaster(out.chart.dayMaster) : ctx.user.day_master;
      // 5.3：四元运势所需。pillars 顺序为 年/月/日/时，故 pillars[1][1] 即月令地支
      if (out.chart.dayMaster) patch.day_stem = out.chart.dayMaster;
      if (out.chart.pillars?.[1]?.[1]) patch.month_zhi = out.chart.pillars[1][1];
      await updateProfile(ctx.user.id, patch).catch(() => {});
    }
    sendJson(res, 200, { ...slim, guest: ctx.isGuest, id: chartId });
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
}

const DM_ELEMENT = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
function elementOfDayMaster(dm) { return DM_ELEMENT[dm] || null; }

async function handleChartsList(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  if (ctx.isGuest) return sendJson(res, 200, { charts: [] }); // 游客看不到历史列表
  const r = await query(
    `SELECT id, title, created_at, chart->'pillars' AS pillars
     FROM charts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [ctx.user.id]);
  sendJson(res, 200, { charts: r.rows });
}
async function handleChartGet(req, res, id) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  if (ctx.isGuest) return sendJson(res, 403, { error: '请登录后查看历史命盘' });
  const r = await query(`SELECT * FROM charts WHERE id=$1 AND user_id=$2`, [id, ctx.user.id]);
  if (r.rowCount === 0) return sendJson(res, 404, { error: '未找到' });
  const c = r.rows[0];
  sendJson(res, 200, {
    id: c.id, title: c.title, created_at: c.created_at,
    chart: c.chart, interpret: c.interpret, fortune: c.fortune, reportHtml: c.report_html,
    chartContext: chartContextText(c.chart, c.interpret),
  });
}

// ── 大模型问答流式代理（5.2：会话持久化）──
const CHAT_HISTORY_ROUNDS = 20; // 上下文窗口：最近 20 轮（40 条）
function estTokens(text) { return Math.max(1, Math.ceil((text || '').length / 4)); }

/** 解析或创建会话：优先用 conversationId；否则按（归属, chart_id）找/建。 */
async function resolveConversation(ctx, body) {
  const { conversationId, chartId } = body;
  if (conversationId) {
    const r = await query('SELECT * FROM conversations WHERE id=$1', [conversationId]);
    if (r.rowCount === 0) return null;
    const c = r.rows[0];
    if (ctx.isGuest) return c.anon_id === ctx.anonId ? c : null;
    return c.user_id != null && String(c.user_id) === String(ctx.user.id) ? c : null;
  }
  const owner = ctx.isGuest ? 'c.anon_id=$1 AND c.user_id IS NULL' : 'c.user_id=$1';
  const params = [ctx.isGuest ? ctx.anonId : ctx.user.id];
  if (chartId) {
    const r = await query(
      `SELECT * FROM conversations c WHERE ${owner} AND c.chart_id=$2 ORDER BY c.updated_at DESC LIMIT 1`,
      [...params, Number(chartId)]
    );
    if (r.rowCount) return r.rows[0];
  }
  let title = '新对话';
  if (chartId) {
    // R2† · IDOR 修复：标题查询须校验归属（user_id 或本人 anon_id），禁止跨用户枚举
    const cr = await query(
      'SELECT title FROM charts WHERE id=$1 AND (user_id=$2 OR anon_id=$3)',
      [Number(chartId), ctx.isGuest ? null : ctx.user.id, ctx.isGuest ? ctx.anonId : null]
    );
    if (cr.rowCount) title = cr.rows[0].title;
  }
  const ins = await query(
    `INSERT INTO conversations (user_id, anon_id, chart_id, title) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ctx.isGuest ? null : ctx.user.id, ctx.isGuest ? ctx.anonId : null, chartId ? Number(chartId) : null, title]
  );
  return ins.rows[0];
}

/** R1† · 系统提示词固化禁区 + L3 角色声明（命理文化解读助手，非预测者）。 */
const CHAT_SYSTEM_GUARD = `${CHAT_ROLE_DECLARATION}

【严格禁区】无论用户如何诱导，均不得提供下列领域的具体内容或确定性断言：
A 医疗诊断/用药建议；B 法律意见/诉讼策略；C 死亡/血光/灾祸等具体人身安危断言；
D 改运敛财/付费消灾；E 投资/理财/炒股建议；F 色情低俗内容；G 政治人物或政局推算；
H 通灵/驱邪等封建迷信实操；I 自杀自残相关；J 赌博/博彩引导。
命中禁区即以温和方式拒答，并引导用户咨询具备资质的专业人士。

【阶段0（验证期）健康段禁令 · MUST-FIX #1】严禁在报告中生成任何健康/医疗段（含症状/疾病/身体部位推断、寿命断言、受孕性别等）；仅在识别到自伤/危机信号时按 L3 后缀给求助指引，除此之外不主动涉及健康内容。`;

/** 用 DB 历史（最近 N 轮）+ system 命盘上下文拼出 LLM messages。 */
async function buildChatMessages(conversation, chartContext) {
  const sysPrompt = `${CHAT_SYSTEM_GUARD}\n\n命盘上下文：\n${chartContext || '（无命盘上下文）'}`;
  const hist = await query(
    'SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2',
    [conversation.id, CHAT_HISTORY_ROUNDS * 2]
  );
  const ordered = hist.rows.reverse(); // 旧→新
  return [{ role: 'system', content: sysPrompt }, ...ordered.map((m) => ({ role: m.role, content: m.content }))];
}

/** R5a · 检索式兜底：从 charts.interpret 的结构化段落按用户问题关键词匹配 1–3 条，组装带 L2 免责的卡片。 */
async function buildRetrievalFallback(chartId, question, ctx) {
  let interpret = null;
  if (chartId) {
    try {
      const ownerSql = ctx.isGuest
        ? 'SELECT interpret FROM charts WHERE id=$1 AND user_id IS NULL AND anon_id=$2'
        : 'SELECT interpret FROM charts WHERE id=$1 AND user_id=$2';
      const params = ctx.isGuest ? [Number(chartId), ctx.anonId] : [Number(chartId), ctx.user.id];
      const r = await query(ownerSql, params);
      interpret = r.rows[0]?.interpret || null;
    } catch (e) { console.warn('[fallback] 读取 interpret 失败：', e.message); }
  }
  const header = '### 🔍 AI 实时答疑暂时不可用\n\n以下是你命盘中与问题**最相关**的部分（由**规则/检索生成**，非 AI 实时作答）：';
  // 中文 2-gram 关键词，用于匹配领域
  const clean = String(question || '').replace(/[^\u4e00-\u9fffA-Za-z]/g, '');
  const grams = [];
  for (let i = 0; i < clean.length - 1; i++) grams.push(clean.slice(i, i + 2));
  const scoreDomain = (d) => {
    const text = `${d.name || ''} ${d.summary || ''} ${(d.points || []).join(' ')}`;
    let s = 0;
    for (const g of grams) if (text.includes(g)) s++;
    if (question && String(question).includes(d.name || '')) s += 3;
    return s;
  };
  let picks = [];
  if (interpret && Array.isArray(interpret.domains)) {
    picks = interpret.domains.map((d) => ({ d, s: scoreDomain(d) }))
      .sort((a, b) => b.s - a.s).filter((x) => x.s > 0).slice(0, 3).map((x) => x.d);
    if (picks.length === 0) picks = interpret.domains.slice(0, 2); // 无命中则兜底取前 2 个
  }
  const parts = [];
  for (const d of picks) {
    const pts = (d.points || []).filter(Boolean);
    parts.push(`**${d.icon || '◈'} ${d.name || '命理要点'}**\n${d.summary || ''}` + (pts.length ? '\n- ' + pts.join('\n- ') : ''));
  }
  // 大运 / 流年补充（容错，缺字段不崩）
  try {
    if (interpret?.currentDayun) {
      const cd = interpret.currentDayun;
      parts.push(`**📅 当前大运**\n${cd.ganzhi || ''}大运 ${cd.stemGod || ''}当令：${cd.headline || ''}`);
    }
    if (Array.isArray(interpret?.liunian)) {
      const cl = interpret.liunian.find((y) => y.isCurrent) || interpret.liunian[0];
      if (cl) parts.push(`**🗓 今年流年（${cl.year || ''}）**\n${cl.ganzhi || cl.ganji || ''}：${cl.headline || ''}`);
    }
  } catch {}
  const body = parts.join('\n\n') || '（暂无可检索的命盘结构化内容，请稍后重试或重新推演命盘）';
  return `${header}\n\n${body}\n\n> ${DISCLAIMER_L2}\n\n> 本内容由**规则/检索生成**，仅供文化研究与娱乐参考；如需针对性解读，请点击「重试」或稍后再问。`;
}

/** R5a · 以 SSE 形式下发检索式兜底卡片（与正常流式共用前端解析契约，前端识别 fallback 字段）。 */
function emitFallbackSSE(res, card, conversationId) {
  applySecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive',
    ...(conversationId ? { 'X-Conversation-Id': String(conversationId) } : {}),
  });
  res.write(`data: ${JSON.stringify({ fallback: true, card, disclaimer: DISCLAIMER_L2, retry: true })}\n\n`);
  res.write(`data: [DONE]\n\n`);
  res.end();
}

/**
 * P1-7 · AI 成本护栏：计算该用户/游客当日已消耗 token，按三档降级。
 * 当日边界用 PG 的 date_trunc('day', now()) 计算，避免 JS Date 本地时区与 PG 会话时区不一致导致的偏移。
 *
 * 规则（fail-open：任何异常都返回 null 放行，绝不让用户看到 500/拦截）：
 *   - 用量 ≥ 80% 且 < 100%：仅 console.warn 记一条（非阻塞）；
 *   - 观察期（OBSERVE_ONLY=true，默认）：只计量、不节流、不拦截；
 *   - ≥ 100% 且 < 120%：返回 429 + 软提示"今日 AI 解读额度已用尽，明日恢复"；
 *   - ≥ 120%：返回 429 + 同一硬提示（停止新对话）。
 *
 * 返回 null 表示放行；返回 { code, message } 表示应直接 429 拦截。
 */
/**
 * P0-9 · 输入侧硬拦截拒答：对已命中 A–J 内容禁区的用户输入，在 SSE 流启动前直接下发合规拒答。
 * 与输出侧 SSE 拒答契约一致（前端统一走 j.blocked 渲染），不进 AI、不落 messages。
 * @param {import('http').ServerResponse} res
 * @param {string} category 命中类别 key（A–J）
 */
function emitRefusalSSE(res, category) {
  applySecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ error: getRefusal(category), blocked: true, category })}\n\n`);
  res.write(`data: [DONE]\n\n`);
  res.end();
}

async function checkAiBudget(ctx) {
  try {
    const used = await query(
      `SELECT COALESCE(SUM(tokens),0)::bigint AS t FROM ai_audit
       WHERE created_at > date_trunc('day', now()) AND (user_id = $1 OR anon_id = $2)`,
      [ctx.user ? ctx.user.id : null, ctx.isGuest ? ctx.anonId : null]
    );
    const usedTokens = Number(used.rows[0]?.t || 0);
    const ratio = usedTokens / AI_DAILY_TOKEN_CAP;
    if (ratio >= 0.8 && ratio < 1) {
      console.warn('[budget] AI 当日用量达 %.0f%%（%d/%d），接近上限', ratio * 100, usedTokens, AI_DAILY_TOKEN_CAP);
    }
    if (OBSERVE_ONLY) return null; // 观察期：仅计量不拦截
    if (ratio >= 1) {
      const hard = ratio >= 1.2;
      console.warn('[budget] AI 当日用量%s（%d/%d，ratio=%.2f）',
        hard ? '已超 120%（硬拦截）' : '已用尽', usedTokens, AI_DAILY_TOKEN_CAP, ratio);
      return { code: 429, message: '今日 AI 解读额度已用尽，明日恢复。' };
    }
    return null;
  } catch (e) {
    console.error('[budget] 计量异常，fail-open 放行：', e.message);
    return null;
  }
}

async function handleChat(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const message = body.message;
  if (!message || !message.content || !String(message.content).trim()) {
    return sendJson(res, 400, { error: '缺少对话内容' });
  }
  const { chartId, chartContext, conversationId } = body;
  // P0-6 · 统一配额（guest 3/日、user 30/日-if-paid），原子 UPSERT 计数；超限 402 + paywall。
  // 必须排在「内容禁区硬拦截」之前：每次有效请求都计一轮，确保第 N+1 轮被服务端强制拦截
  // （test-paywall 核心命题「前端限制不算数」——绕过前端直连 API 仍被服务端 402）。
  const quota = await checkAiQuota(ctx).catch(() => ({
    ok: true, remaining: FREE_DAILY_ROUNDS, limit: FREE_DAILY_ROUNDS, isPaid: false, paywall: false,
  }));
  if (!quota.ok) {
    return sendJson(res, 402, {
      paywall: true,
      needLogin: ctx.isGuest,             // 游客 → 引导登录
      upgradeRequired: !ctx.isGuest,      // 已登录免费用户 → 引导升级
      remaining: quota.remaining,
      limit: quota.limit,
      error: ctx.isGuest
        ? '免费问答已达 3 轮/日上限，登录后即可继续追问 👇'
        : '今日 AI 额度已用尽，升级会员解锁每日 30 轮问答 👑',
    });
  }
  // P0-9 · 高风险倾向判定（健康/投资/法律）。仅作"倾向"识别，不做确定性断言，避免正常命理问答被误杀。
  const highRisk = isHighRisk(message.content);
  // P0-9 · 输入侧硬拦截：命中 A–J 内容禁区（现有 isBlocked）直接拒答，不进 AI、不落 messages
  const inputBlock = isBlocked(message.content);
  if (inputBlock.hit) {
    console.log('[chat] 输入命中内容禁区 %s，硬拦截拒答', inputBlock.category);
    return emitRefusalSSE(res, inputBlock.category);
  }
  // 配置优先级：管理员服务端配置 > 环境变量（前端不再传入密钥，避免泄露）
  const srv = loadLlmConfig();
  const baseUrl = (srv?.baseUrl || process.env.LLM_BASE_URL || '').trim();
  const apiKey = (srv?.apiKey || process.env.LLM_API_KEY || '').trim();
  const model = (srv?.model || process.env.LLM_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) {
    // R5a · 配置缺失也走检索式兜底，不白屏不 500
    return emitFallbackSSE(res, await buildRetrievalFallback(chartId, message.content, ctx));
  }
  // P1-7 · AI 成本护栏（fail-open：异常/观察期均放行，仅超限且非观察期才 429）
  const budget = await checkAiBudget(ctx);
  if (budget) return sendJson(res, budget.code, { error: budget.message });
  // 解析 / 创建会话
  const conversation = await resolveConversation(ctx, body);
  if (!conversation) return sendJson(res, 403, { error: '无法访问该会话' });
  // 落库用户消息
  await query('INSERT INTO messages (conversation_id, role, content, tokens) VALUES ($1,$2,$3,$4)',
    [conversation.id, 'user', message.content, estTokens(message.content)]);
  await query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversation.id]);

  const userIdForAudit = ctx.user ? ctx.user.id : null;
  const anonIdForAudit = ctx.isGuest ? ctx.anonId : null;
  const inputSnippet = String(message.content).slice(0, 500);
  let isFallback = false, fallbackCard = '';
  let blocked = false, blockedCategory = null;
  let auditOutput = '';

  const llmMessages = await buildChatMessages(conversation, chartContext);
  const payload = { model, stream: true, messages: llmMessages, temperature: 0.7 };
  const upstreamCtrl = new AbortController();
  const t0 = Date.now();
  console.log('[chat] enter uid=%s conv=%s model=%s', ctx.user ? ctx.user.id : ('anon:' + ctx.anonId), conversation.id, model);
  let upstream;
  try {
    upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      // R5a · 30s 上游超时上限（额度耗尽/卡死时快速降级到检索式兜底）
      signal: AbortSignal.any([upstreamCtrl.signal, AbortSignal.timeout(30000)]),
    });
  } catch (e) {
    console.log('[chat] upstream fetch failed after %dms: %s', Date.now() - t0, e.message);
    // R5a · 上游连不上/超时 → 检索式兜底，不 500
    return emitFallbackSSE(res, await buildRetrievalFallback(chartId, message.content, ctx), conversation.id);
  }
  console.log('[chat] upstream status=%d in %dms', upstream.status, Date.now() - t0);
  // 客户端断开立刻终止上游，避免挂死
  req.on('close', () => {
    if (!res.writableEnded) {
      console.log('[chat] client closed, abort upstream');
      try { upstreamCtrl.abort(); } catch {}
      try { res.end(); } catch {}
    }
  });
  if (!upstream.ok || !upstream.body) {
    let detail = ''; try { detail = await upstream.text(); } catch {}
    console.log('[chat] upstream not ok: %d %s', upstream.status, detail.slice(0,200));
    // R5a · 上游返回非 200 → 检索式兜底，不静默报错
    return emitFallbackSSE(res, await buildRetrievalFallback(chartId, message.content, ctx), conversation.id);
  }
  applySecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive',
    'X-Conversation-Id': String(conversation.id), // 前端据此绑定会话
  });
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let chunkN = 0;
  let full = '';
  const flush = () => {
    if (!buf) return;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') { if (!blocked) res.write(`data: [DONE]\n\n`); continue; }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (!delta) continue;
        if (blocked) continue; // 已命中禁区，丢弃后续违规内容
        // R1† · 输出侧过滤：命中 §6.1 禁区立即中止该轮，下发拒答，不返回违规内容
        const { hit, category } = isBlocked(full + delta);
        if (hit) {
          blocked = true; blockedCategory = category;
          try { upstreamCtrl.abort(); } catch {}
          console.log('[chat] 命中内容禁区 %s，中止输出', category);
          res.write(`data: ${JSON.stringify({ error: getRefusal(category), blocked: true, category })}\n\n`);
          res.write(`data: [DONE]\n\n`);
          return;
        }
        full += delta;
        auditOutput = full;
        chunkN++;
        if (chunkN <= 3 || chunkN % 20 === 0) console.log('[chat] chunk#%d t=%dms len=%d', chunkN, Date.now() - t0, delta.length);
        res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
      } catch {}
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      flush();
    }
    flush();
    // R5a · 200 但空流（额度耗尽/上游返回空）：下发检索式兜底，避免静默空白
    if (chunkN === 0 && !blocked) {
      fallbackCard = await buildRetrievalFallback(chartId, message.content, ctx);
      isFallback = true;
      res.write(`data: ${JSON.stringify({ fallback: true, card: fallbackCard, disclaimer: DISCLAIMER_L2, retry: true })}\n\n`);
    }
    // P0-9 · 输出侧软改写：正常流末追加免责后缀 event（视觉区分由前端渲染，不混入 AI 正文）
    // 基线 L2 必带；高风险（健康/投资/法律倾向，high_risk）在 L2 基础上追加 L3（见 COMPLIANCE-WORDING.md §二）。
    // 空流兜底已自带 disclaimer 字段，此处仅对真实 AI 流追加，避免重复。
    if (!blocked && !isFallback) {
      res.write(`data: ${JSON.stringify({ type: 'disclaimer', level: 'L2', text: DISCLAIMER_L2 })}\n\n`);
      if (highRisk) res.write(`data: ${JSON.stringify({ type: 'disclaimer', level: 'L3', text: DISCLAIMER_L3 })}\n\n`);
    }
    res.write(`data: [DONE]\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  } finally {
    // 落库 assistant 消息（即使客户端中断也尽量保留已生成部分；命中禁区则存拒答而非违规内容）
    let assistantContent = full;
    if (blocked) { assistantContent = getRefusal(blockedCategory); auditOutput = assistantContent; }
    else if (isFallback) { assistantContent = fallbackCard; auditOutput = fallbackCard; }
    if (assistantContent) {
      await query('INSERT INTO messages (conversation_id, role, content, tokens) VALUES ($1,$2,$3,$4)',
        [conversation.id, 'assistant', assistantContent, estTokens(assistantContent)]).catch(() => {});
      await query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversation.id]).catch(() => {});
    }
    // R1† · AI 输出留痕（V3，留存 ≥6 月）
    const auditTokens = assistantContent ? estTokens(assistantContent) : 0;
    await query(
      `INSERT INTO ai_audit (user_id, anon_id, conversation_id, model, input_snippet, output_snippet, blocked, category, tokens, high_risk)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [userIdForAudit, anonIdForAudit, conversation.id, model, inputSnippet, String(auditOutput).slice(0, 2000), blocked, blockedCategory, auditTokens, highRisk]
    ).catch((e) => console.error('[aiaudit] 写入失败：', e.message));
    res.end();
  }
}

// ── 对话历史读取（5.2）──
async function handleConversationsList(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  const chartId = new URL(req.url, 'http://x').searchParams.get('chartId');
  if (ctx.isGuest) return sendJson(res, 403, { error: '请登录后查看对话历史' });
  // 按 chart_id 取该盘对应会话（含全部消息）
  if (chartId) {
    const r = await query(
      `SELECT c.id, c.title, c.chart_id, c.created_at, c.updated_at,
              (SELECT json_agg(json_build_object('role', m.role, 'content', m.content, 'created_at', m.created_at)
               ORDER BY m.created_at)
               FROM messages m WHERE m.conversation_id = c.id) AS messages
       FROM conversations c WHERE c.user_id=$1 AND c.chart_id=$2 ORDER BY c.updated_at DESC LIMIT 1`,
      [ctx.user.id, Number(chartId)]
    );
    if (r.rowCount === 0) return sendJson(res, 200, { conversation: null });
    return sendJson(res, 200, { conversation: r.rows[0] });
  }
  // 最近会话列表（驱动指标用）
  const r = await query(
    `SELECT c.id, c.title, c.chart_id, c.updated_at,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_msg
     FROM conversations c WHERE c.user_id=$1 ORDER BY c.updated_at DESC LIMIT 30`,
    [ctx.user.id]
  );
  sendJson(res, 200, { conversations: r.rows });
}

// ── 管理员 LLM 配置（加密接口，需令牌）──
async function handleAdminLlm(req, res) {
  if (!ADMIN_TOKEN) {
    return sendJson(res, 403, { error: '管理员令牌未启用（请设置 ADMIN_TOKEN 或 data/admin.token）' });
  }
  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams.get('token') || '';
    if (q !== ADMIN_TOKEN) return sendJson(res, 401, { error: '管理员令牌错误' });
    const cfg = loadLlmConfig();
    return sendJson(res, 200, {
      configured: !!cfg,
      baseUrl: cfg?.baseUrl || '',
      model: cfg?.model || '',
      apiKeyMask: cfg ? maskKey(cfg.apiKey) : '',
      updatedAt: cfg?.updatedAt || null,
    });
  }
  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if ((body.token || '') !== ADMIN_TOKEN) return sendJson(res, 401, { error: '管理员令牌错误' });
    const { baseUrl, apiKey, model } = body;
    if (!baseUrl || !model) {
      return sendJson(res, 400, { error: 'baseUrl、model 为必填' });
    }
    let finalKey = apiKey || '';
    if (!finalKey) {
      const cur = loadLlmConfig();
      if (cur && cur.apiKey) finalKey = cur.apiKey; // 留空 = 保留原密钥
    }
    if (!finalKey) {
      return sendJson(res, 400, { error: '首次配置必须填写 apiKey' });
    }
    saveLlmConfig({ baseUrl, apiKey: finalKey, model });
    console.log('[admin] LLM 配置已更新');
    return sendJson(res, 200, { ok: true, apiKeyMask: maskKey(apiKey) });
  }
  return sendJson(res, 405, { error: '方法不允许' });
}

// ── 健康检查（R4† · 线上==HEAD 校验 + 可观测）──
async function handleHealth(req, res) {
  let dbOk = false;
  try { await query('SELECT 1'); dbOk = true; } catch (e) { console.warn('[health] DB 探活失败：', e.message); }
  sendJson(res, 200, { ok: dbOk, version: APP_VERSION, commit: GIT_COMMIT, ts: new Date().toISOString() });
}

// ── 认证路由 ──
async function handleRegister(req, res) {
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    const u = await register(body);
    const { token, expiresAt } = await createSession(u.id);
    res.setHeader('Set-Cookie', cookieFor(token, expiresAt, isSecureReq(req)));
    // 合并游客匿名命盘到新账号，并清除匿名 cookie
    const merged = await claimAnonIfPresent(req, res, u.id);
    sendJson(res, 200, { user: u, merged });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}
async function handleLogin(req, res) {
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    const u = await login(body);
    const { token, expiresAt } = await createSession(u.id);
    res.setHeader('Set-Cookie', cookieFor(token, expiresAt, isSecureReq(req)));
    // 登录已有账号也并入游客匿名命盘（5.1：保存此命盘到我的账号）
    await claimAnonIfPresent(req, res, u.id);
    sendJson(res, 200, { user: u });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}
async function handleLogout(req, res) {
  await destroySession(req);
  res.setHeader('Set-Cookie', `cl_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
  sendJson(res, 200, { ok: true });
}
async function handleMe(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  // P0-6 · 回带付费态；异常 → 免费态（fail-open，绝不让用户看到 500）
  let plan = 'free', entitlementExpiresAt = null;
  try {
    const ent = await getEntitlement(user.id);
    if (ent) {
      plan = 'paid';
      entitlementExpiresAt = ent.expiresAt ? new Date(ent.expiresAt).toISOString() : null;
    }
  } catch { /* fail-open：保持免费态 */ }
  sendJson(res, 200, { user: { ...user, plan, entitlementExpiresAt } });
}

// ── I3 · 配额查询（P0-6）：返回剩余轮次 + 上限 + 付费态 ──
async function handleQuota(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  const info = await getQuotaInfo(ctx);
  sendJson(res, 200, {
    remaining: info.remaining,
    limit: info.limit,
    isPaid: info.isPaid,
    plan: info.plan,
  });
}

// ── I3 · 兑换码原子核销（P0-7）──
async function handleRedeem(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  // 注：前端限制不算数；游客亦可核销（grantee_type='anon_id'），核心命题在「原子核销防重兑」与「付费 flag 服务端生效」。
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const code = String(body?.code || '').trim();
  if (!code) return sendJson(res, 400, { error: '缺少兑换码', code: 'INVALID' });

  const granteeType = ctx.isGuest ? 'anon_id' : 'user_id';
  const granteeId = ctx.isGuest ? ctx.anonId : String(ctx.user.id);

  try {
    // 原子核销：仅 status='unused' 且未过期方可核销（WHERE 子句同时防重兑 + 过期拒）
    const upd = await query(
      `UPDATE redeem_codes
       SET status='used', redeemed_at=now(), redeemed_by=$2
       WHERE code=$1 AND status='unused' AND (valid_until IS NULL OR valid_until > now())
       RETURNING code, plan, duration_days`,
      [code, granteeId],
    );
    if (upd.rowCount === 0) {
      // 未命中原子核销 → 区分原因返回语义化错误码
      const ex = await query('SELECT status, valid_until FROM redeem_codes WHERE code=$1', [code]);
      if (ex.rowCount === 0) return sendJson(res, 404, { error: '兑换码不存在或无效', code: 'INVALID' });
      const row = ex.rows[0];
      if (row.status === 'used') return sendJson(res, 400, { error: '兑换码已被使用', code: 'USED' });
      if (row.valid_until && new Date(row.valid_until).getTime() < Date.now()) {
        return sendJson(res, 400, { error: '兑换码已过期', code: 'EXPIRED' });
      }
      return sendJson(res, 400, { error: '兑换码不可用', code: 'INVALID' });
    }
    const c = upd.rows[0];
    const plan = c.plan || 'year';
    const duration = Number(c.duration_days) || 365;
    const expiresAt = new Date(Date.now() + duration * 86400000);
    // 写付费授权（权威来源）
    await query(
      `INSERT INTO entitlement_grants (grantee_type, grantee_id, plan, granted_at, expires_at, source_code)
       VALUES ($1, $2, $3, now(), $4, $5)`,
      [granteeType, granteeId, plan, expiresAt, code],
    );
    // 埋点 redeem_success（失败静默忽略）
    await query(
      'INSERT INTO events (action, payload, user_id) VALUES ($1, $2, $3)',
      ['redeem_success', { plan, code, durationDays: duration }, ctx.isGuest ? null : ctx.user.id],
    ).catch(() => {});
    sendJson(res, 200, {
      ok: true, plan, expiresAt: expiresAt.toISOString(), isPaid: true,
      granteeType,
    });
  } catch (e) {
    // 核销写库异常 → 返回 500（不静默授予；明确安全硬拦截例外）
    console.error('[redeem] 核销异常：', e.message);
    sendJson(res, 500, { error: '兑换处理失败，请稍后再试', code: 'ERROR' });
  }
}

// ── I3 · 管理端发码（P0-7，ADMIN_TOKEN 保护，复用 /api/admin/llm 校验写法）──
// 兼容三种令牌来源：Authorization: Bearer / body.token / ?token=
function resolveAdminToken(req, body) {
  const authz = req.headers['authorization'] || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = new URL(req.url, 'http://x').searchParams.get('token') || '';
  if (q) return q;
  if (body && body.token) return String(body.token);
  return '';
}
// 归一化发码请求体：数组 [{code, validUntil|durationDays, plan}] / {codes:[...]} / 单对象
function normalizeCodeSpecs(body) {
  let raw = [];
  if (Array.isArray(body)) raw = body;
  else if (body && Array.isArray(body.codes)) raw = body.codes;
  else if (body && body.code) raw = [body];
  else return [];
  const out = [];
  for (const it of raw) {
    if (!it || !it.code) continue;
    const code = String(it.code).trim();
    if (!code) continue;
    let validUntil = null;
    let durationDays = 365; // 默认有效期 365 天（Edward 拍板）
    if (it.validUntil) {
      const d = new Date(it.validUntil);
      if (!isNaN(d.getTime())) validUntil = d;
    }
    if (typeof it.durationDays === 'number' && it.durationDays > 0) {
      durationDays = Math.floor(it.durationDays);
    }
    out.push({ code, plan: it.plan || 'year', durationDays, validUntil });
  }
  return out;
}
async function handleAdminRedeemCodes(req, res) {
  if (!ADMIN_TOKEN) {
    return sendJson(res, 403, { error: '管理员令牌未启用（请设置 ADMIN_TOKEN 或 data/admin.token）' });
  }
  let body = null;
  if (req.method === 'POST') {
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const token = resolveAdminToken(req, body);
  if (token !== ADMIN_TOKEN) return sendJson(res, 401, { error: '管理员令牌错误' });

  if (req.method === 'GET') {
    const r = await query(
      `SELECT code, status, plan, duration_days, created_by, created_at, redeemed_at, redeemed_by, valid_until
       FROM redeem_codes ORDER BY created_at DESC LIMIT 200`,
    ).catch(() => ({ rows: [] }));
    return sendJson(res, 200, { codes: r.rows });
  }
  if (req.method === 'POST') {
    const items = normalizeCodeSpecs(body);
    if (!items.length) return sendJson(res, 400, { error: '缺少有效的兑换码定义' });
    const created = [];
    for (const it of items) {
      // 重复码忽略（ON CONFLICT DO NOTHING），不覆盖既有码
      await query(
        `INSERT INTO redeem_codes (code, status, plan, duration_days, created_by, valid_until)
         VALUES ($1, 'unused', $2, $3, 'admin', $4)
         ON CONFLICT (code) DO NOTHING`,
        [it.code, it.plan, it.durationDays, it.validUntil],
      ).catch(() => {});
      created.push(it.code);
    }
    return sendJson(res, 200, { ok: true, createdCount: created.length, codes: created });
  }
  return sendJson(res, 405, { error: '方法不允许' });
}

// ── 密码重置通道（R0 · 认证修复后强制全量重置）──
async function handleResetRequest(req, res) {
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    const token = await requestPasswordReset(body?.username || '');
    // 统一返回 ok:true 防账号枚举；自托管/无 SMTP 时回传 token 供前端跳转重置页
    if (token && !process.env.SMTP_HOST) {
      const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
      return sendJson(res, 200, { ok: true, resetToken: token, resetUrl: `${base}/reset.html?token=${token}` });
    }
    return sendJson(res, 200, { ok: true });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}
async function handleResetConfirm(req, res) {
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    await confirmPasswordReset(body?.token || '', body?.password || '');
    sendJson(res, 200, { ok: true });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}

// ── 举报 / 投诉入口（R1-5）──
async function handleReport(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const detail = String(body?.detail || '').trim();
  if (!detail) return sendJson(res, 400, { error: '举报内容不能为空' });
  const target = ['ai', 'content', 'user'].includes(body?.target) ? body.target : 'ai';
  await query('INSERT INTO reports (user_id, anon_id, target, detail) VALUES ($1,$2,$3,$4)',
    [ctx.user ? ctx.user.id : null, ctx.isGuest ? ctx.anonId : null, target, detail.slice(0, 2000)]);
  sendJson(res, 200, { ok: true });
}

// ── 业务埋点（R3 · 单端点 + 白名单 + 基础限流；G1 可观测/漏斗）──
const TRACK_ACTIONS = new Set([
  'page_view', 'chart_done', 'report_viewed', 'fortune_expand',
  'ai_first_q', 'ai_q_fail', 'anon_to_signup', 'calendar_viewed',
  'login', 'register', 'logout',
  // I0 · 埋点骨架：拆墙 + 付费/分享漏斗新增事件（复用 /api/track 单端点）
  'pricing_viewed', 'paywall_hit', 'redeem_success',
  'login_wall_view', 'home_anon_view',
  'share_generated', 'source_self_report',
]);
const trackBuckets = new Map(); // key → 最近时间戳数组（滑动窗口 1s）
function trackAllowed(key) {
  const now = Date.now();
  const arr = (trackBuckets.get(key) || []).filter((t) => now - t < 1000);
  if (arr.length >= 30) { trackBuckets.set(key, arr); return false; }
  arr.push(now); trackBuckets.set(key, arr); return true;
}
async function handleTrack(req, res) {
  const ctx = await requireUserOrAnon(req, res); if (!ctx) return;
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const action = String(body?.action || '').trim();
  if (!action || !TRACK_ACTIONS.has(action)) return sendJson(res, 400, { error: '未知事件类型' });
  const key = ctx.user ? ('u:' + ctx.user.id) : ('a:' + (ctx.anonId || (req.socket?.remoteAddress || 'x')));
  if (!trackAllowed(key)) return sendJson(res, 429, { error: '埋点频率超限' });
  const payload = (body?.payload && typeof body.payload === 'object') ? body.payload : null;
  await query('INSERT INTO events (action, payload, user_id, anon_id) VALUES ($1,$2,$3,$4)',
    [action, payload, ctx.user ? ctx.user.id : null, ctx.isGuest ? ctx.anonId : null])
    .catch((e) => console.warn('[track] 写入失败：', e.message));
  sendJson(res, 200, { ok: true });
}

// ── CSP 违规上报（仅落日志，便于观察是否仍有被拦资源；不落库避免被滥用）──
async function handleCspReport(req, res) {
  let body;
  try { body = await readBody(req, 16 * 1024); } catch { res.writeHead(400); res.end(); return; }
  const rep = (body && typeof body === 'object') ? (body['csp-report'] || body) : null;
  if (rep) {
    console.warn('[csp-report] document=%s | directive=%s | blocked=%s',
      rep['document-uri'] || '-', rep['violated-directive'] || '-', rep['blocked-uri'] || '-');
  }
  res.writeHead(204); res.end();
}

// ── 数据权利：导出 / 一键删除（R2† · V1 数据权利闭环 / V2 孤儿删除完整性）──
async function handleExport(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  const uid = user.id;
  const linkSub = 'SELECT anon_id FROM user_anon_link WHERE user_id=$1';
  const rows = async (sql, p) => (await query(sql, p)).rows;
  const charts = await rows(`SELECT id, title, created_at FROM charts WHERE user_id=$1 OR anon_id IN (${linkSub}) ORDER BY created_at DESC`, [uid]);
  const conversations = await rows(`SELECT id, title, chart_id, created_at FROM conversations WHERE user_id=$1 OR anon_id IN (${linkSub}) ORDER BY created_at DESC`, [uid]);
  const messages = await rows(`SELECT m.id, m.conversation_id, m.role, m.content, m.created_at FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.user_id=$1 OR c.anon_id IN (${linkSub}) ORDER BY m.created_at`, [uid]);
  const fortune_events = await rows(`SELECT id, action, created_at FROM fortune_events WHERE user_id=$1 OR anon_id IN (${linkSub}) ORDER BY created_at DESC`, [uid]);
  const anon_chart_rate = await rows(`SELECT ip, cnt, window_start AS created_at FROM anon_chart_rate WHERE anon_id IN (${linkSub})`, [uid]);
  const anon_chat_rate = await rows(`SELECT anon_id, rounds FROM anon_chat_rate WHERE anon_id IN (${linkSub})`, [uid]);
  // I3 · 兑换码（redeemed_by=$uid）/ 付费授权（grantee_id=$uid 或关联游客 anon_id）
  const redeem_codes = await rows(`SELECT code, status, plan, duration_days, created_at, redeemed_at FROM redeem_codes WHERE redeemed_by=$1`, [String(uid)]);
  // I3 · grantee_id 为 TEXT（=$1），子查询 user_id 为 BIGINT（=$2，用原始数字 uid 避免 bigint=text）
  const entitlement_grants = await rows(`SELECT id, grantee_type, grantee_id, plan, granted_at, expires_at, source_code FROM entitlement_grants WHERE grantee_id=$1 OR grantee_id IN (SELECT anon_id FROM user_anon_link WHERE user_id=$2)`, [String(uid), uid]);
  sendJson(res, 200, { user, charts, conversations, messages, fortune_events, anon_chart_rate, anon_chat_rate, redeem_codes, entitlement_grants });
}

async function handleDelete(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  const uid = user.id;
  const linkSub = 'SELECT anon_id FROM user_anon_link WHERE user_id=$1';
  const cnt = async (sql, p) => Number((await query(sql, p)).rows[0].c);
  // 删除前计数（双条件口径，与 test-gdpr 一致）
  const before = {
    charts: await cnt(`SELECT count(*) c FROM charts WHERE user_id=$1 OR anon_id IN (${linkSub})`, [uid]),
    conversations: await cnt(`SELECT count(*) c FROM conversations WHERE user_id=$1 OR anon_id IN (${linkSub})`, [uid]),
    messages: await cnt(`SELECT count(*) c FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.user_id=$1 OR c.anon_id IN (${linkSub})`, [uid]),
    fortune_events: await cnt(`SELECT count(*) c FROM fortune_events WHERE user_id=$1 OR anon_id IN (${linkSub})`, [uid]),
    anon_chart_rate: await cnt(`SELECT count(*) c FROM anon_chart_rate WHERE anon_id IN (${linkSub})`, [uid]),
    anon_chat_rate: await cnt(`SELECT count(*) c FROM anon_chat_rate WHERE anon_id IN (${linkSub})`, [uid]),
    // I3 · 兑换码 / 付费授权（GDPR 双条件口径）
    redeem_codes: await cnt(`SELECT count(*) c FROM redeem_codes WHERE redeemed_by=$1`, [String(uid)]),
    entitlement_grants: await cnt(`SELECT count(*) c FROM entitlement_grants WHERE grantee_id=$1 OR grantee_id IN (SELECT anon_id FROM user_anon_link WHERE user_id=$2)`, [String(uid), uid]),
  };
  // 双条件删除六表 + 用户侧同意/映射/会话
  await query(`DELETE FROM anon_chat_rate WHERE anon_id IN (${linkSub})`, [uid]);
  await query(`DELETE FROM anon_chart_rate WHERE anon_id IN (${linkSub})`, [uid]);
  await query(`DELETE FROM fortune_events WHERE user_id=$1 OR anon_id IN (${linkSub})`, [uid]);
  await query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=$1 OR anon_id IN (${linkSub}))`, [uid]);
  await query(`DELETE FROM conversations WHERE user_id=$1 OR anon_id IN (${linkSub})`, [uid]);
  await query(`DELETE FROM charts WHERE user_id=$1 OR anon_id IN (${linkSub})`, [uid]);
  // I3 · 先删付费授权（FK source_code ON DELETE SET NULL），再删核销记录
  await query(`DELETE FROM entitlement_grants WHERE grantee_id=$1 OR grantee_id IN (SELECT anon_id FROM user_anon_link WHERE user_id=$2)`, [String(uid), uid]);
  await query(`DELETE FROM redeem_codes WHERE redeemed_by=$1`, [String(uid)]);
  await query(`DELETE FROM user_agreements WHERE user_id=$1`, [uid]);
  await query(`DELETE FROM user_anon_link WHERE user_id=$1`, [uid]);
  await query(`DELETE FROM users WHERE id=$1`, [uid]); // 级联 sessions
  sendJson(res, 200, { ok: true, ...before });
}
/** R4† · 经反代时按 x-forwarded-proto 判断是否 HTTPS，决定 cookie 是否带 Secure。 */
function isSecureReq(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
    || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'on';
}
function cookieFor(token, expiresAt, secure) {
  const exp = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return `cl_sid=${token}; Path=/; Max-Age=${exp}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** 注册 / 登录成功后，把请求中的匿名命盘并入该账号（若带 cl_aid cookie）。 */
async function claimAnonIfPresent(req, res, userId) {
  const ac = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(ANON_COOKIE_NAME + '='));
  if (!ac) return 0;
  const anonId = decodeURIComponent(ac.slice(ANON_COOKIE_NAME.length + 1));
  const merged = await mergeAnonCharts(anonId, userId).catch(() => 0);
  // 5.2：匿名对话会话一并并入账号
  await mergeAnonConversations(anonId, userId).catch(() => {});
  res.appendHeader('Set-Cookie', `${ANON_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
  return merged;
}

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const idMatch = url.match(/^\/api\/charts\/(\d+)$/);
  try {
    if (req.method === 'GET' && url === '/api/health') return await handleHealth(req, res);
    if (req.method === 'GET' && url === '/api/config') {
      // R10a：摘除 baseUrl / adminConfigured（站外不可暴露内部配置），仅留安全字段
      return sendJson(res, 200, {
        llmPreset: !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL),
        appName: '辰箓',
        icpNo: process.env.ICP_NO || '域名备案中 · 暂以 IP 访问',
        // I3 · 付费墙口径（供前端展示 + test-paywall 探测）
        aiFreeRounds: FREE_DAILY_ROUNDS,
        paidDailyRounds: PAID_DAILY_ROUNDS,
      });
    }
    if (req.method === 'GET' && url === '/api/cities') return sendJson(res, 200, { cities: listAllCities() });
    if (req.method === 'GET' && url.startsWith('/api/geocode')) {
      const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
      try {
        const info = await resolveLocation(q);
        return sendJson(res, 200, { found: true, longitude: info.longitude, label: info.label, source: info.source });
      } catch {
        return sendJson(res, 200, { found: false, label: q });
      }
    }
    if (req.method === 'POST' && url === '/api/auth/register') return await handleRegister(req, res);
    if (req.method === 'POST' && url === '/api/auth/login') return await handleLogin(req, res);
    if (req.method === 'POST' && url === '/api/auth/logout') return await handleLogout(req, res);
    if (req.method === 'GET' && url === '/api/auth/me') return await handleMe(req, res);
    // I3 · 配额查询 / 兑换码核销 / 管理端发码
    if (req.method === 'GET' && url === '/api/quota') return await handleQuota(req, res);
    if (req.method === 'POST' && url === '/api/redeem') return await handleRedeem(req, res);
    if (url === '/api/admin/redeem-codes') return await handleAdminRedeemCodes(req, res);
    if (req.method === 'POST' && url === '/api/auth/reset') return await handleResetRequest(req, res);
    if (req.method === 'POST' && url === '/api/auth/reset/confirm') return await handleResetConfirm(req, res);
    if (req.method === 'POST' && url === '/api/report') return await handleReport(req, res);
    if (req.method === 'POST' && url === '/api/track') return await handleTrack(req, res);
    if (req.method === 'POST' && url === '/api/csp-report') return await handleCspReport(req, res);
    if (req.method === 'POST' && url === '/api/me/export') return await handleExport(req, res);
    if (req.method === 'POST' && url === '/api/me/delete') return await handleDelete(req, res);
    if (req.method === 'GET' && url === '/api/home') return await handleHome(req, res);
    if (req.method === 'POST' && url === '/api/fortune/expand') return await handleFortuneExpand(req, res);
    if (req.method === 'GET' && url === '/api/calendar') return await handleCalendar(req, res);
    if (req.method === 'POST' && url === '/api/chart') return await handleChart(req, res);
    if (req.method === 'GET' && url === '/api/conversations') return await handleConversationsList(req, res);
    if (req.method === 'GET' && url === '/api/charts') return await handleChartsList(req, res);
    if (req.method === 'GET' && idMatch) return await handleChartGet(req, res, idMatch[1]);
    if (url === '/api/admin/llm') return await handleAdminLlm(req, res);
    if (req.method === 'POST' && url === '/api/chat') return await handleChat(req, res);
    // R6† · 仅暴露内容策略模块（复用 R1† 过滤链，不暴露整个 lib/）
    if (req.method === 'GET' && url === '/content-policy.js') {
      try {
        const buf = await readFile(join(__dirname, 'lib/content-policy.js'));
        applySecurityHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(buf);
      } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
    }
    if (req.method === 'GET') return await serveStatic(req, res);
    res.writeHead(405); res.end('method not allowed');
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message || String(e) });
    else res.end();
  }
});

async function main() {
  try { await initSchema(); } catch (e) {
    console.error('[pg] schema 初始化失败：', e.message);
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`辰箓 已启动： http://0.0.0.0:${PORT}`));

  // I3 · C7 进程内每日备份定时器（系统 cron 之外的双保险；fail-open，异常仅告警不阻断）
  const backupTimer = setInterval(() => {
    const backupScript = join(__dirname, 'tools', 'backup-daily.mjs');
    execFile(process.execPath, [backupScript], { timeout: 300000 }, (err) => {
      if (err) console.error('[backup] 定时备份失败（不阻断服务）：', err.message);
    });
  }, 24 * 3600 * 1000);
  backupTimer.unref(); // 不阻止进程退出（但 server.listen 已保持事件循环存活）
  // 启动后 10 分钟触发首次兜底备份（避免要等满 24h 才有首份）
  setTimeout(() => {
    execFile(process.execPath, [join(__dirname, 'tools', 'backup-daily.mjs')], { timeout: 300000 }, (err) => {
      if (err) console.error('[backup] 启动备份失败（不阻断服务）：', err.message);
    });
  }, 10 * 60 * 1000).unref();
}
main();

// P1 · 优雅关闭：停止接收新连接，释放 PG 连接池，进行中请求（含 SSE）由客户端/超时自然结束
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[%s] 收到关闭信号，开始优雅关闭…', signal);
  server.close((err) => {
    if (err) console.error('[shutdown] server.close 异常：', err.message);
    else console.log('[shutdown] 已停止接收新连接');
  });
  try {
    await pool.end();
    console.log('[shutdown] PG 连接池已关闭');
  } catch (e) {
    console.error('[shutdown] pool.end 异常：', e.message);
  }
  // 兜底：statement_timeout(8s) 保证在途查询不会无限挂起；10s 后强制退出
  const forced = setTimeout(() => { console.log('[shutdown] 超时强制退出'); process.exit(0); }, 10000);
  forced.unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
