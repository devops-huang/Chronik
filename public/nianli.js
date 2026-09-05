// nianli.js · R6† 年历页：当前流年各流月吉凶（复用 R1† 内容策略过滤链 + L1 免责）
import { DISCLAIMER_L1, isBlocked } from '/content-policy.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  if (isBlocked(s).hit) return '（内容已按内容安全策略屏蔽）';
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
  $('l1').textContent = DISCLAIMER_L1;
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
      <div class="ygan">${esc(cur.ganzhi)} 年</div>
      <div class="ymeta">流年 · ${esc(cur.nayin || '')} ${esc(cur.starFortune || '')} · 大运 ${esc(cur.dayun || '')} ${cur.kongWang ? '· 空亡 ' + esc(cur.kongWang) : ''}</div>
      <div class="year-verdict ${vc}">${esc(cur.verdict?.label || '平')} · ${esc(cur.verdict?.desc || '')}</div>
      <div class="hl" style="margin-top:10px">${esc(safe(cur.headline))}</div>
      ${cur.shen ? `<div class="shen">神煞：${esc(safe(cur.shen))}</div>` : ''}
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
        <span class="vl ${vc}">${esc(m.verdict?.label || '平')}</span>
        <div class="hl">${esc(safe(m.headline))}</div>
        ${pts ? `<div class="shen" style="margin-top:9px">要点：${pts}</div>` : ''}
        ${m.shen ? `<div class="shen">神煞：${esc(safe(m.shen))}</div>` : ''}
        ${m.relations?.length ? `<div class="rel">${esc(m.relations.join(' · '))}</div>` : ''}
      </div>`;
  }).join('');
}

async function main() {
  renderHead(await me());
  try {
    const lr = await fetch('/api/charts');
    const list = lr.ok ? await lr.json() : null;
    const first = list?.charts?.[0];
    if (!first) { $('empty').style.display = 'block'; trackEvent('calendar_viewed', { has_chart: false }); return; }
    const cr = await fetch('/api/charts/' + first.id);
    const data = cr.ok ? await cr.json() : null;
    const interpret = data?.interpret;
    if (!interpret) { $('empty').style.display = 'block'; return; }
    renderYear(interpret.liunian);
    renderMonths(interpret.allMonths);
    trackEvent('calendar_viewed', { chart_id: first.id, months: (interpret.allMonths || []).length });
  } catch (e) {
    console.warn('[nianli]', e);
    $('empty').style.display = 'block';
  }
}

main();
