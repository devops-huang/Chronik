/* 八字命盘系统 · 前端逻辑 */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    calendar: 'lunar',
    gender: 1,
    reportHtml: null,
    chartContext: null,
    messages: [],
    streaming: false,
    llmPreset: false,
    serverBase: '',
    serverModel: '',
  };

  // ── 设置持久化 ──
  const LS_KEY = 'bazi_llm_cfg';
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
  }
  function saveCfg(cfg) { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }

  // ── 历法 / 性别 段选 ──
  $('calSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('calSeg').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.calendar = b.dataset.cal;
  });
  $('genderSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('genderSeg').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.gender = Number(b.dataset.g);
  });

  // ── 城市列表 ──
  fetch('/api/cities').then((r) => r.json()).then((d) => {
    const dl = $('cityList');
    (d.cities || []).forEach((c) => { const o = document.createElement('option'); o.value = c; dl.appendChild(o); });
  }).catch(() => {});

  // ── 服务端模型预设（密钥在服务端，前端不接触） ──
  fetch('/api/config').then((r) => r.json()).then((d) => {
    state.llmPreset = !!d.llmPreset;
    state.serverBase = d.baseUrl || '';
    state.serverModel = d.model || '';
    refreshLlmStatus();
  }).catch(() => {});

  // ── 设置抽屉 ──
  function refreshLlmStatus() {
    const cfg = loadCfg();
    const localFull = cfg.baseUrl && cfg.apiKey && cfg.model;
    const ok = localFull || state.llmPreset;
    $('llmDot').className = 'dot ' + (ok ? 'ok' : 'off');
    const modelName = cfg.model || state.serverModel || '';
    $('llmStatus').textContent = ok ? `已接入：${modelName}` : '未配置模型';
    $('btnSend').disabled = !ok || !state.chartContext || state.streaming;
  }
  $('btnSettings').addEventListener('click', () => {
    const cfg = loadCfg();
    $('cfgBase').value = cfg.baseUrl || state.serverBase || 'https://api.deepseek.com/v1';
    $('cfgKey').value = cfg.apiKey || '';
    $('cfgModel').value = cfg.model || state.serverModel || 'deepseek-chat';
    $('cfgHint').style.display = state.llmPreset ? 'block' : 'none';
    $('drawer').classList.add('open');
  });
  $('cfgClose').addEventListener('click', () => $('drawer').classList.remove('open'));
  $('drawer').addEventListener('click', (e) => { if (e.target === $('drawer')) $('drawer').classList.remove('open'); });
  $('cfgSave').addEventListener('click', () => {
    saveCfg({ baseUrl: $('cfgBase').value.trim(), apiKey: $('cfgKey').value.trim(), model: $('cfgModel').value.trim() });
    $('drawer').classList.remove('open');
    refreshLlmStatus();
  });

  // ── 排盘 ──
  $('btnSubmit').addEventListener('click', async () => {
    const date = $('date').value.trim();
    const time = $('time').value.trim() || '00:00';
    const location = $('location').value.trim();
    if (!date) { $('status').textContent = '⚠️ 请填写出生日期'; return; }
    const body = { calendar: state.calendar, date, time, gender: state.gender, location, enableTrueSolar: true };
    const sy = $('startY').value.trim(), ey = $('endY').value.trim();
    if (sy && ey) body.fortune = { level: 'month', startDateTime: `${sy}-01-01`, endDateTime: `${ey}-12-31` };

    $('btnSubmit').disabled = true; $('status').textContent = '⏳ 正在排盘…';
    try {
      const res = await fetch('/api/chart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '排盘失败');
      state.reportHtml = data.reportHtml;
      state.chartContext = data.chartContext;
      state.messages = [];
      renderReport(data.reportHtml);
      // 重置聊天
      $('chatBody').innerHTML = '';
      $('chatEmpty').style.display = 'none';
      addMsg('ai', `已为你排出命盘：${data.chart.pillars.join(' ')}，日主 ${data.chart.dayMaster}。\n可就事业、感情、财运、健康或近期流月继续追问，我都会基于这份命盘作答。`);
      $('btnExport').disabled = false; $('btnPrint').disabled = false;
      $('status').textContent = '✅ 报告已生成';
    } catch (e) {
      $('status').textContent = '❌ ' + e.message;
    } finally {
      $('btnSubmit').disabled = false;
      refreshLlmStatus();
    }
  });

  function renderReport(html) {
    const frame = $('reportFrame');
    frame.style.display = 'block';
    $('reportPlaceholder').style.display = 'none';
    frame.srcdoc = html;
  }

  $('btnExport').addEventListener('click', () => {
    if (!state.reportHtml) return;
    const blob = new Blob([state.reportHtml], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `八字命盘-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('btnPrint').addEventListener('click', () => {
    const frame = $('reportFrame');
    if (frame.contentWindow) frame.contentWindow.print();
  });

  // ── 聊天 ──
  function addMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    $('chatBody').appendChild(el);
    $('chatBody').scrollTop = $('chatBody').scrollHeight;
    return el;
  }

  async function send() {
    const text = $('chatText').value.trim();
    if (!text || state.streaming) return;
    const cfg = loadCfg();
    const localFull = cfg.baseUrl && cfg.apiKey && cfg.model;
    if (!localFull && !state.llmPreset) { $('drawer').classList.add('open'); return; }
    if (!state.chartContext) { $('status').textContent = '⚠️ 请先排盘'; return; }

    state.messages.push({ role: 'user', content: text });
    addMsg('user', text);
    $('chatText').value = '';

    const aiEl = addMsg('ai', '');
    const textNode = document.createTextNode('');
    const cursor = document.createElement('span'); cursor.className = 'cursor';
    aiEl.appendChild(textNode); aiEl.appendChild(cursor);
    state.streaming = true; refreshLlmStatus();

    // 服务端已预设密钥时，前端不必传 key，由后端用环境变量补全
    const payload = localFull
      ? { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, messages: state.messages, chartContext: state.chartContext }
      : { messages: state.messages, chartContext: state.chartContext };

    let acc = '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || ('请求失败 ' + res.status));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json.text) { acc += json.text; textNode.textContent = acc; $('chatBody').scrollTop = $('chatBody').scrollHeight; }
            if (json.error) throw new Error(json.error);
          } catch (e) { if (e.message) throw e; }
        }
      }
      aiEl.removeChild(cursor);
      state.messages.push({ role: 'assistant', content: acc });
    } catch (e) {
      aiEl.textContent = '⚠️ ' + e.message;
    } finally {
      state.streaming = false; refreshLlmStatus();
    }
  }

  $('btnSend').addEventListener('click', send);
  $('chatText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  refreshLlmStatus();
})();
