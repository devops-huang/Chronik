/* 辰箓 · 站内信铃铛组件（F1，公共）
 * 挂载到各页导航栏的 #bellMount：
 *  ① 加载拉 GET /api/notifications/unread-count 显示红点数字
 *  ② 点击展开通知抽屉，拉 GET /api/notifications，打开即 POST /api/notifications/read-all 批量标已读并清红点
 *  ③ 未登录（401）静默不显示铃铛
 * 复用现有 fetch 风格（同域 cookie/session，不显式带 credentials，与 index.js/studio.js 一致）。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 黑金风样式（注入一次，三页共享）
  const STYLE = `
.bell-mount{display:inline-flex;align-items:center}
.bell-btn{position:relative;width:38px;height:38px;padding:0;margin-left:4px;border-radius:50%;
  display:grid;place-items:center;font-size:16px;line-height:1;
  background:transparent;border:1px solid var(--line);color:var(--gold-bright);transition:.16s}
.bell-btn:hover{border-color:var(--gold);color:var(--gold-bright)}
.bell-badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 4px;
  border-radius:9px;background:var(--red);color:#fff;font-size:11px;font-weight:700;line-height:18px;
  text-align:center;box-shadow:0 0 8px rgba(216,115,95,.55)}
.bell-drawer{position:fixed;top:62px;right:18px;width:330px;max-width:calc(100vw - 36px);max-height:70vh;
  overflow-y:auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;
  box-shadow:var(--shadow);z-index:50;padding:6px}
.bell-drawer-head{font-size:13px;color:var(--gold-bright);letter-spacing:2px;padding:10px 12px 8px;
  border-bottom:1px solid var(--line);font-family:var(--font-cn)}
.bell-loading,.bell-empty{padding:22px 12px;color:var(--ink-dim);font-size:13px;text-align:center;line-height:1.7}
.bell-item{padding:12px;border-bottom:1px solid var(--line)}
.bell-item:last-child{border-bottom:none}
.bell-item.unread{background:rgba(232,201,138,.07)}
.bell-item-title{font-size:14px;color:var(--gold-bright);margin-bottom:5px;line-height:1.4}
.bell-item-body{font-size:12.5px;color:var(--ink);line-height:1.65}
.bell-item-time{font-size:11px;color:var(--ink-dim);margin-top:7px}`;

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  function ensureStyle() {
    if ($('bellStyle')) return;
    const s = document.createElement('style');
    s.id = 'bellStyle';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function hideBell() {
    const mount = $('bellMount');
    if (mount) mount.style.display = 'none';
  }

  // 拉未读计数，渲染红点；401 静默隐藏
  async function loadCount(badge) {
    try {
      const r = await fetch('/api/notifications/unread-count');
      if (r.status === 401) { hideBell(); return; }
      if (!r.ok) return;
      const d = await r.json().catch(() => null);
      if (!d) return;
      const n = Number(d.count) || 0;
      badge.hidden = n <= 0;
      badge.textContent = n > 99 ? '99+' : String(n);
    } catch { /* 静默失败，不影响主流程 */ }
  }

  // 打开抽屉：拉列表 → 渲染 → 标已读 + 清红点
  async function openDrawer(drawer, badge) {
    drawer.hidden = false;
    drawer.innerHTML = '<div class="bell-loading">加载中…</div>';
    try {
      const r = await fetch('/api/notifications');
      if (r.status === 401) { hideBell(); return; }
      const d = await r.json().catch(() => null);
      const list = (d && Array.isArray(d.notifications)) ? d.notifications : [];
      if (!list.length) {
        drawer.innerHTML = '<div class="bell-empty">暂无通知。<br>节气流转、流年命宫、本命年冲太岁等节律提醒会在此出现。</div>';
      } else {
        drawer.innerHTML = '<div class="bell-drawer-head">站内信</div>' + list.map((n) => `
          <div class="bell-item ${n.read ? 'read' : 'unread'}">
            <div class="bell-item-title">${esc(n.title)}</div>
            <div class="bell-item-body">${esc(n.body)}</div>
            <div class="bell-item-time">${esc(fmtTime(n.created_at))}</div>
          </div>`).join('');
      }
      // 打开即批量标已读，并清红点
      try { await fetch('/api/notifications/read-all', { method: 'POST' }); } catch {}
      badge.hidden = true;
    } catch {
      drawer.innerHTML = '<div class="bell-empty">加载失败，请稍后重试。</div>';
    }
  }

  function initBell() {
    const mount = $('bellMount');
    if (!mount) return; // 无挂载点则不渲染
    ensureStyle();

    const btn = document.createElement('button');
    btn.className = 'bell-btn';
    btn.setAttribute('aria-label', '通知');
    btn.innerHTML = '🔔<span class="bell-badge" id="bellBadge" hidden>0</span>';

    const drawer = document.createElement('div');
    drawer.className = 'bell-drawer';
    drawer.hidden = true;

    mount.appendChild(btn);
    document.body.appendChild(drawer);

    const badge = btn.querySelector('#bellBadge');
    loadCount(badge);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (drawer.hidden) openDrawer(drawer, badge);
      else drawer.hidden = true;
    });
    document.addEventListener('click', (e) => {
      if (drawer.hidden) return;
      if (!drawer.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        drawer.hidden = true;
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBell);
  else initBell();
})();
