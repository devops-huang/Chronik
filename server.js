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
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, initSchema, query } from './lib/db.js';
import {
  register, login, createSession, destroySession, getUserFromRequest, updateProfile,
  requireUserOrAnon, getAnonId, mergeAnonCharts, mergeAnonConversations, ANON_COOKIE_NAME,
} from './lib/auth.js';
import { computeAll, chartContextText } from './lib/core.js';
import { listAllCities, resolveLocation } from './lib/chart.js';
import { buildMonthGrid, buildTodayFortune, getWeather, getWeatherByLatLon, todayInShanghai } from './lib/home.js';
import { loadLlmConfig, saveLlmConfig, maskKey } from './lib/llmConfig.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 8787;

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
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
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
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
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

const CHAT_GUEST_LIMIT = 3;
async function checkChatGuest(anonId) {
  const r = await query('SELECT rounds FROM anon_chat_rate WHERE anon_id=$1', [anonId]);
  if (r.rowCount === 0) {
    await query('INSERT INTO anon_chat_rate(anon_id, rounds) VALUES($1,1)', [anonId]);
    return { ok: true, rounds: 1 };
  }
  const rounds = r.rows[0].rounds;
  if (rounds >= CHAT_GUEST_LIMIT) return { ok: false, rounds };
  await query('UPDATE anon_chat_rate SET rounds=rounds+1 WHERE anon_id=$1', [anonId]);
  return { ok: true, rounds: rounds + 1 };
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}

// ── 首页（万年历 + 今日运势 + 天气 + 阴阳） ──
async function handleHome(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  const { dateStr } = todayInShanghai();
  const [y, m] = dateStr.split('-').map(Number);
  const monthGrid = buildMonthGrid(y, m, dateStr);
  const fortune = buildTodayFortune(user.day_master ? { dayMasterElement: user.day_master } : null, dateStr);
  // 优先用前端传来的经纬度（当前定位），否则回退用户城市 / 北京
  const u = new URL(req.url, 'http://x');
  const lat = u.searchParams.get('lat'), lon = u.searchParams.get('lon');
  const haveLL = lat != null && lon != null
    && Number(lat) >= -90 && Number(lat) <= 90 && Number(lon) >= -180 && Number(lon) <= 180;
  let weather = null;
  try {
    if (haveLL) weather = await getWeatherByLatLon(Number(lat), Number(lon));
    else weather = await getWeather(user.weather_city || '北京');
  } catch (e) { weather = { error: e.message }; }
  sendJson(res, 200, {
    user: { nickname: user.nickname, username: user.username, weatherCity: user.weather_city },
    today: dateStr,
    monthGrid, monthLabel: `${y}年${m}月`,
    fortune, weather,
  });
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
function estTokens(text) { return Math.max(1, Math.ceil((text || '').length / 2)); }

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
    const cr = await query('SELECT title FROM charts WHERE id=$1', [Number(chartId)]);
    if (cr.rowCount) title = cr.rows[0].title;
  }
  const ins = await query(
    `INSERT INTO conversations (user_id, anon_id, chart_id, title) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ctx.isGuest ? null : ctx.user.id, ctx.isGuest ? ctx.anonId : null, chartId ? Number(chartId) : null, title]
  );
  return ins.rows[0];
}

/** 用 DB 历史（最近 N 轮）+ system 命盘上下文拼出 LLM messages。 */
async function buildChatMessages(conversation, chartContext) {
  const sysPrompt = chartContext || '你是一位严谨的传统命理顾问，基于子平八字为用户答疑。';
  const hist = await query(
    'SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2',
    [conversation.id, CHAT_HISTORY_ROUNDS * 2]
  );
  const ordered = hist.rows.reverse(); // 旧→新
  return [{ role: 'system', content: sysPrompt }, ...ordered.map((m) => ({ role: m.role, content: m.content }))];
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
  // 游客限 3 轮问答，第 4 轮起提示登录（不调用 LLM，防刷额度）
  if (ctx.isGuest) {
    const c = await checkChatGuest(ctx.anonId).catch(() => ({ ok: true }));
    if (!c.ok) return sendJson(res, 402, { needLogin: true, error: '免费问答已达 3 轮上限，登录后即可继续追问 👇' });
  }
  // 配置优先级：管理员服务端配置 > 环境变量（前端不再传入密钥，避免泄露）
  const srv = loadLlmConfig();
  const baseUrl = (srv?.baseUrl || process.env.LLM_BASE_URL || '').trim();
  const apiKey = (srv?.apiKey || process.env.LLM_API_KEY || '').trim();
  const model = (srv?.model || process.env.LLM_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) {
    return sendJson(res, 400, { error: '模型未配置，请联系管理员在后台设置模型' });
  }
  // 解析 / 创建会话
  const conversation = await resolveConversation(ctx, body);
  if (!conversation) return sendJson(res, 403, { error: '无法访问该会话' });
  // 落库用户消息
  await query('INSERT INTO messages (conversation_id, role, content, tokens) VALUES ($1,$2,$3,$4)',
    [conversation.id, 'user', message.content, estTokens(message.content)]);
  await query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversation.id]);

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
      signal: upstreamCtrl.signal,
    });
  } catch (e) {
    console.log('[chat] upstream fetch failed after %dms: %s', Date.now() - t0, e.message);
    return sendJson(res, 502, { error: '无法连接模型服务：' + (e.name === 'AbortError' ? '已中止' : e.message) });
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
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: `模型服务返回 ${upstream.status}：${detail.slice(0, 300)}` }));
  }
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
      if (data === '[DONE]') { res.write(`data: [DONE]\n\n`); continue; }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          chunkN++;
          if (chunkN <= 3 || chunkN % 20 === 0) console.log('[chat] chunk#%d t=%dms len=%d', chunkN, Date.now() - t0, delta.length);
          res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
        }
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
    res.write(`data: [DONE]\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  } finally {
    // 落库 assistant 消息（即使客户端中断也尽量保留已生成部分）
    if (full) {
      await query('INSERT INTO messages (conversation_id, role, content, tokens) VALUES ($1,$2,$3,$4)',
        [conversation.id, 'assistant', full, estTokens(full)]).catch(() => {});
      await query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversation.id]).catch(() => {});
    }
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

