/* 辰箓 · 推演阁：推演命盘 + 右侧报告预览（可全屏）+ Markdown 对话 */
(() => {
  const $ = (id) => document.getElementById(id);
  // 防御性 helper：有元素才执行回调
  const withEl = (id, fn) => { const el = $(id); if (!el) { console.warn('[studio] missing element #' + id); return; } fn(el); };

  const state = {
    calendar: 'lunar', gender: null, reportHtml: null, chartContext: null,
    chartId: null, conversationId: null, streaming: false, adminConfigured: false,
    guest: null, user: null,
    loadId: new URLSearchParams(location.search).get('load'),
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = (text) => {
    try { return DOMPurify.sanitize(marked.parse(text || '')); }
    catch { return esc(text); }
  };

  function init() {
    try {
      // 鉴权：游客免登录（5.1）— 未登录不再跳转，改为游客模式
      fetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then((me) => {
        if (me && me.user) applyLoggedInUI(me.user);
        else applyGuestUI();
      }).catch(() => applyGuestUI());

      // 导航：登录/注册入口（游客态显示）
      withEl('btnLogin', (e) => { e.onclick = () => openAuth('login'); });
      withEl('btnLogout', (e) => { e.onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); }; });

      // 游客注册 / 登录浮层
      withEl('authClose', (e) => { e.onclick = closeAuth; });
      withEl('authMask', (e) => { e.addEventListener('click', (ev) => { if (ev.target === e) closeAuth(); }); });
      withEl('authTabLogin', (e) => { e.onclick = () => setAuthTab('login'); });
      withEl('authTabReg', (e) => { e.onclick = () => setAuthTab('reg'); });
      withEl('btnAuthLogin', (e) => { e.onclick = () => doAuth('login'); });
      withEl('btnAuthReg', (e) => { e.onclick = () => doAuth('reg'); });
      // 游客排盘后「保存到账号」→ 打开注册浮层，注册后自动并入
      withEl('btnSaveAccount', (e) => { e.onclick = () => openAuth('reg'); });

      // 段选
      withEl('calSeg', (e) => { e.onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; e.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); state.calendar = b.dataset.cal; }; });
      withEl('genderSeg', (e) => { e.onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; e.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); state.gender = Number(b.dataset.g); }; });

      // 移动端三标签切换（推演 / 报告 / 问答）
      withEl('mTabs', (tabs) => {
        tabs.querySelectorAll('button').forEach((b) => {
          b.onclick = () => {
            const tab = b.dataset.tab;
            tabs.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            document.querySelectorAll('.studio .col').forEach((col) => {
              col.classList.toggle('active', col.dataset.pane === tab);
            });
          };
        });
      });

      // 出生地实时识别（前端预校验，提升「找不到」的反馈速度）
      let geoTimer = null;
      withEl('location', (loc) => {
        loc.addEventListener('input', () => {
          const v = loc.value.trim();
          clearTimeout(geoTimer);
          withEl('geoHint', (h) => { h.textContent = ''; h.className = 'geo-hint'; });
          if (!v) return;
          geoTimer = setTimeout(async () => {
            withEl('geoHint', (h) => { h.className = 'geo-hint loading'; h.textContent = '识别中…'; });
            try {
              const r = await fetch('/api/geocode?q=' + encodeURIComponent(v));
              const d = await r.json();
              withEl('geoHint', (h) => {
                if (d.found) { h.className = 'geo-hint ok'; h.textContent = `✓ 已识别：${d.label}（经度 ${d.longitude}°E）`; }
                else { h.className = 'geo-hint warn'; h.textContent = '⚠️ 未识别，可直接填经度（如 105.72）'; }
              });
            } catch {
              withEl('geoHint', (h) => { h.textContent = ''; h.className = 'geo-hint'; });
            }
          }, 500);
        });
      });

      fetch('/api/cities').then((r) => r.ok ? r.json() : null).then((d) => {
        if (!d) return;
        withEl('cityList', (list) => {
          (d.cities || []).forEach((c) => { const o = document.createElement('option'); o.value = c; list.appendChild(o); });
        });
      }).catch(() => {});
      fetch('/api/config').then((r) => r.ok ? r.json() : null).then((d) => {
        if (!d) return;
        state.adminConfigured = !!d.adminConfigured;
        refreshLlm();
      }).catch(() => {});

      // 推演
      withEl('btnSubmit', (b) => { b.onclick = async () => {
        const date = (($('date') || {}).value || '').trim();
        const time = (($('time') || {}).value || '').trim() || '00:00';
        const location = (($('location') || {}).value || '').trim();
        if (!date) { withEl('status', (s) => { s.textContent = '⚠️ 请填写出生日期'; }); return; }
        if (!state.gender) { withEl('status', (s) => { s.textContent = '⚠️ 请选择性别'; }); return; }
        const body = { calendar: state.calendar, date, time, gender: state.gender, location };
        const sy = (($('startY') || {}).value || '').trim(), ey = (($('endY') || {}).value || '').trim();
        if (sy && ey) body.fortune = { level: 'month', startDateTime: `${sy}-01-01`, endDateTime: `${ey}-12-31` };
        b.disabled = true;
        withEl('status', (s) => { s.textContent = '⏳ 正在推演…'; });
        try {
          const res = await fetch('/api/chart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const data = await res.json();
          if (!res.ok) {
            if (data.needLogin) { openAuth('reg'); throw new Error(data.error || '该设备排盘频次已达上限，注册账号可解锁无限推演'); }
            throw new Error(data.error || '推演失败');
          }
          state.reportHtml = data.reportHtml; state.chartContext = data.chartContext; state.chartId = data.id;
          renderReport(data.reportHtml);
          withEl('chatBody', (cb) => { cb.innerHTML = ''; });
          withEl('chatEmpty', (ce) => { ce.style.display = 'none'; });
          const loaded = await loadConversation(data.id);
          if (!loaded) addMsg('ai', `已为你排出命盘：${data.chart.pillars.join(' ')}，日主 ${data.chart.dayMaster}。\n可就事业、感情、财运、健康或近期流月继续追问。`);
          withEl('status', (s) => { s.textContent = '✅ 报告已生成并保存'; });
          if (data.guest) withEl('btnSaveAccount', (e) => { e.style.display = ''; });
          switchPane('report');
          loadRecent();
        } catch (e) {
          withEl('status', (s) => { s.textContent = '❌ ' + (e.message || '推演失败'); });
          console.error('[chart]', e);
        } finally {
          b.disabled = false;
          refreshLlm();
        }
      }; });

      // 全屏 / 导出 / 打印
      withEl('btnExport', (b) => { b.onclick = () => {
        if (!state.reportHtml) return;
        const blob = new Blob([state.reportHtml], { type: 'text/html;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `辰箓命盘-${Date.now()}.html`; a.click(); URL.revokeObjectURL(a.href);
      }; });
      withEl('btnPrint', (b) => { b.onclick = () => {
        withEl('reportFrame', (f) => { if (f.contentWindow) f.contentWindow.print(); });
      }; });
      withEl('btnFull', (b) => { b.onclick = () => {
        withEl('reportCol', (col) => {
          const on = col.classList.toggle('fullscreen');
          b.textContent = on ? '✕ 退出全屏' : '⛶ 全屏';
        });
      }; });

      // 聊天 send（Markdown）
      withEl('btnSend', (b) => { b.onclick = send; });
      withEl('chatText', (t) => { t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }); });

      loadRecent();
      if (state.loadId) loadChart(state.loadId);
      refreshLlm();
    } catch (err) {
      console.error('[studio init]', err);
    }
  }

  function switchPane(tab) {
    const tabs = $('mTabs'); if (!tabs) return;
    const btn = tabs.querySelector(`button[data-tab="${tab}"]`);
    if (btn) btn.click();
  }
  function refreshLlm() {
    const ok = state.adminConfigured;
    withEl('llmDot', (e) => { e.className = 'dot ' + (ok ? 'ok' : 'off'); });
    if (!state.streaming) {
      withEl('llmStatus', (e) => {
        if (!ok) e.textContent = '未配置模型（联系管理员）';
        else if (state.guest) e.textContent = '游客模式 · 剩 3 轮免费问答';
        else e.textContent = '已接入模型';
      });
    }
    withEl('btnSend', (e) => { e.disabled = !ok || !state.chartContext || state.streaming; });
  }
  function setLlmStatus(text) { withEl('llmStatus', (e) => { e.textContent = text; }); }
  function setSendLoading(on) {
    withEl('btnSend', (e) => { e.classList.toggle('loading', !!on); e.disabled = !!on; });
  }
  function addThinkingBubble() {
    return withEl('chatBody', (cb) => {
      const el = document.createElement('div');
      el.className = 'msg thinking';
      el.innerHTML = '<span class="sigil"></span><span class="label">辰箓推演中</span><span class="dots"><span>.</span><span>.</span><span>.</span></span>';
      cb.appendChild(el);
      cb.scrollTop = cb.scrollHeight;
      return el;
    });
  }
  // 用 className 找，避免回调闭包中 thinkingEl 引用失效导致 remove 失败
  function removeThinkingBubble() {
    const t = document.querySelector('#chatBody .msg.thinking');
    if (t) { try { t.remove(); } catch {} return true; }
    return false;
  }

  function renderReport(html) {
    withEl('reportFrame', (f) => { f.style.display = 'block'; f.srcdoc = html; });
    withEl('reportPlaceholder', (e) => { e.style.display = 'none'; });
  }

  function addMsg(role, text, asHtml) {
    let el = null;
    withEl('chatBody', (cb) => {
      el = document.createElement('div');
      el.className = 'msg ' + role;
      if (asHtml) el.innerHTML = text; else el.textContent = text;
      cb.appendChild(el);
      cb.scrollTop = cb.scrollHeight;
    });
    return el;
  }

  async function send() {
    const textEl = $('chatText'); if (!textEl) return;
    const text = textEl.value.trim(); if (!text || state.streaming) return;
    if (!state.adminConfigured) { withEl('status', (s) => { s.textContent = '⚠️ 模型未配置，请联系管理员在后台设置'; }); return; }
    if (!state.chartContext) { withEl('status', (s) => { s.textContent = '⚠️ 请先推演命盘'; }); return; }

    addMsg('user', text);
    textEl.value = '';
    // 5.2：只传最新一条 user 消息 + 会话/命盘上下文；历史由服务端从 DB 拼装

    // 推演态
    state.streaming = true;
    setLlmStatus('辰箓推演中…');
    setSendLoading(true);
    const thinkingEl = addThinkingBubble();

    const payload = {
      message: { role: 'user', content: text },
      chartId: state.chartId,
      chartContext: state.chartContext,
      conversationId: state.conversationId,
    };

    let aiEl = null;
    let acc = '';
    let firstByteSeen = false;
    const ctrl = new AbortController();
    // 首字节定时器：qwen3.7-plus 思考+缓存首字经常 15-30s，给到 40s 上限
    const FIRST_BYTE_LIMIT_MS = 40000;
    const firstByteTimer = setTimeout(() => {
      if (firstByteSeen) return;
      removeThinkingBubble();
      const t = document.querySelector('#chatBody .msg.thinking');
      if (t) { t.classList.add('timeout'); t.innerHTML = '⚠️ 模型响应较慢（>40s），可重试或切换模型'; }
      try { ctrl.abort(); } catch {}
    }, FIRST_BYTE_LIMIT_MS);
    // 提示文案渐进：6s 后告诉用户"正在连接模型"，让用户安心（不必干等）
    const slowHintTimer = setTimeout(() => {
      if (firstByteSeen) return;
      const t = document.querySelector('#chatBody .msg.thinking');
      if (t && !t.classList.contains('timeout')) {
        const lbl = t.querySelector('.label');
        if (lbl) lbl.textContent = '正在与 AI 模型建立连接（首次略慢，请稍候）';
      }
    }, 6000);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: ctrl.signal,
      });
      // 5.2：绑定服务端返回的新会话 id（首条消息时由服务端创建）
      const cid = res.headers.get('X-Conversation-Id');
      if (cid) state.conversationId = cid;
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        removeThinkingBubble();
        if (d.needLogin) {
          addMsg('ai',
            '🔒 你已体验完游客版 3 轮免费问答<br/>' +
            '登录后即可解锁：<br/>' +
            '· <b>不限轮次</b>紫微斗数 AI 答疑<br/>' +
            '· <b>云端永久保存</b>所有命盘与历史<br/>' +
            '· 完整版天机阁 · 推演阁', true);
          openAuth('reg');
          return;
        }
        const msg = d.error || ('请求失败 ' + res.status);
        addMsg('ai', '⚠️ ' + msg, false);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstByteSeen) {
          firstByteSeen = true;
          clearTimeout(firstByteTimer);
          clearTimeout(slowHintTimer);
          // 首字节抵达：移除 thinking，启正式 ai bubble
          removeThinkingBubble();
          aiEl = addMsg('ai', '');
          setLlmStatus('正在生成…');
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim(); if (!t.startsWith('data:')) continue;
          const p = t.slice(5).trim(); if (p === '[DONE]') continue;
          try {
            const j = JSON.parse(p);
            if (j.text) {
              acc += j.text;
              if (aiEl) { aiEl.innerHTML = md(acc); withEl('chatBody', (cb) => { cb.scrollTop = cb.scrollHeight; }); }
            }
            if (j.error) {
              removeThinkingBubble();
              if (!aiEl) aiEl = addMsg('ai', '⚠️ ' + j.error, false);
              else aiEl.textContent = '⚠️ ' + j.error;
              clearTimeout(firstByteTimer);
              clearTimeout(slowHintTimer);
              return;
            }
          } catch {}
        }
      }
      // 流正常结束
      if (aiEl) aiEl.innerHTML = md(acc);
      if (!aiEl) removeThinkingBubble();
      setLlmStatus(acc ? '已接收答复' : '');
    } catch (e) {
      if (e.name === 'AbortError') {
        const t = document.querySelector('#chatBody .msg.thinking');
        if (t && !t.classList.contains('timeout')) {
          t.classList.add('timeout');
          t.innerHTML = '⚠️ 已中止推演';
        }
      } else if (aiEl) {
        aiEl.textContent = '⚠️ ' + (e.message || '对话失败');
      } else {
        removeThinkingBubble();
        addMsg('ai', '⚠️ ' + (e.message || '对话失败'), false);
      }
      console.error('[chat]', e);
    } finally {
      state.streaming = false;
      setSendLoading(false);
      refreshLlm();
    }
  }

  async function loadRecent() {
    try {
      const r = await fetch('/api/charts');
      const data = await (r.ok ? r.json() : null);
      withEl('recentBox', (box) => {
        if (!data || !data.charts || !data.charts.length) { box.innerHTML = '<div class="hint">暂无记录</div>'; return; }
        box.innerHTML = data.charts.map((c) => `<div class="item" data-id="${c.id}"><div class="p">${(c.pillars || []).join(' ')}</div><div class="t">${new Date(c.created_at).toLocaleString('zh-CN')}</div></div>`).join('');
        box.querySelectorAll('.item').forEach((el) => el.onclick = () => loadChart(el.dataset.id));
      });
    } catch (e) { console.warn('[loadRecent]', e); }
  }
  async function loadChart(id) {
    try {
      const r = await fetch('/api/charts/' + id);
      const data = await (r.ok ? r.json() : null);
      if (!data) return;
      state.reportHtml = data.reportHtml; state.chartContext = data.chartContext; state.chartId = id;
      renderReport(data.reportHtml);
      withEl('chatBody', (cb) => { cb.innerHTML = ''; });
      withEl('chatEmpty', (ce) => { ce.style.display = 'none'; });
      const loaded = await loadConversation(id);
      if (!loaded) addMsg('ai', `已载入命盘：${data.chart.pillars.join(' ')}，日主 ${data.chart.dayMaster}。可继续追问。`);
      withEl('status', (s) => { s.textContent = '✅ 已载入历史命盘'; });
      switchPane('report');
    } catch (e) { console.warn('[loadChart]', e); }
  }

  // ── 对话历史还原（5.2）：按 chartId 加载对应会话及其消息 ──
  async function loadConversation(chartId) {
    if (!chartId) return false;
    try {
      const r = await fetch('/api/conversations?chartId=' + encodeURIComponent(chartId));
      const d = await (r.ok ? r.json() : null);
      if (!d || !d.conversation) { state.conversationId = null; return false; }
      state.conversationId = d.conversation.id;
      const msgs = d.conversation.messages || [];
      withEl('chatBody', (cb) => { cb.innerHTML = ''; });
      withEl('chatEmpty', (ce) => { ce.style.display = 'none'; });
      if (!msgs.length) return false; // 会话存在但尚无消息 → 交由调用方显示欢迎语
      // 历史消息：assistant 走 md() 渲染并 DOMPurify 净化；user 纯文本（与流式一致）
      msgs.forEach((m) => {
        if (m.role === 'assistant') addMsg('assistant', md(m.content), true);
        else addMsg('user', m.content, false);
      });
      return true;
    } catch (e) { console.warn('[loadConversation]', e); return false; }
  }

  // ── 游客登录 / 注册浮层（5.1）──
  function applyLoggedInUI(user) {
    state.user = user; state.guest = false;
    withEl('uname', (e) => { e.textContent = user.nickname || user.username; e.style.display = ''; });
    withEl('avatar', (e) => { e.textContent = (user.nickname || user.username || '辰')[0]; });
    withEl('btnLogin', (e) => { e.style.display = 'none'; });
    withEl('btnLogout', (e) => { e.style.display = ''; });
    withEl('btnSaveAccount', (e) => { e.style.display = 'none'; });
  }
  function applyGuestUI() {
    state.guest = true; state.user = null;
    withEl('btnLogin', (e) => { e.style.display = ''; });
    withEl('btnLogout', (e) => { e.style.display = 'none'; });
    withEl('btnSaveAccount', (e) => { e.style.display = 'none'; });
  }
  function openAuth(tab) {
    const mask = $('authMask'); if (!mask) return;
    setAuthTab(tab || 'login');
    mask.classList.add('show');
    withEl('authStatus', (e) => { e.textContent = ''; });
  }
  function closeAuth() { const m = $('authMask'); if (m) m.classList.remove('show'); }
  function setAuthTab(tab) {
    const isLogin = tab !== 'reg';
    withEl('authTabLogin', (e) => e.classList.toggle('on', isLogin));
    withEl('authTabReg', (e) => e.classList.toggle('on', !isLogin));
    withEl('authLogin', (e) => { e.style.display = isLogin ? '' : 'none'; });
    withEl('authReg', (e) => { e.style.display = isLogin ? 'none' : ''; });
  }
  async function doAuth(kind) {
    const status = $('authStatus'); if (status) status.textContent = '⏳ 处理中…';
    try {
      let user, merged = 0;
      if (kind === 'login') {
        const username = (($('aLUser') || {}).value || '').trim();
        const password = (($('aLPwd') || {}).value || '');
        if (!username || !password) { if (status) status.textContent = '⚠️ 请输入用户名和密码'; return; }
        const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (status) status.textContent = '⚠️ ' + (d.error || '登录失败'); return; }
        user = d.user;
      } else {
        const username = (($('aRUser') || {}).value || '').trim();
        const nickname = (($('aRNick') || {}).value || '').trim();
        const password = (($('aRPwd') || {}).value || '');
        if (!username || !password) { if (status) status.textContent = '⚠️ 用户名与密码必填'; return; }
        if (password.length < 6) { if (status) status.textContent = '⚠️ 密码至少 6 位'; return; }
        const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, nickname, password }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (status) status.textContent = '⚠️ ' + (d.error || '注册失败'); return; }
        user = d.user; merged = d.merged || 0;
      }
      applyLoggedInUI(user);
      closeAuth();
      loadRecent();
      refreshLlm();
      const saved = merged > 0 ? `，已为你保存 ${merged} 个命盘` : '';
      withEl('status', (s) => { s.textContent = (kind === 'reg' ? '✅ 注册成功' : '✅ 登录成功') + saved; });
    } catch (e) {
      if (status) status.textContent = '⚠️ 网络错误：' + (e.message || '');
    }
  }

  // 等 DOM 解析完成再初始化，避免 race
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
