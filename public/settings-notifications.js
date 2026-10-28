/* 辰箓 · 提醒设置页（F2，PRD 4.1）
 * 四个开关：节气转换 / 年度流年命宫 / 本命年冲太岁 / 生日彩蛋
 * 邮件勾选：默认关、disabled（SMTP 未实现，提示"暂未开通"）
 * 载入 GET /api/notifications/settings 回显；保存 PUT /api/notifications/settings。
 * 所有提醒均为节律/事件驱动，无每日推送。
 * 鉴权：需登录，401 时展示登录引导（不跳转，避免打断）。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const withEl = (id, fn) => { const el = $(id); if (!el) { console.warn('[settings-notif] missing #' + id); return; } fn(el); };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (k) => (window.i18n ? window.i18n.t(k) : k);

  // 开关定义：key 对应后端 notification_settings 字段；文案走 i18n 词库
  const SWITCHES = [
    { key: 'solar_term', labelKey: 'notif.solarTermLabel', descKey: 'notif.solarTermDesc' },
    { key: 'liunian', labelKey: 'notif.liunianLabel', descKey: 'notif.liunianDesc' },
    { key: 'destiny_node', labelKey: 'notif.destinyLabel', descKey: 'notif.destinyDesc' },
    { key: 'birthday', labelKey: 'notif.birthdayLabel', descKey: 'notif.birthdayDesc' },
  ];

  let loadedSettings = { solar_term: true, liunian: true, destiny_node: true, birthday: true, email: false };
  let lastMode = 'page'; // 'page' | 'prompt'，供切换语言时按当前视图重渲染

  function renderPage() {
    const body = $('pageBody');
    if (!body) return;
    lastMode = 'page';
    body.innerHTML = `
      <section class="settings-card fadeup">
        <h2>${esc(T('notif.title'))}</h2>
        <p class="settings-sub">${esc(T('notif.sub'))}</p>
        <div class="rhythm-note">${T('notif.note')}</div>
        ${SWITCHES.map((s) => `
          <label class="switch-row">
            <span class="switch-text">
              <span class="switch-label">${esc(T(s.labelKey))}</span>
              <span class="switch-desc">${esc(T(s.descKey))}</span>
            </span>
            <span class="switch">
              <input type="checkbox" id="sw_${s.key}" ${loadedSettings[s.key] ? 'checked' : ''}>
              <span class="track"></span><span class="knob"></span>
            </span>
          </label>`).join('')}
        <div class="email-row">
          <span class="switch-text">
            <span class="switch-label">${esc(T('notif.emailLabel'))}</span>
            <span class="switch-desc">${esc(T('notif.emailDesc'))}<span class="tag">${esc(T('notif.emailTag'))}</span></span>
          </span>
          <span class="switch">
            <input type="checkbox" id="sw_email" disabled ${loadedSettings.email ? 'checked' : ''}>
            <span class="track"></span><span class="knob"></span>
          </span>
        </div>
        <div class="save-bar">
          <button class="primary" id="btnSave">${esc(T('notif.save'))}</button>
          <span class="status info" id="status"></span>
        </div>
      </section>`;
    withEl('btnSave', (b) => { b.onclick = save; });
  }

  function renderLoginPrompt() {
    const body = $('pageBody');
    if (!body) return;
    lastMode = 'prompt';
    body.innerHTML = `
      <section class="settings-card fadeup">
        <h2>${esc(T('notif.title'))}</h2>
        <div class="login-prompt">
          ${T('notif.loginPrompt')}
        </div>
      </section>`;
  }

  async function loadSettings() {
    try {
      const r = await fetch('/api/notifications/settings');
      if (r.status === 401) { renderLoginPrompt(); return; }
      if (!r.ok) { renderPage(); return; }
      const d = await r.json().catch(() => null);
      if (d && d.settings) {
        loadedSettings = Object.assign(loadedSettings, d.settings);
      }
      renderPage();
    } catch {
      renderPage(); // fail-open：渲染默认开关，保存时再校验
    }
  }

  async function save() {
    const status = $('status');
    const payload = {
      settings: {
        solar_term: !!($('sw_solar_term') || {}).checked,
        liunian: !!($('sw_liunian') || {}).checked,
        destiny_node: !!($('sw_destiny_node') || {}).checked,
        birthday: !!($('sw_birthday') || {}).checked,
        email: !!($('sw_email') || {}).checked,
      },
    };
    const btn = $('btnSave');
    if (btn) btn.disabled = true;
    if (status) { status.textContent = T('notif.saving'); status.className = 'status info'; }
    try {
      const r = await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        loadedSettings = Object.assign(loadedSettings, payload.settings, d.settings || {});
        if (status) { status.textContent = T('notif.saved'); status.className = 'status ok'; }
      } else if (r.status === 401) {
        renderLoginPrompt();
      } else {
        if (status) { status.textContent = '⚠️ ' + (d.error || T('notif.saveFailed')); status.className = 'status err'; }
      }
    } catch (e) {
      if (status) { status.textContent = '⚠️ ' + T('notif.netError') + '：' + (e.message || ''); status.className = 'status err'; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 鉴权态展示（与 index.html 一致）
  fetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then((me) => {
    if (me && me.user) {
      withEl('uname', (e) => { e.textContent = me.user.nickname || me.user.username; });
      withEl('avatar', (e) => { e.textContent = (me.user.nickname || me.user.username || '辰')[0]; });
      withEl('btnLoginLink', (e) => { e.hidden = true; });
      withEl('btnLogout', (e) => { e.style.display = ''; });
    } else {
      withEl('btnLoginLink', (e) => { e.hidden = false; });
      withEl('btnLogout', (e) => { e.style.display = 'none'; });
    }
  }).catch(() => {
    withEl('btnLoginLink', (e) => { e.hidden = false; });
    withEl('btnLogout', (e) => { e.style.display = 'none'; });
  });
  withEl('btnLogout', (b) => { b.onclick = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    location.href = '/login.html';
  }; });

  // ── 语言切换：保留用户已勾选但未保存的开关状态，再按当前视图重渲染 ──
  document.addEventListener('langchange', () => {
    if (lastMode === 'page') {
      SWITCHES.forEach((s) => {
        const el = $('sw_' + s.key);
        if (el) loadedSettings[s.key] = el.checked;
      });
      renderPage();
    } else {
      renderLoginPrompt();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadSettings);
  else loadSettings();
})();
