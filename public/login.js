/* 辰箓 · 登录注册页：星空粒子 + 闪烁金光 + 中央品牌 + 表单交互 */
(() => {
  const $ = (id) => document.getElementById(id);
  const withEl = (id, fn) => { const el = $(id); if (!el) { console.warn('[login] missing #' + id); return; } fn(el); };
  const status = (msg, cls) => { withEl('status', (e) => { e.className = cls || ''; e.textContent = msg || ''; }); };

  // ── 当前时间显示 ──
  withEl('dateLine', (e) => {
    const now = new Date();
    const cnWeek = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][now.getDay()];
    e.textContent = `丙午年 · ${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 · ${cnWeek}`;
  });

  // ── 背景：星空粒子 + 流星 + 金光闪烁 ──
  const cv = $('bg'); if (!cv) return;
  const ctx = cv.getContext('2d', { alpha: true });
  let W = 0, H = 0, stars = [], meteors = [], goldSparks = [];

  function resize() {
    W = cv.width = window.innerWidth * (window.devicePixelRatio || 1);
    H = cv.height = window.innerHeight * (window.devicePixelRatio || 1);
    cv.style.width = window.innerWidth + 'px'; cv.style.height = window.innerHeight + 'px';
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    seed();
  }

  function seed() {
    const w = window.innerWidth, h = window.innerHeight;
    const n = Math.min(360, Math.floor(w * h / 4800));
    stars = Array.from({ length: n }, () => {
      const colors = [
        'rgba(232,201,138,', 'rgba(127,200,232,', 'rgba(95,208,192,',
        'rgba(236,229,212,', 'rgba(155,140,255,', 'rgba(155,140,255,',
      ];
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.4 + 0.25,
        a: Math.random() * 0.7 + 0.25,
        v: (Math.random() < 0.5 ? -1 : 1) * (Math.random() * 0.005 + 0.002),
        c: colors[Math.floor(Math.random() * colors.length)]
      };
    });
    goldSparks = Array.from({ length: 24 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3, vy: -Math.random() * 0.4 - 0.15,
      life: 0, max: 200 + Math.random() * 240, r: Math.random() * 1.2 + 0.6
    }));
  }

  function tick() {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    // 星点
    for (const s of stars) {
      s.a += s.v;
      if (s.a < 0.1 || s.a > 1) s.v = -s.v;
      ctx.globalAlpha = s.a;
      ctx.fillStyle = s.c + '1)';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      // 大星加光晕
      if (s.r > 1.1) {
        ctx.fillStyle = s.c + (s.a * 0.18).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 3.2, 0, Math.PI * 2); ctx.fill();
      }
    }

    // 金色漂浮微粒（缓慢上升、微微漂移）
    for (const s of goldSparks) {
      s.life++;
      s.x += s.vx + Math.sin(s.life * 0.04) * 0.18;
      s.y += s.vy;
      if (s.life > s.max || s.y < -10) {
        s.x = Math.random() * w; s.y = h + 10;
        s.life = 0; s.vx = (Math.random() - 0.5) * 0.3; s.vy = -Math.random() * 0.4 - 0.15;
        s.r = Math.random() * 1.2 + 0.6;
      }
      const fade = Math.sin((s.life / s.max) * Math.PI);
      ctx.globalAlpha = fade * 0.6;
      ctx.fillStyle = 'rgba(232,201,138,1)';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }

    // 流星
    if (Math.random() < 0.012) {
      const fromLeft = Math.random() < 0.5;
      meteors.push({
        x: fromLeft ? -50 : w + 50,
        y: Math.random() * h * 0.6,
        vx: (fromLeft ? 1 : -1) * (8 + Math.random() * 4),
        vy: 2 + Math.random() * 1.5,
        life: 0, max: 90
      });
    }
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.x += m.vx; m.y += m.vy; m.life++;
      const a = Math.max(0, 1 - m.life / m.max);
      ctx.globalAlpha = a;
      const grad = ctx.createLinearGradient(m.x - m.vx, m.y - m.vy, m.x, m.y);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(255,240,200,1)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(m.x - m.vx, m.y - m.vy); ctx.lineTo(m.x, m.y); ctx.stroke();
      // 头
      ctx.fillStyle = 'rgba(255,245,210,1)';
      ctx.beginPath(); ctx.arc(m.x, m.y, 1.6, 0, Math.PI * 2); ctx.fill();
      if (m.life > m.max) meteors.splice(i, 1);
    }

    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(tick);

  // ── 表单切换 ──
  withEl('tabLogin', (b) => { b.onclick = () => {
    withEl('formLogin', (e) => { e.style.display = ''; });
    withEl('formReg',  (e) => { e.style.display = 'none'; });
    b.classList.add('on'); withEl('tabReg', (x) => { x.classList.remove('on'); });
    status('');
  }; });
  withEl('tabReg', (b) => { b.onclick = () => {
    withEl('formReg',  (e) => { e.style.display = ''; });
    withEl('formLogin', (e) => { e.style.display = 'none'; });
    b.classList.add('on'); withEl('tabLogin', (x) => { x.classList.remove('on'); });
    status('');
  }; });

  async function api(path, body) {
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('请求失败 ' + r.status));
      return d;
    } catch (e) { throw new Error('网络异常：' + (e.message || '请稍后重试')); }
  }

  withEl('btnLogin', (b) => { b.onclick = async () => {
    const username = (($('lUser') || {}).value || '').trim();
    const password = (($('lPwd') || {}).value || '').trim();
    if (!username || !password) return status('请填写用户名与密码', 'err');
    status('登录中…');
    try { await api('/api/auth/login', { username, password }); location.href = '/index.html'; }
    catch (e) { status(e.message, 'err'); }
  }; });

  withEl('btnReg', (b) => { b.onclick = async () => {
    const username  = (($('rUser') || {}).value || '').trim();
    const nickname  = (($('rNick') || {}).value || '').trim();
    const password  = (($('rPwd')  || {}).value || '').trim();
    if (!username || !password) return status('请填写用户名与密码', 'err');
    if (password.length < 6) return status('密码至少 6 位', 'err');
    status('注册中…');
    try { await api('/api/auth/register', { username, password, nickname }); location.href = '/index.html'; }
    catch (e) { status(e.message, 'err'); }
  }; });

  ['lPwd', 'rPwd'].forEach((id) => withEl(id, (e) => {
    e.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') (id === 'lPwd' ? $('btnLogin') : $('btnReg')).click();
    });
  }));

  // 免登录试用 → 进推演阁（游客态）
  withEl('btnGuest', (b) => { b.onclick = () => { location.href = '/studio.html'; }; });

  // 已登录则直接进首页
  fetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then((me) => { if (me) location.href = '/index.html'; }).catch(() => {});
})();
