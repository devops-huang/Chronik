/**
 * 辰箓 · 后端服务（Node 内置模块 + pg）。
 *
 * 公开：GET / /login.html / 静态；/api/config /api/cities /api/auth/register /api/auth/login
 * 受保护（需会话）：/api/auth/me /api/auth/logout /api/chart /api/charts /api/charts/:id
 *                  /api/home /api/chat
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, initSchema, query } from './lib/db.js';
import {
  register, login, createSession, destroySession, getUserFromRequest, updateProfile,
} from './lib/auth.js';
import { computeAll, chartContextText } from './lib/core.js';
import { listAllCities, resolveLocation } from './lib/chart.js';
import { buildMonthGrid, buildTodayFortune, getWeather, getWeatherByLatLon, todayInShanghai } from './lib/home.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 8787;

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

// ── 排盘 + 存档 ──
async function handleChart(req, res) {
  const user = await requireUser(req, res); if (!user) return;
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
    // 存档
    await query(
      `INSERT INTO charts (user_id, title, input, chart, interpret, fortune, report_html)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user.id, body.title || `${out.chart.pillars.join(' ')} 命盘`, JSON.stringify(body),
       JSON.stringify(slim.chart), JSON.stringify(out.interpret), JSON.stringify(slim.fortune), out.reportHtml]
    );
    // 同步出生信息 / 日主五行到用户资料（首次或补全）
    const patch = {};
    if (!user.birth_date && body.date) {
      patch.birth_calendar = body.calendar === 'lunar' ? 2 : 1;
      patch.birth_date = body.date; patch.birth_time = body.time || null; patch.birth_location = body.location || null;
    }
    patch.day_master = out.chart.dayMaster ? elementOfDayMaster(out.chart.dayMaster) : user.day_master;
    await updateProfile(user.id, patch).catch(() => {});
    sendJson(res, 200, slim);
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
}

const DM_ELEMENT = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
function elementOfDayMaster(dm) { return DM_ELEMENT[dm] || null; }

async function handleChartsList(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  const r = await query(
    `SELECT id, title, created_at, chart->'pillars' AS pillars
     FROM charts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [user.id]);
  sendJson(res, 200, { charts: r.rows });
}
async function handleChartGet(req, res, id) {
  const user = await requireUser(req, res); if (!user) return;
  const r = await query(`SELECT * FROM charts WHERE id=$1 AND user_id=$2`, [id, user.id]);
  if (r.rowCount === 0) return sendJson(res, 404, { error: '未找到' });
  const c = r.rows[0];
  sendJson(res, 200, {
    id: c.id, title: c.title, created_at: c.created_at,
    chart: c.chart, interpret: c.interpret, fortune: c.fortune, reportHtml: c.report_html,
    chartContext: chartContextText(c.chart, c.interpret),
  });
}

// ── 大模型问答流式代理 ──
async function handleChat(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const baseUrl = (body.baseUrl || process.env.LLM_BASE_URL || '').trim();
  const apiKey = (body.apiKey || process.env.LLM_API_KEY || '').trim();
  const model = (body.model || process.env.LLM_MODEL || '').trim();
  const { messages, chartContext } = body;
  if (!baseUrl || !apiKey || !model) {
    return sendJson(res, 400, { error: '服务端未预设模型，请在设置中填写' });
  }
  const sysPrompt = chartContext || '你是一位严谨的传统命理顾问，基于子平八字为用户答疑。';
  const payload = {
    model, stream: true,
    messages: [{ role: 'system', content: sysPrompt }, ...(Array.isArray(messages) ? messages : [])],
    temperature: 0.7,
  };
  const upstreamCtrl = new AbortController();
  const t0 = Date.now();
  console.log('[chat] enter uid=%d model=%s msgs=%d', user.id, model, (messages || []).length);
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
  });
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let chunkN = 0;
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
  } finally { res.end(); }
}

// ── 认证路由 ──
async function handleRegister(req, res) {
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    const u = await register(body);
    const { token, expiresAt } = await createSession(u.id);
    res.setHeader('Set-Cookie', cookieFor(token, expiresAt));
    sendJson(res, 200, { user: u });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}
async function handleLogin(req, res) {
  let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  try {
    const u = await login(body);
    const { token, expiresAt } = await createSession(u.id);
    res.setHeader('Set-Cookie', cookieFor(token, expiresAt));
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

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const idMatch = url.match(/^\/api\/charts\/(\d+)$/);
  try {
    if (req.method === 'GET' && url === '/api/config') {
      return sendJson(res, 200, {
        llmPreset: !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL),
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
    if (req.method === 'GET' && url === '/api/charts') return await handleChartsList(req, res);
    if (req.method === 'GET' && idMatch) return await handleChartGet(req, res, idMatch[1]);
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
