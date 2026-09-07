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

  // 开关定义：key 对应后端 notification_settings 字段
  const SWITCHES = [
    { key: 'solar_term', label: '节气转换提醒', desc: '霜降、立春等节气临近时，提醒你气场流转与新节律。' },
    { key: 'liunian', label: '年度流年命宫提醒', desc: '进入新农历年 / 流年干支更替时，提醒你命宫与运势走向变化。' },
    { key: 'destiny_node', label: '本命年冲太岁提醒', desc: '命中本命年、冲太岁等运势节点时，提醒你趋避与调养。' },
    { key: 'birthday', label: '生日彩蛋提醒', desc: '生日当天送上命理文化彩蛋与流年小语。' },
  ];

  let loadedSettings = { solar_term: true, liunian: true, destiny_node: true, birthday: true, email: false };

  function renderPage() {
    const body = $('pageBody');
    if (!body) return;
    body.innerHTML = `
      <section class="settings-card fadeup">
        <h2>提醒设置</h2>
        <p class="settings-sub">选择你希望接收的节律提醒。所有提醒均为节律 / 事件驱动，不会每日打扰。</p>
        <div class="rhythm-note">🌿 说明：以上提醒均基于节气、流年、命宫等节律节点自动触发，<b>无每日推送</b>，仅在相关节点临近时发送一次站内信。</div>
        ${SWITCHES.map((s) => `
          <label class="switch-row">
            <span class="switch-text">
              <span class="switch-label">${esc(s.label)}</span>
              <span class="switch-desc">${esc(s.desc)}</span>
            </span>
            <span class="switch">
              <input type="checkbox" id="sw_${s.key}" ${loadedSettings[s.key] ? 'checked' : ''}>
              <span class="track"></span><span class="knob"></span>
            </span>
          </label>`).join('')}
        <div class="email-row">
          <span class="switch-text">
            <span class="switch-label">邮件提醒</span>
            <span class="switch-desc">邮件渠道暂未开通<span class="tag">暂未开通</span></span>
          </span>
          <span class="switch">
            <input type="checkbox" id="sw_email" disabled ${loadedSettings.email ? 'checked' : ''}>
            <span class="track"></span><span class="knob"></span>
          </span>
        </div>
        <div class="save-bar">
          <button class="primary" id="btnSave">保存设置</button>
          <span class="status info" id="status"></span>
        </div>
      </section>`;
    withEl('btnSave', (b) => { b.onclick = save; });
  }

  function renderLoginPrompt() {
    const body = $('pageBody');
    if (!body) return;
    body.innerHTML = `
      <section class="settings-card fadeup">
        <h2>提醒设置</h2>
        <div class="login-prompt">
          请先<a href="/login.html">登录</a>后设置提醒偏好。<br>
          登录后即可管理你的节气、流年、命宫等节律提醒。
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
    if (status) { status.textContent = '保存中…'; status.className = 'status info'; }
    try {
      const r = await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        loadedSettings = Object.assign(loadedSettings, payload.settings, d.settings || {});
        if (status) { status.textContent = '✅ 已保存'; status.className = 'status ok'; }
      } else if (r.status === 401) {
        renderLoginPrompt();
      } else {
        if (status) { status.textContent = '⚠️ ' + (d.error || '保存失败'); status.className = 'status err'; }
      }
    } catch (e) {
      if (status) { status.textContent = '⚠️ 网络错误：' + (e.message || ''); status.className = 'status err'; }
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadSettings);
  else loadSettings();
})();
