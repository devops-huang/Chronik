// nianli.js · R6† 年历页：当前流年各流月吉凶（复用 R1† 内容策略过滤链 + L1 免责）
import { DISCLAIMER_L1, isBlocked } from '/content-policy.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── i18n 助手（术语口径见 I18N.md §3.2） ──
const T = (k, vars) => (window.i18n ? window.i18n.t(k, vars) : k);
const LANG = () => (window.i18n ? window.i18n.lang() : 'zh');

// R3 · 轻量埋点（与 index.js 同源 trackEvent 契约：POST /api/track {action,payload}）
function trackEvent(name, props = {}) {
  try {
    const body = JSON.stringify({ action: name, payload: props });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
    else fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {}
}

const VCLASS = { good: 'v-good', mid: 'v-mid', warn: 'v-warn' };
const BARCLASS = { good: 'bar-good', mid: 'bar-mid', warn: 'bar-warn' };

// 复用内容策略过滤链：对展示文本做最后一道护栏，命中则脱敏
function safe(text) {
  const s = String(text ?? '');
  if (isBlocked(s).hit) return T('nianli.blocked');
  return s;
}

async function me() {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) return null;
    const d = await r.json();
    return d?.user || null;
  } catch { return null; }
}

function renderHead(user) {
  // L1 合规免责：中文直接取 lib 口径（单一数据源），外语走词库译文
  $('l1').textContent = LANG() === 'zh' ? DISCLAIMER_L1 : T('nianli.l1');
  if (user) {
    $('uname').textContent = user.nickname || user.username || '';
    $('avatar').textContent = (user.nickname || user.username || '辰').slice(0, 1);
  }
}

function renderYear(liunian) {
  const cur = (liunian || []).find((y) => y.isCurrent) || (liunian || [])[0];
  if (!cur) { $('yearBox').innerHTML = ''; return; }
  const vc = VCLASS[cur.verdict?.cls] || 'v-mid';
  $('yearBox').innerHTML = `
    <div class="card year-card">
      <div class="ygan">${esc(T('nianli.yearLabel', { ganzhi: cur.ganzhi }))}</div>
      <div class="ymeta">${esc(T('nianli.metaAnnual'))} · ${esc(cur.nayin || '')} ${esc(cur.starFortune || '')} · ${esc(T('nianli.metaLuck'))} ${esc(cur.dayun || '')} ${cur.kongWang ? '· ' + esc(T('nianli.metaKongwang')) + ' ' + esc(cur.kongWang) : ''}</div>
      <div class="year-verdict ${vc}">${esc(cur.verdict?.label || T('home.neutral'))} · ${esc(cur.verdict?.desc || '')}</div>
      <div class="hl" style="margin-top:10px">${esc(safe(cur.headline))}</div>
      ${cur.shen ? `<div class="shen">${esc(T('nianli.shen'))} · ${esc(safe(cur.shen))}</div>` : ''}
      ${cur.relations?.length ? `<div class="rel">${esc(cur.relations.join(' · '))}</div>` : ''}
    </div>`;
}

function renderMonths(allMonths) {
  const grid = $('monthGrid');
  const months = Array.isArray(allMonths) ? allMonths : [];
  if (!months.length) { grid.innerHTML = ''; return; }
  grid.innerHTML = months.map((m) => {
    const vc = VCLASS[m.verdict?.cls] || 'v-mid';
    const bc = BARCLASS[m.verdict?.cls] || 'bar-mid';
    const pts = Array.isArray(m.points) ? m.points.slice(0, 3).map((p) => `<div>· ${esc(safe(p.text || p))}</div>`).join('') : '';
    return `
      <div class="mc">
        <span class="vb ${bc}"></span>
        <div class="gan">${esc(m.ganzhi)}</div>
        <div class="rng">${esc(m.start || '')} ~ ${esc(m.end || '')}　${esc(m.liunian || '')}</div>
        <span class="vl ${vc}">${esc(m.verdict?.label || T('home.neutral'))}</span>
        <div class="hl">${esc(safe(m.headline))}</div>
        ${pts ? `<div class="shen" style="margin-top:9px">${esc(T('nianli.points'))} · ${pts}</div>` : ''}
        ${m.shen ? `<div class="shen">${esc(T('nianli.shen'))} · ${esc(safe(m.shen))}</div>` : ''}
        ${m.relations?.length ? `<div class="rel">${esc(m.relations.join(' · '))}</div>` : ''}
      </div>`;
  }).join('');
}

// 缓存最近一次渲染数据，供语言切换时重渲染（不重新请求）
let LAST = null;
function renderAll() {
  if (!LAST) return;
  renderHead(LAST.user);
  if (LAST.interpret) {
    renderYear(LAST.interpret.liunian);
    renderMonths(LAST.interpret.allMonths);
  }
}
document.addEventListener('langchange', renderAll);

async function main() {
  const user = await me();
  LAST = { user, interpret: null };
  renderHead(user);
  try {
    const lr = await fetch('/api/charts');
    const list = lr.ok ? await lr.json() : null;
    const first = list?.charts?.[0];
    if (!first) { $('empty').style.display = 'block'; trackEvent('calendar_viewed', { has_chart: false }); return; }
    const cr = await fetch('/api/charts/' + first.id);
    const data = cr.ok ? await cr.json() : null;
    const interpret = data?.interpret;
    if (!interpret) { $('empty').style.display = 'block'; return; }
    LAST.interpret = interpret;
    renderAll();
    trackEvent('calendar_viewed', { chart_id: first.id, months: (interpret.allMonths || []).length });
  } catch (e) {
    console.warn('[nianli]', e);
    $('empty').style.display = 'block';
  }
}

main();