// ── 认证路由 ──
async function handleRegister(req, res) {
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    const u = await register(body);
    const { token, expiresAt } = await createSession(u.id);
    res.setHeader('Set-Cookie', cookieFor(token, expiresAt));
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
    res.setHeader('Set-Cookie', cookieFor(token, expiresAt));
    // 登录已有账号也并入游客匿名命盘（5.1：保存此命盘到我的账号）
    await claimAnonIfPresent(req, res, u.id);
    sendJson(res, 200, { user: u });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}
async function handleLogout(req, res) {
  await destroySession(req);
  res.setHeader('Set-Cookie', 'cl_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  sendJson(res, 200, { ok: true });
}
async function handleMe(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  sendJson(res, 200, { user });
}
function cookieFor(token, expiresAt) {
  const exp = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return `cl_sid=${token}; Path=/; Max-Age=${exp}; HttpOnly; SameSite=Lax`;
}

/** 注册 / 登录成功后，把请求中的匿名命盘并入该账号（若带 cl_aid cookie）。 */
async function claimAnonIfPresent(req, res, userId) {
  const ac = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(ANON_COOKIE_NAME + '='));
  if (!ac) return 0;
  const anonId = decodeURIComponent(ac.slice(ANON_COOKIE_NAME.length + 1));
  const merged = await mergeAnonCharts(anonId, userId).catch(() => 0);
  // 5.2：匿名对话会话一并并入账号
  await mergeAnonConversations(anonId, userId).catch(() => {});
  res.appendHeader('Set-Cookie', `${ANON_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return merged;
}

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const idMatch = url.match(/^\/api\/charts\/(\d+)$/);
  try {
    if (req.method === 'GET' && url === '/api/config') {
      return sendJson(res, 200, {
        llmPreset: !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL),
        adminConfigured: !!loadLlmConfig(),
        baseUrl: process.env.LLM_BASE_URL || '', model: process.env.LLM_MODEL || '',
        appName: '辰箓',
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
    if (req.method === 'GET' && url === '/api/home') return await handleHome(req, res);
    if (req.method === 'GET' && url === '/api/calendar') return await handleCalendar(req, res);
    if (req.method === 'POST' && url === '/api/chart') return await handleChart(req, res);
    if (req.method === 'GET' && url === '/api/conversations') return await handleConversationsList(req, res);
    if (req.method === 'GET' && url === '/api/charts') return await handleChartsList(req, res);
    if (req.method === 'GET' && idMatch) return await handleChartGet(req, res, idMatch[1]);
    if (url === '/api/admin/llm') return await handleAdminLlm(req, res);
    if (req.method === 'POST' && url === '/api/chat') return await handleChat(req, res);
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
}
main();
