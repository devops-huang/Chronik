/* 辰箓 · 天机阁首页 */
(() => {
  const $ = (id) => document.getElementById(id);
  const withEl = (id, fn) => { const el = $(id); if (!el) { console.warn('[index] missing #' + id); return; } fn(el); };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let view = { y: 0, m: 0 }; // 当前查看的年月
  let wxChart = null;
  const state = { pos: null }; // 当前定位（GPS/IP）

  // 今日靈籤（繁体签库，純前端隨機抽取）
  const OMENS = [
    { lv: 1, levelText: '上上', title: '第一籤 · 上上', poem: ['雲開霧散見青天', '運轉時來福自綿', '舊願將償新願遂', '花開並蒂喜連連'], desc: '諸事順遂，宜把握良機、主動出擊，忌猶豫不決。' },
    { lv: 1, levelText: '上', title: '第七籤 · 上', poem: ['明月當空照大江', '清風送爽意洋洋', '求謀多半逢知己', '名利從容兩不妨'], desc: '貴人相助，謀事易成，宜交友合作，守正得安。' },
    { lv: 1, levelText: '上', title: '第九籤 · 上', poem: ['鳳凰浴火得重生', '歷盡艱辛道乃成', '莫道前途無去處', '青山只在白雲層'], desc: '否極泰來，歷練後更有進境，宜堅守初心。' },
    { lv: 1, levelText: '上', title: '第十五籤 · 上', poem: ['東風解凍水生溫', '草木逢春盡吐芬', '積善之家有餘慶', '此心安處是吾門'], desc: '時運漸暖，利養德積善，靜中得趣。' },
    { lv: 2, levelText: '中平', title: '第二十三籤 · 中平', poem: ['行舟半渡遇風波', '進退維谷意若何', '守得雲開終見月', '莫教心緒亂如麻'], desc: '進退之間宜守不宜攻，耐住性子可化險為夷。' },
    { lv: 2, levelText: '中平', title: '第二十六籤 · 中平', poem: ['平分秋色月輪圓', '得失從來總在天', '但盡人心聽天命', '何須苦苦計媸妍'], desc: '得失隨緣，盡力而為、不强求結果。' },
    { lv: 2, levelText: '中平', title: '第二十九籤 · 中平', poem: ['花開半落未全紅', '事到中流未易窮', '且待時來金作價', '莫嫌淡薄與人同'], desc: '時未全美，宜蓄勢待時，勿急於求成。' },
    { lv: 2, levelText: '中平', title: '第三十三籤 · 中平', poem: ['磨劍十年始一開', '鋒芒未試且徘徊', '待得秋高風起日', '長空萬里任君裁'], desc: '厚積薄發之象，宜修內功、備而後動。' },
    { lv: 2, levelText: '中平', title: '第三十八籤 · 中平', poem: ['柳暗花明又一村', '疑無去路轉乾坤', '心平氣和觀自在', '隨緣自在不勞神'], desc: '困中藏轉機，放下執著反得自在。' },
    { lv: 3, levelText: '下下', title: '第四十四籤 · 下下', poem: ['孤舟夜雨打篷窗', '寒燈明滅影幢幢', '凡事三思須謹慎', '強求反惹禍殃雙'], desc: '時運偏低，宜守不宜進，諸事謹慎、忌強求。' },
    { lv: 3, levelText: '下下', title: '第四十九籤 · 下下', poem: ['殘荷聽雨夢難成', '往事依稀費忖評', '莫向危竿圖遠捷', '安分隨緣保太平'], desc: '不宜冒進投機，安分守己可保安寧。' },
    { lv: 3, levelText: '下下', title: '第五十二籤 · 下下', poem: ['霜重風嚴草木凋', '前程黯黯路迢迢', '且斂鋒鋩藏肘後', '待春回處再扶搖'], desc: '收斂鋒芒、低調潛行，待時運回轉再圖大舉。' },
  ];

  // ── 鉴权守卫 ──
  fetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then((me) => {
    if (!me) { location.href = '/login.html'; return; }
    withEl('uname', (e) => { e.textContent = me.user.nickname || me.user.username; });
    withEl('avatar', (e) => { e.textContent = (me.user.nickname || me.user.username || '辰')[0]; });
  }).catch(() => {});

  withEl('btnLogout', (b) => { b.onclick = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    location.href = '/login.html';
  }; });

  // ── Hero 背景（不挡字，双环慢转 + 星光） ──
  heroAnim();

  // ── 地理定位：GPS 优先，IP 兜底，localStorage 缓存 1h ──
  const POS_KEY = 'chenlu_pos';
  function loadPosCache() { try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { return null; } }
  function savePos(p) { try { localStorage.setItem(POS_KEY, JSON.stringify({ ...p, t: Date.now() })); } catch {} }

  async function tryGeo() {
    return new Promise((res) => {
      if (!('geolocation' in navigator)) return res(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => res({ lat: pos.coords.latitude, lon: pos.coords.longitude, src: 'gps' }),
        () => res(null),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 3600e3 }
      );
    });
  }
  async function tryIP() {
    try {
      const r = await fetch('https://ipwho.is/');
      const j = await r.json();
      if (j && typeof j.latitude === 'number') return { lat: j.latitude, lon: j.longitude, city: j.city, src: 'ip' };
    } catch (e) {}
    return null;
  }
  async function resolvePosition(skipCache) {
    if (!skipCache) {
      const c = loadPosCache();
      if (c && c.lat && c.lon && Date.now() - c.t < 3600e3) return c;
    }
    let p = await tryGeo();
    if (!p) p = await tryIP();
    if (p) savePos(p);
    return p;
  }

  async function load() {
    state.pos = await resolvePosition();
    await reload();
  }
  async function reload() {
    try {
      let url = '/api/home';
      const p = state.pos;
      if (p && p.lat && p.lon) url += `?lat=${encodeURIComponent(p.lat)}&lon=${encodeURIComponent(p.lon)}`;
      const r = await fetch(url);
      const d = await (r.ok ? r.json() : null);
      if (!d) { withEl('dash', (e) => { e.innerHTML = '<div class="loading">加载失败，请刷新</div>'; }); return; }
      view = { y: Number(d.today.split('-')[0]), m: Number(d.today.split('-')[1]) };
      render(d);
      loadRecent();
    } catch (e) {
      withEl('dash', (e) => { e.innerHTML = '<div class="loading">网络异常，请刷新</div>'; });
    }
  }

  function render(d) {
    withEl('heroDate', (e) => { e.textContent = `${d.monthLabel} · ${d.today} ${d.fortune.weekday} · 天機流轉`; });
    const f = d.fortune, w = d.weather;
    const yi = (f.yi || []).join('、') || '—';
    const ji = (f.ji || []).join('、') || '—';
    const wxIcon = weatherIcon(w?.code);
    withEl('dash', (container) => {
      container.className = '';
      container.innerHTML = `
        <div class="dash-core">
          <section class="card fortune-card fadeup">
            <h3><span class="ic">☯</span>今日運勢</h3>
            <div class="fortune-big">
              <span class="gz">${esc(f.ganzhi)}</span>
              <span class="el">${esc(f.lunarText)}</span>
            </div>
            <div><span class="rel-tag">${esc(f.fortune.relation)}日</span></div>
            <div class="fortune-head">${esc(f.fortune.headline)}</div>
            <div class="yi-ji">
              <div class="col"><div class="lab yi">宜</div><div class="v">${esc(yi)}</div></div>
              <div class="col"><div class="lab ji">忌</div><div class="v">${esc(ji)}</div></div>
            </div>
            ${f.term ? `<div class="hint">時令：${esc(f.term)}</div>` : ''}
          </section>

          <section class="card wx-card fadeup">
            <h3><span class="ic">🌤️</span>天氣 <span class="wx-loc" id="wxLoc"></span></h3>
            <div class="wx-reloc">
              <button id="btnRelocate">📍 重新定位</button>
              <span id="wxLocStatus" class="hint"></span>
            </div>
            ${w && !w.error ? `
            <div class="wx-top">
              <span class="wx-icon">${wxIcon}</span>
              <div class="wx-temp">${w.temp}°</div>
              <div class="wx-meta">
                <div><b>${esc(w.condition)}</b>${w.high != null ? ` · 高 ${w.high}° / 低 ${w.low}°` : ''}</div>
                <div>體感 ${w.feels}° · 濕度 ${w.humidity}% · 風 ${Math.round(w.wind)}m/s</div>
              </div>
            </div>
            <div id="wxChart"></div>
            ` : `<div class="loading">${esc(w?.error || '天氣暫不可用')}</div>`}
          </section>
        </div>

        <div class="dash-mid">
          <section class="card cal-card fadeup">
            <h3><span class="ic">📅</span>萬年曆 · ${esc(d.monthLabel)}</h3>
            <div class="cal-head">
              <span class="ml">${esc(d.monthLabel)}</span>
              <span><button id="calPrev">‹</button> <button id="calNext">›</button></span>
            </div>
            <div class="cal-grid" id="calGrid"></div>
            <div class="day-detail" id="dayDetail"></div>
          </section>

          <section class="card advice-card fadeup">
            <h3><span class="ic">🪞</span>陰陽調和建議</h3>
            <ul class="advice">${(f.advice || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
            <div class="advice-art" aria-hidden="true">
              <svg viewBox="0 0 600 220" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <radialGradient id="moonGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="rgba(232,201,138,.40)"/>
                    <stop offset="60%" stop-color="rgba(232,201,138,.10)"/>
                    <stop offset="100%" stop-color="rgba(232,201,138,0)"/>
                  </radialGradient>
                  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="rgba(127,200,232,.10)"/>
                    <stop offset="100%" stop-color="rgba(127,200,232,0)"/>
                  </linearGradient>
                </defs>

                <!-- 月晕 -->
                <circle cx="440" cy="60" r="78" fill="url(#moonGlow)"/>
                <!-- 月（淡描边+极淡填充，仿水墨留白） -->
                <circle cx="440" cy="60" r="22" fill="rgba(236,229,212,.04)"/>
                <circle cx="440" cy="60" r="22" fill="none" stroke="rgba(232,201,138,.45)" stroke-width="1.1"/>
                <!-- 月海 -->
                <ellipse cx="434" cy="55" rx="3" ry="2" fill="rgba(127,200,232,.18)"/>
                <ellipse cx="448" cy="66" rx="2.2" ry="1.5" fill="rgba(127,200,232,.15)"/>

                <!-- 远山三道（水墨描线，由远及近渐浓） -->
                <g fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M0,160 L60,128 L100,144 L160,115 L220,135 L280,120 L340,138 L400,122 L470,140 L540,128 L600,140" stroke="rgba(127,200,232,.18)" stroke-width="0.9"/>
                  <path d="M0,178 L80,150 L140,164 L210,135 L290,158 L370,140 L450,160 L540,150 L600,162" stroke="rgba(127,200,232,.30)" stroke-width="1.05"/>
                  <path d="M0,196 L100,172 L200,184 L300,166 L400,180 L500,170 L600,182" stroke="rgba(95,208,192,.40)" stroke-width="1.15"/>
                </g>
                <!-- 远山淡填充（极淡，几何山形） -->
                <path d="M0,220 L0,178 L80,150 L140,164 L210,135 L290,158 L370,140 L450,160 L540,150 L600,162 L600,220 Z" fill="url(#rim)" opacity=".5"/>

                <!-- 飞鹤 2 只（书法V字笔触，远近分明） -->
                <g fill="none" stroke="rgba(236,229,212,.78)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 远（右上） -->
                  <path d="M270,72 Q280,62 290,72 Q295,68 300,72 Q290,77 290,80 Q283,77 280,80 Q272,77 270,72 Z"/>
                  <!-- 近（中间） -->
                  <path d="M170,98 Q183,86 196,98 Q202,93 208,98 Q196,104 196,108 Q188,104 184,108 Q174,104 170,98 Z"/>
                </g>

                <!-- 卷云（极简一笔） -->
                <g fill="none" stroke="rgba(127,200,232,.30)" stroke-width="0.7" stroke-linecap="round">
                  <path d="M340,40 q8,-4 16,0 q8,4 16,0"/>
                  <path d="M120,55 q7,-3 14,0 q7,3 14,0"/>
                </g>

                <!-- 江水波纹（极淡） -->
                <g fill="none" stroke="rgba(232,201,138,.18)" stroke-width="0.7">
                  <path d="M100,200 q14,-2 28,0 t28,0"/>
                  <path d="M260,203 q14,-2 28,0 t28,0"/>
                  <path d="M420,200 q14,-2 28,0 t28,0"/>
                </g>
                <!-- 江面倒月（极淡椭圆） -->
                <ellipse cx="440" cy="202" rx="40" ry="1.8" fill="rgba(232,201,138,.20)"/>

                <!-- 孤松（左下，毛笔笔触） -->
                <g stroke="rgba(236,229,212,.6)" fill="none" stroke-linecap="round">
                  <path d="M70,170 L70,118" stroke-width="1.6"/>
                  <path d="M70,148 Q54,144 42,148" stroke-width="1"/>
                  <path d="M70,138 Q86,134 98,138" stroke-width="1"/>
                  <path d="M70,128 Q54,120 42,124" stroke-width="1"/>
                  <path d="M70,128 Q86,120 100,124" stroke-width="1"/>
                  <g stroke-width="0.7" opacity=".75">
                    <path d="M44,146 l-3,-2 M44,148 l-3,-2 M44,150 l-3,-2"/>
                    <path d="M98,136 l3,-2 M98,138 l3,-2 M98,140 l3,-2"/>
                    <path d="M44,122 l-3,-2 M44,124 l-3,-2"/>
                    <path d="M100,122 l3,-2 M100,124 l3,-2"/>
                  </g>
                </g>

                <!-- 题款（水墨题字） -->
                <g font-family="'Noto Serif TC','Songti SC',serif" fill="rgba(236,229,212,.62)">
                  <text x="478" y="186" font-size="11" letter-spacing="3">月照千山</text>
                  <text x="478" y="200" font-size="9" letter-spacing="2" opacity=".7">萬籟俱寂</text>
                </g>
                <!-- 朱砂印章「道」 -->
                <g transform="translate(548,194)">
                  <rect x="-13" y="-13" width="26" height="26" fill="rgba(216,115,95,.10)" stroke="rgba(216,115,95,.60)" stroke-width="1.2"/>
                  <text x="0" y="6" text-anchor="middle" font-family="'Noto Serif TC','Songti SC',serif" font-size="18" font-weight="600" fill="rgba(216,115,95,.88)">道</text>
                </g>
              </svg>
            </div>
          </section>
        </div>

        <div class="dash-row3">
          <section class="card hours-card fadeup">
            <h3><span class="ic">⏳</span>十二時辰</h3>
            <div class="hours-grid" id="hoursGrid"></div>
            <div class="hour-legend">
              <span><i style="background:var(--jade)"></i>吉</span>
              <span><i style="background:var(--gold)"></i>平</span>
              <span><i style="background:var(--red)"></i>凶</span>
            </div>
          </section>

          <section class="card omen-card fadeup">
            <h3><span class="ic">🎴</span>今日靈籤</h3>
            <div class="omen-box" id="omenBox">
              <div class="omen-title">心誠則靈，點下方求籤</div>
            </div>
            <div class="omen-actions"><button id="btnDraw">求　籤</button></div>
          </section>
        </div>

        <div class="dash-foot">
          <section class="card cta-card fadeup">
            <h3><span class="ic">🧭</span>開始推演</h3>
            <div class="cta">
              <a href="/studio.html">進入排盤工作室 →</a>
              <a href="/studio.html#quick">快速排出我的命盤 →</a>
            </div>
          </section>

          <section class="card recent-card fadeup">
            <h3><span class="ic">📜</span>最近命盤</h3>
            <div id="recentWrap"><div class="loading">載入中…</div></div>
          </section>
        </div>`;
    });

    renderCalendar(d.monthGrid, d.today);
    withEl('calPrev', (b) => { b.onclick = () => navigate(-1); });
    withEl('calNext', (b) => { b.onclick = () => navigate(1); });
    withEl('btnRelocate', (b) => { b.onclick = () => doRelocate(); });
    renderHours(f.hours);
    withEl('btnDraw', (b) => { b.onclick = () => drawOmen(); });
    updateLocUI(state.pos, w);
    if (w && !w.error && window.echarts) drawWeather(w);
  }

  function weatherIcon(code) {
    if (code == null) return '🌡️';
    const m = { 0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌦️', 53: '🌦️', 55: '🌧️', 56: '🌧️', 57: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️', 71: '🌨️', 73: '🌨️', 75: '❄️', 77: '🌨️', 80: '🌦️', 81: '🌦️', 82: '⛈️', 85: '🌨️', 86: '🌨️', 95: '⛈️', 99: '⛈️' };
    return m[code] || '🌡️';
  }

  // 十二時辰吉凶格
  function renderHours(hours) {
    withEl('hoursGrid', (g) => {
      if (!Array.isArray(hours)) return;
      g.innerHTML = hours.map((h) => `
        <div class="hour-cell lv${h.level}" title="${esc(h.branch)}時 · ${esc(h.tip)}">
          <div class="hb">${esc(h.branch)}</div>
          <div class="hr">${esc(h.range)}</div>
          <span class="dot"></span>
          <div class="tip">${esc(h.tip)}</div>
        </div>`).join('');
    });
  }

  // 今日靈籤：隨機抽一籤
  function drawOmen() {
    const o = OMENS[Math.floor(Math.random() * OMENS.length)];
    withEl('omenBox', (box) => {
      if (!box) return;
      box.innerHTML = `
        <div class="omen-level lv${o.lv}">${esc(o.levelText)}</div>
        <div class="omen-title">${esc(o.title)}</div>
        <div class="omen-poem">${o.poem.map((l) => esc(l)).join('<br>')}</div>
        <div class="omen-desc">${esc(o.desc)}</div>`;
    });
  }

  function updateLocUI(pos, w) {
    withEl('wxLoc', (e) => { e.textContent = '· ' + (w?.city || pos?.city || '—'); });
    withEl('wxLocStatus', (e) => {
      if (!pos) e.textContent = '默认城市（允许定位可获精准天气）';
      else if (pos.src === 'gps') e.textContent = '已通过定位获取';
      else if (pos.src === 'ip') e.textContent = '通过 IP 大致定位';
    });
  }

  async function doRelocate() {
    withEl('wxLocStatus', (e) => { e.textContent = '定位中…'; });
    state.pos = await resolvePosition(true);
    await reload();
  }

  function renderCalendar(grid, today) {
    withEl('calGrid', (g) => {
      const wd = ['日', '一', '二', '三', '四', '五', '六'];
      g.innerHTML = wd.map((x) => `<div class="wd">${x}</div>`).join('')
        + grid.map((c) => `<div class="cal-cell ${c.inMonth ? '' : 'out'} ${c.isToday ? 'today' : ''}" data-ymd="${c.ymd}">
          <div class="d">${Number(c.ymd.split('-')[2])}</div>
          <div class="gz">${esc(c.ganzhi)}</div>
          <div class="lu">${esc(c.lunarText.replace(/^\\D+年/, '').replace('月', '·').replace('日', ''))}</div>
        </div>`).join('');
      g.querySelectorAll('.cal-cell').forEach((el) => {
        el.onclick = () => showDay(el.dataset.ymd, grid.find((c) => c.ymd === el.dataset.ymd));
      });
      const todayCell = grid.find((c) => c.ymd === today);
      if (todayCell) showDay(today, todayCell);
    });
  }

  function showDay(ymd, c) {
    if (!c) return;
    withEl('dayDetail', (e) => {
      e.innerHTML = `<b>${ymd}</b> · 农历 ${esc(c.lunarText)} · 日干支 <b>${esc(c.ganzhi)}</b>（${esc(c.weekday)}）`
        + (c.isToday ? ' · <span style="color:var(--gold-bright)">今日</span>' : '');
    });
  }

  async function navigate(delta) {
    let { y, m } = view;
    m += delta; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    view = { y, m };
    try {
      const g = await fetch(`/api/calendar?y=${y}&m=${m}`).then((x) => x.ok ? x.json() : null);
      if (!g) return;
      withEl('dash', (container) => {
        const ml = container.querySelector('.ml'); if (ml) ml.textContent = `${y}年${m}月`;
      });
      renderCalendar(g.grid, g.today);
      withEl('heroDate', (e) => { e.textContent = `${y}年${m}月 · 天机流转`; });
    } catch (e) {}
  }

  async function loadRecent() {
    try {
      const r = await fetch('/api/charts');
      const data = await (r.ok ? r.json() : null);
      withEl('recentWrap', (wrap) => {
        if (!data || !data.charts || !data.charts.length) { wrap.innerHTML = '<div class="hint">你还没有排过命盘，点上方按钮开始第一次推演。</div>'; return; }
        wrap.innerHTML = `<div class="hint" style="margin-bottom:8px">最近命盘（点击载入工作室）</div>
          <div class="recent">${data.charts.map((c) => `<div class="item" data-id="${c.id}">
            <div class="p">${(c.pillars || []).join(' ')}</div>
            <div class="t">${new Date(c.created_at).toLocaleString('zh-CN')}</div></div>`).join('')}</div>`;
        wrap.querySelectorAll('.item').forEach((el) => {
          el.onclick = () => { location.href = `/studio.html?load=${el.dataset.id}`; };
        });
      });
    } catch (e) {}
  }

  function drawWeather(w) {
    withEl('wxChart', (el) => {
      if (wxChart) { try { wxChart.dispose(); } catch (e) {} }
      wxChart = echarts.init(el, null, { renderer: 'canvas' });
      const hrs = w.hourly.filter((h) => h.v != null).map((h) => h.t.slice(11, 16));
      const vals = w.hourly.filter((h) => h.v != null).map((h) => h.v);
      wxChart.setOption({
        grid: { left: 30, right: 12, top: 14, bottom: 22 },
        tooltip: { trigger: 'axis', backgroundColor: '#161d2e', borderColor: '#283149', textStyle: { color: '#ece5d4' } },
        xAxis: { type: 'category', data: hrs, axisLine: { lineStyle: { color: '#283149' } }, axisLabel: { color: '#9aa3b8', interval: 5 } },
        yAxis: { type: 'value', axisLabel: { color: '#9aa3b8' }, splitLine: { lineStyle: { color: 'rgba(40,49,73,.5)' } } },
        series: [{
          type: 'line', smooth: true, data: vals, symbol: 'none',
          lineStyle: { color: '#5fd0c0', width: 2 },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(95,208,192,.35)' }, { offset: 1, color: 'rgba(95,208,192,0)' }]) },
        }],
      });
      window.addEventListener('resize', () => { try { wxChart && wxChart.resize(); } catch (e) {} });
    });
  }

  function heroAnim() {
    const cv = $('heroBg'); if (!cv) return;
    const ctx = cv.getContext('2d');
    const baseW = () => cv.clientWidth || window.innerWidth;
    const baseH = () => cv.clientHeight || 420;
    let W = 0, H = 0, cx = 0, cy = 0, R = 0, stars = [], goldSparks = [];
    let dpr = window.devicePixelRatio || 1;

    function resize() {
      W = baseW(); H = baseH();
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2;
      R = Math.min(W, H) * 0.55; // 比登录页大，因为不会被压缩
      seed();
    }
    function seed() {
      const n = Math.min(180, Math.floor(W * H / 7000));
      stars = Array.from({ length: n }, () => {
        const colors = ['rgba(232,201,138,','rgba(127,200,232,','rgba(95,208,192,','rgba(236,229,212,'];
        return {
          x: Math.random() * W, y: Math.random() * H,
          r: Math.random() * 1.2 + 0.3,
          a: Math.random() * 0.7 + 0.25,
          v: (Math.random() < 0.5 ? -1 : 1) * (Math.random() * 0.005 + 0.002),
          c: colors[Math.floor(Math.random() * colors.length)]
        };
      });
      goldSparks = Array.from({ length: 14 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.3, vy: -Math.random() * 0.3 - 0.1,
        life: 0, max: 220 + Math.random() * 220, r: Math.random() * 1.1 + 0.5
      }));
    }

    let t = 0;
    function frame() {
      t += 0.0024;
      ctx.clearRect(0, 0, W, H);
      // 三层同心圆（轨道感，不挡字——半径很大在外围，被字覆盖）
      const rings = [{ r: R * 0.95 }, { r: R * 1.15 }, { r: R * 1.4 }];
      ctx.lineWidth = 1;
      for (const ring of rings) {
        ctx.strokeStyle = `rgba(232,201,138,${ring === rings[0] ? 0.18 : 0.08})`;
        ctx.beginPath(); ctx.arc(cx, cy, ring.r, 0, Math.PI * 2); ctx.stroke();
      }
      // 旋转符文环（沿最大环 12 个符文）
      const ringR = R * 1.4;
      const rot = t * 0.5;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
      const TRG = ['☰','☱','☲','☳','☴','☵','☶','☷','☯','☉','☽','✦'];
      ctx.font = `${Math.round(R * 0.16)}px "Noto Serif SC","Songti SC",serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 0; i < TRG.length; i++) {
        const a = (i / TRG.length) * Math.PI * 2;
        const x = Math.cos(a) * ringR, y = Math.sin(a) * ringR;
        ctx.fillStyle = i % 2 === 0 ? 'rgba(232,201,138,.45)' : 'rgba(127,200,232,.45)';
        ctx.fillText(TRG[i], x, y);
      }
      ctx.restore();

      // 反向旋转的细环 24 个卦象字符
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-rot * 1.2 + Math.PI / 12);
      ctx.font = `${Math.round(R * 0.11)}px "Noto Serif SC",serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const VERSE = ['乾','坤','震','巽','坎','离','艮','兑','玄','黄','宇','宙','洪','荒','日','月','盈','昃','辰','宿','列','张','寒','来'];
      ctx.fillStyle = 'rgba(127,200,232,.30)';
      for (let i = 0; i < VERSE.length; i++) {
        const a = (i / VERSE.length) * Math.PI * 2;
        const x = Math.cos(a) * (ringR - 22), y = Math.sin(a) * (ringR - 22);
        ctx.fillText(VERSE[i], x, y);
      }
      ctx.restore();

      // 星点
      for (const s of stars) {
        s.a += s.v;
        if (s.a < 0.15 || s.a > 1) s.v = -s.v;
        ctx.globalAlpha = s.a;
        ctx.fillStyle = s.c + '1)';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        if (s.r > 1) {
          ctx.fillStyle = s.c + (s.a * 0.15).toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2); ctx.fill();
        }
      }

      // 金色向上飘的光点
      for (const s of goldSparks) {
        s.life++;
        s.x += s.vx + Math.sin(s.life * 0.04) * 0.16;
        s.y += s.vy;
        if (s.life > s.max || s.y < -10) {
          s.x = Math.random() * W; s.y = H + 10;
          s.life = 0; s.vx = (Math.random() - 0.5) * 0.3; s.vy = -Math.random() * 0.3 - 0.1;
          s.r = Math.random() * 1.1 + 0.5;
        }
        const fade = Math.sin((s.life / s.max) * Math.PI);
        ctx.globalAlpha = fade * 0.55;
        ctx.fillStyle = 'rgba(232,201,138,1)';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      }

      // 中央放射光晕（柔光，不挡字）
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.05);
      grad.addColorStop(0, 'rgba(232,201,138,0.10)');
      grad.addColorStop(0.6, 'rgba(232,201,138,0.04)');
      grad.addColorStop(1, 'rgba(232,201,138,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, 0, Math.PI * 2); ctx.fill();

      requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
