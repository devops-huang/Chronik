/* 辰箓 · 推演阁：推演命盘 + 右侧报告预览（可全屏）+ Markdown 对话 */
(() => {
  const $ = (id) => document.getElementById(id);
  // 防御性 helper：有元素才执行回调
  const withEl = (id, fn) => { const el = $(id); if (!el) { console.warn('[studio] missing element #' + id); return; } fn(el); };

  const state = {
    calendar: 'lunar', gender: null, reportHtml: null, chartContext: null,
    messages: [], streaming: false, llmPreset: false, serverBase: '', serverModel: '',
    loadId: new URLSearchParams(location.search).get('load'),
  };
  const LS_KEY = 'chenlu_llm_cfg';
  const loadCfg = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
  const saveCfg = (c) => localStorage.setItem(LS_KEY, JSON.stringify(c));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = (text) => {
    try { return DOMPurify.sanitize(marked.parse(text || '')); }
    catch { return esc(text); }
  };

  function init() {
    try {
      // 鉴权
      fetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then((me) => {
        if (!me) { location.href = '/login.html'; return; }
        withEl('uname', (e) => { e.textContent = me.user.nickname || me.user.username; });
        withEl('avatar', (e) => { e.textContent = (me.user.nickname || me.user.username || '辰')[0]; });
      }).catch(() => {});

      withEl('btnLogout', (e) => { e.onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; }; });

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
        state.llmPreset = !!d.llmPreset; state.serverBase = d.baseUrl || ''; state.serverModel = d.model || '';
        refreshLlm();
      }).catch(() => {});

      // 设置抽屉
      withEl('btnSettings', (b) => { b.onclick = () => {
        const cfg = loadCfg();
        withEl('cfgBase', (e) => { e.value = cfg.baseUrl || state.serverBase || 'https://api.deepseek.com/v1'; });
        withEl('cfgKey',  (e) => { e.value = cfg.apiKey || ''; });
        withEl('cfgModel',(e) => { e.value = cfg.model || state.serverModel || 'deepseek-chat'; });
        withEl('cfgHint', (e) => { e.style.display = state.llmPreset ? 'block' : 'none'; });
        withEl('drawer',  (e) => { e.style.display = 'block'; });
      }; });
      withEl('cfgClose', (e) => { e.onclick = () => withEl('drawer', (d) => { d.style.display = 'none'; }); });
      withEl('drawer',  (e) => { e.onclick = (ev) => { if (ev.target === e) e.style.display = 'none'; }; });
      withEl('cfgSave', (e) => { e.onclick = () => {
        const baseUrl = (($('cfgBase') || {}).value || '').trim();
        const apiKey  = (($('cfgKey')  || {}).value || '').trim();
        const model   = (($('cfgModel')|| {}).value || '').trim();
        saveCfg({ baseUrl, apiKey, model });
        withEl('drawer', (d) => { d.style.display = 'none'; });
        refreshLlm();
      }; });

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
          if (!res.ok) throw new Error(data.error || '推演失败');
          state.reportHtml = data.reportHtml; state.chartContext = data.chartContext; state.messages = [];
          renderReport(data.reportHtml);
          withEl('chatBody', (cb) => { cb.innerHTML = ''; });
          withEl('chatEmpty', (ce) => { ce.style.display = 'none'; });
          addMsg('ai', `已为你排出命盘：${data.chart.pillars.join(' ')}，日主 ${data.chart.dayMaster}。\n可就事业、感情、财运、健康或近期流月继续追问。`);
          withEl('status', (s) => { s.textContent = '✅ 报告已生成并保存'; });
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
    const cfg = loadCfg();
    const ok = (cfg.baseUrl && cfg.apiKey && cfg.model) || state.llmPreset;
    withEl('llmDot', (e) => { e.className = 'dot ' + (ok ? 'ok' : 'off'); });
    if (!state.streaming) {
      withEl('llmStatus', (e) => { e.textContent = ok ? `已接入：${cfg.model || state.serverModel || ''}` : '未配置模型'; });
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
    const cfg = loadCfg(); const localFull = cfg.baseUrl && cfg.apiKey && cfg.model;
    if (!localFull && !state.llmPreset) { withEl('drawer', (d) => { d.style.display = 'block'; }); return; }
    if (!state.chartContext) { withEl('status', (s) => { s.textContent = '⚠️ 请先推演命盘'; }); return; }

    state.messages.push({ role: 'user', content: text });
    addMsg('user', text);
    textEl.value = '';

    // 推演态
    state.streaming = true;
    setLlmStatus('辰箓推演中…');
    setSendLoading(true);
    const thinkingEl = addThinkingBubble();

    const payload = localFull ? { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, messages: state.messages, chartContext: state.chartContext }
      : { messages: state.messages, chartContext: state.chartContext };

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
    // 提示文案渐进：12s 后告诉用户还在思考
    const slowHintTimer = setTimeout(() => {
      if (firstByteSeen) return;
      const t = document.querySelector('#chatBody .msg.thinking');
      if (t && !t.classList.contains('timeout')) {
        const lbl = t.querySelector('.label');
        if (lbl) lbl.textContent = '模型思考中（首字偏慢，请稍候）';
      }
    }, 12000);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: ctrl.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        const msg = d.error || ('请求失败 ' + res.status);
        removeThinkingBubble();
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
      state.messages.push({ role: 'assistant', content: acc });
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
      state.reportHtml = data.reportHtml; state.chartContext = data.chartContext; state.messages = [];
      renderReport(data.reportHtml);
      withEl('chatBody', (cb) => { cb.innerHTML = ''; });
      withEl('chatEmpty', (ce) => { ce.style.display = 'none'; });
      addMsg('ai', `已载入命盘：${data.chart.pillars.join(' ')}，日主 ${data.chart.dayMaster}。可继续追问。`);
      withEl('status', (s) => { s.textContent = '✅ 已载入历史命盘'; });
      switchPane('report');
    } catch (e) { console.warn('[loadChart]', e); }
  }

  // 等 DOM 解析完成再初始化，避免 race
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
