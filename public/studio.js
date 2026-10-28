/* 辰箓 · 推演阁：推演命盘 + 右侧报告预览（可全屏）+ Markdown 对话 */
(() => {
  const $ = (id) => document.getElementById(id);
  // 防御性 helper：有元素才执行回调
  const withEl = (id, fn) => { const el = $(id); if (!el) { console.warn('[studio] missing element #' + id); return; } fn(el); };

  const state = {
    calendar: 'lunar', gender: null, reportHtml: null, chartContext: null,
    chartId: null, conversationId: null, streaming: false, adminConfigured: false,
    guest: null, user: null,
    messages: [], llmPreset: false, serverBase: '', serverModel: '',
    loadId: new URLSearchParams(location.search).get('load'),
  };
  // R1† · L3 角色声明（会话首条 + 流式尾注固定展示，不可被模型覆盖）
  const L3_DISCLAIMER = () => T('studio.l3Disclaimer');
  function ensureL3First() {
    withEl('chatBody', (cb) => {
      if (cb.querySelector('.msg.l3') || cb.children.length > 0) return;
      const el = document.createElement('div');
      el.className = 'msg l3';
      el.textContent = '💡 ' + L3_DISCLAIMER();
      cb.appendChild(el);
    });
  }
  function appendL3Tail() {
    withEl('chatBody', (cb) => {
      const el = document.createElement('div');
      el.className = 'l3-tail';
      el.textContent = T('studio.l3Tail');
      cb.appendChild(el);
      cb.scrollTop = cb.scrollHeight;
    });
  }
  // P0-9 · 输出侧软改写：渲染服务端下发的 disclaimer event（视觉区分块，不混入 AI 正文）。
  // 复用 l3-tail 的灰字调性，外层加分隔线与图标，强化"非正文"边界。
  function renderStreamDisclaimer(level, text) {
    if (!text) return;
    state.gotStreamDisclaimer = true;
    withEl('chatBody', (cb) => {
      const wrap = document.createElement('div');
      wrap.className = 'ai-disclaimer' + (level === 'L3' ? ' l3' : '');
      const sep = document.createElement('div'); sep.className = 'ai-disclaimer-sep';
      const p = document.createElement('div'); p.className = 'ai-disclaimer-text';
      p.textContent = (level === 'L3' ? '🛟 ' : 'ℹ️ ') + text;
      wrap.appendChild(sep); wrap.appendChild(p);
      cb.appendChild(wrap);
      cb.scrollTop = cb.scrollHeight;
    });
  }
  let toastTimer = null; // W1-④ · 带走链接提示的自动隐藏定时器
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── i18n 助手 ──
  // 术语口径（经交叉验证）：cast a chart / Four Pillars / Day Master / luck pillar /
  // annual pillar / Life Palace / solar term / Chinese almanac / BaZi / Kau Cim / Tai Sui
  const T = (k, vars) => (window.i18n ? window.i18n.t(k, vars) : k);
  const LANG = () => (window.i18n ? window.i18n.lang() : 'zh');
  const LOCALE = () => ({ zh: 'zh-CN', pt: 'pt-BR', en: 'en' }[LANG()] || 'en');
  const fmtTime = (v) => { try { return new Date(v).toLocaleString(LOCALE()); } catch (e) { return ''; } };
  const md = (text) => {
    try { return DOMPurify.sanitize(marked.parse(text || '')); }
    catch { return esc(text); }
  };
  // R3 · 业务埋点：单端点上报（静默失败，绝不阻断主流程）
  function trackEvent(action, payload) {
    try {
      fetch('/api/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload: payload || {} }), keepalive: true,
      });
    } catch (e) { /* 埋点失败不阻断业务 */ }
  }

  function init() {
    try {
      // 鉴权：游客免登录（5.1）— 未登录不再跳转，改为游客模式
      fetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then((me) => {
        if (me && me.user) { applyLoggedInUI(me.user); refreshQuota(); }
        else applyGuestUI();
      }).catch(() => applyGuestUI());

      // I3 · 兑换成功后跨页刷新付费态（pricing.html 通过 BroadcastChannel / storage 广播）
      try {
        if (window.BroadcastChannel) {
          const bc = new BroadcastChannel('cl_entitlement');
          bc.onmessage = (e) => { if (e.data && e.data.type === 'redeem_success') refreshQuota(); };
        }
      } catch {}
      window.addEventListener('storage', (e) => { if (e.key === 'cl_entitlement_updated') refreshQuota(); });

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
            withEl('geoHint', (h) => { h.className = 'geo-hint loading'; h.textContent = T('studio.geoLoading'); });
            try {
              const r = await fetch('/api/geocode?q=' + encodeURIComponent(v));
              const d = await r.json();
              withEl('geoHint', (h) => {
                if (d.found) { h.className = 'geo-hint ok'; h.textContent = T('studio.geoOk', { label: d.label, lon: d.longitude }); }
                else { h.className = 'geo-hint warn'; h.textContent = T('studio.geoFail'); }
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
        state.adminConfigured = !!d.llmPreset; // R10a：字段改名，模型就绪判定不变
        const icp = document.getElementById('icp-no'); if (icp) icp.innerHTML = '<a href="https://beian.miit.gov.cn" target="_blank" rel="noopener">' + (d.icpNo || '粤ICP备2026138936号-1') + '</a>';
        refreshLlm();
      }).catch(() => {});

      // 推演
      withEl('btnSubmit', (b) => { b.onclick = async () => {
        const date = (($('date') || {}).value || '').trim();
        const time = (($('time') || {}).value || '').trim() || '00:00';
        const location = (($('location') || {}).value || '').trim();
        if (!date) { withEl('status', (s) => { s.textContent = T('studio.errDate'); }); return; }
        if (!state.gender) { withEl('status', (s) => { s.textContent = T('studio.errGender'); }); return; }
        const body = { calendar: state.calendar, date, time, gender: state.gender, location };
        const sy = (($('startY') || {}).value || '').trim(), ey = (($('endY') || {}).value || '').trim();
        if (sy && ey) body.fortune = { level: 'month', startDateTime: `${sy}-01-01`, endDateTime: `${ey}-12-31` };
        b.disabled = true;
        withEl('status', (s) => { s.textContent = T('studio.charting'); });
        try {
          const res = await fetch('/api/chart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const data = await res.json();
          if (!res.ok) {
            if (data.needLogin) { openAuth('reg'); throw new Error(data.error || T('studio.errQuota')); }
            throw new Error(data.error || T('studio.errChart'));
          }
          state.reportHtml = data.reportHtml; state.chartContext = data.chartContext; state.chartId = data.id;
          renderReport(data.reportHtml);
          withEl('chatBody', (cb) => { cb.innerHTML = ''; });
          withEl('chatEmpty', (ce) => { ce.style.display = 'none'; });
          const loaded = await loadConversation(data.id);
          if (!loaded) addMsg('ai', T('studio.chartDone', { pillars: data.chart.pillars.join(' '), dayMaster: data.chart.dayMaster }));
          withEl('status', (s) => { s.textContent = T('studio.chartSaved'); });
          trackEvent('chart_done', { chartId: data.id });
          trackEvent('report_viewed', { chartId: data.id });
          if (data.guest) withEl('btnSaveAccount', (e) => { e.style.display = ''; });
          switchPane('report');
          loadRecent();
        } catch (e) {
          withEl('status', (s) => { s.textContent = '❌ ' + (e.message || T('studio.errChart')); });
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
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ChenLu-chart-${Date.now()}.html`; a.click(); URL.revokeObjectURL(a.href);
      }; });
      withEl('btnPrint', (b) => { b.onclick = () => {
        withEl('reportFrame', (f) => { if (f.contentWindow) f.contentWindow.print(); });
      }; });
      withEl('btnFull', (b) => { b.onclick = () => {
        withEl('reportCol', (col) => {
          const on = col.classList.toggle('fullscreen');
          b.textContent = on ? T('studio.exitFullscreen') : T('studio.fullscreen');
        });
      }; });

      // W1-④ · 破站内信死锁：结果页「带走回访问入口」→ 复制 /r?ref=… 让用户自携
      withEl('btnTakeLink', (b) => { b.onclick = () => { takeRecallLink(b); }; });

      // 聊天 send（Markdown）
      withEl('btnSend', (b) => { b.onclick = send; });
      // R1-5 · 页脚举报入口
      withEl('reportBtn', (b) => { b.onclick = async () => {
        const detail = (window.prompt && window.prompt(T('studio.reportPrompt'))) || '';
        if (!detail.trim()) return;
        try {
          const r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detail: detail.trim(), target: 'ai' }) });
          window.alert(r.ok ? T('studio.reportOk') : T('studio.reportFail'));
        } catch { window.alert(T('studio.reportFail')); }
      }; });
      withEl('chatText', (t) => { t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }); });

      // 语言切换：静态标注由 i18n 引擎处理，这里刷新由 JS 动态渲染的文案
      document.addEventListener('langchange', () => {
        refreshLlm();
        refreshQuota();
        loadRecent();
        withEl('btnFull', (b) => {
          const col = $('reportCol');
          b.textContent = (col && col.classList.contains('fullscreen')) ? T('studio.exitFullscreen') : T('studio.fullscreen');
        });
      });

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
        if (!ok) e.textContent = T('studio.llmNone');
        else if (state.guest) e.textContent = T('studio.llmGuest');
        else e.textContent = T('studio.llmReady');
      });
    }
    withEl('btnSend', (e) => { e.disabled = !ok || !state.chartContext || state.streaming; });
  }
  function setLlmStatus(text) { withEl('llmStatus', (e) => { e.textContent = text; }); }
  function setSendLoading(on) {
    withEl('btnSend', (e) => {
      e.classList.toggle('loading', !!on);
      e.disabled = !!on;
      // 原为 CSS ::after 硬编码中文，改由词库驱动以便跟随语言切换
      const lbl = e.querySelector('.lbl');
      if (lbl) lbl.textContent = on ? T('studio.thinkingShort') : T('studio.send');
    });
  }
  // I3 · 付费态 / 额度展示：登录后拉取 /api/quota，显示「今日剩 X 轮」+ 结缘堂徽标
  function refreshQuota() {
    fetch('/api/quota').then((r) => r.ok ? r.json() : null).then((d) => {
      if (!d) return;
      const vip = $('vipBadge'), q = $('quotaBadge');
      if (d.isPaid) {
        if (vip) vip.style.display = '';
        if (q) { q.style.display = ''; q.textContent = T('studio.quotaUnlimited'); }
        state.guest = false;
      } else {
        if (vip) vip.style.display = 'none';
        if (q) { q.style.display = ''; q.textContent = T('studio.quotaLeft', { n: d.remaining }); }
      }
    }).catch(() => {});
  }

  function addThinkingBubble() {
    return withEl('chatBody', (cb) => {
      const el = document.createElement('div');
      el.className = 'msg thinking';
      el.innerHTML = '<span class="sigil"></span><span class="label">' + esc(T('studio.thinking')) + '</span><span class="dots"><span>.</span><span>.</span><span>.</span></span>';
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

  /* ── W1-④ · 带走回访问入口（A 案「用户自携链接」）───────────────────────────
   * 站内信只在用户回访后可见 → 留存提醒送不出去。解法：让用户自己把 /r?ref=… 带走，
   * 之后凭链接回来。此处负责「取 ref → 拼链接 → 复制到剪贴板（含降级）→ 反馈」。
   */
  const FALLBACK_REF = 'manual'; // 兜底 ref：既无 URL ?ref= 也无站内信时的通用回访入口

  /** 取当前场景的 ref：① URL ?ref=（从 /r 过来时带上）② 最近一条站内信的 ref ③ manual。 */
  async function resolveRecallRef() {
    try {
      const fromUrl = new URLSearchParams(location.search).get('ref');
      if (fromUrl && fromUrl.trim()) return fromUrl.trim();
    } catch { /* URL 解析失败 → 继续降级 */ }
    try {
      const r = await fetch('/api/notifications'); // 未登录 401 → 直接落兜底
      if (r.ok) {
        const d = await r.json().catch(() => null);
        const list = (d && Array.isArray(d.notifications)) ? d.notifications : [];
        for (let i = 0; i < list.length; i += 1) {
          const n = list[i] || {};
          const p = (n.payload && typeof n.payload === 'object') ? n.payload : {};
          const cand = p.ref || n.ref_period || p.ref_period || '';
          if (cand && String(cand).trim()) return String(cand).trim();
        }
      }
    } catch { /* 拉取失败 → 落兜底 */ }
    return FALLBACK_REF;
  }

  /** 拼回访链接：https://<当前域名>/r?ref=<urlencoded ref>。 */
  function buildRecallLink(ref) {
    const origin = (location && location.origin) ? location.origin : '';
    return origin + '/r?ref=' + encodeURIComponent(ref);
  }

  /**
   * 降级复制：textarea + document.execCommand('copy')。
   * 生产当前为 IP + HTTP（非 secure context），navigator.clipboard 会直接失败，
   * 故此路径是 HTTP 下的主力实现，不是可选项。
   * @returns {boolean} 是否复制成功
   */
  function legacyCopy(text) {
    let ok = false;
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '0px';
      ta.style.left = '0px';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.padding = '0px';
      ta.style.border = 'none';
      ta.style.opacity = '0';
      ta.style.zIndex = '-1';
      document.body.appendChild(ta);
      const sel = document.getSelection ? document.getSelection() : null;
      const prevRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
      ta.focus();
      ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, ta.value.length); // iOS 需显式设选区
      ok = !!(document.execCommand && document.execCommand('copy'));
      if (prevRange && sel) { try { sel.removeAllRanges(); sel.addRange(prevRange); } catch { /* 恢复选区失败可忽略 */ } }
    } catch { ok = false; }
    if (ta && ta.parentNode) { try { ta.parentNode.removeChild(ta); } catch { /* 已移除 */ } }
    return ok;
  }

  /**
   * 复制文本：① Clipboard API（HTTPS 生效后自动走这条）② execCommand 降级 ③ 手动复制弹窗。
   * @returns {Promise<'ok'|'manual'|'fail'>}
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return 'ok';
      }
    } catch { /* 非 secure context 或权限被拒 → 降级 */ }
    if (legacyCopy(text)) return 'ok';
    try {
      if (window.prompt) {
        window.prompt(T('studio.copyPrompt'), text);
        return 'manual';
      }
    } catch { /* prompt 被禁用 → 落 fail */ }
    return 'fail';
  }

  /** 黑金风轻提示（复用 style.css 的 CSS 变量，无新依赖）。 */
  function toast(msg) {
    let el = $('takeLinkToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'takeLinkToast';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:38px;transform:translateX(-50%);z-index:200;'
        + 'max-width:86vw;padding:11px 18px;border-radius:12px;font-size:13.5px;line-height:1.6;'
        + 'background:linear-gradient(180deg,var(--panel),var(--panel2));color:var(--gold-bright);'
        + 'border:1px solid var(--gold);box-shadow:var(--shadow);opacity:0;transition:opacity .2s;'
        + 'font-family:var(--font-serif);pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2800);
  }

  /** 「带走回访问入口」主流程。 */
  async function takeRecallLink(btn) {
    let ref = FALLBACK_REF;
    let link = '';
    let result = 'fail';
    try {
      ref = await resolveRecallRef();
      link = buildRecallLink(ref);
      result = await copyText(link);
    } catch (e) {
      console.warn('[takeLink]', e);
      if (!link) link = buildRecallLink(ref);
    }
    if (result === 'ok') toast(T('studio.copyOk'));
    else if (result === 'manual') toast(T('studio.copyManual'));
    else toast(T('studio.copyFail', { link }));
    // 复用白名单内已有的 share_generated（新增 action 需改后端白名单，本批不碰后端）
    trackEvent('share_generated', { kind: 'recall_link', source: 'studio_report', ref, result });
    if (btn) {
      btn.textContent = result === 'ok' ? T('studio.tookAway') : T('studio.copyManualBtn');
      setTimeout(() => { btn.textContent = T('studio.takeLink'); }, 1800);
    }
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
    if (!state.adminConfigured) { withEl('status', (s) => { s.textContent = T('studio.errNoModel'); }); return; }
    if (!state.chartContext) { withEl('status', (s) => { s.textContent = T('studio.errNoChart'); }); return; }

    if (!state.conversationId) ensureL3First(); // R1† · L3 会话首条
    state.gotStreamDisclaimer = false; // P0-9 · 本次请求是否收到服务端 disclaimer event
    addMsg('user', text);
    textEl.value = '';
    // 5.2：只传最新一条 user 消息 + 会话/命盘上下文；历史由服务端从 DB 拼装

    // 推演态
    state.streaming = true;
    setLlmStatus(T('studio.thinkingShort'));
    setSendLoading(true);
    const thinkingEl = addThinkingBubble();

    const payload = {
      message: { role: 'user', content: text },
      chartId: state.chartId,
      chartContext: state.chartContext,
      conversationId: state.conversationId,
    };

    let aiEl = null;
    let aiContent = null;
    let acc = '';
    let sysNoteShown = false; // P0-9 · 标记服务端是否已下发系统免责后缀，避免重复追加通用尾注
    let firstByteSeen = false;
    const ctrl = new AbortController();
    // 首字节定时器：qwen3.7-plus 思考+缓存首字经常 15-30s，给到 40s 上限
    const FIRST_BYTE_LIMIT_MS = 40000;
    const firstByteTimer = setTimeout(() => {
      if (firstByteSeen) return;
      removeThinkingBubble();
      const t = document.querySelector('#chatBody .msg.thinking');
      if (t) { t.classList.add('timeout'); t.innerHTML = esc(T('studio.slowTimeout')); }
      try { ctrl.abort(); } catch {}
    }, FIRST_BYTE_LIMIT_MS);
    // 提示文案渐进：6s 后告诉用户"正在连接模型"，让用户安心（不必干等）
    const slowHintTimer = setTimeout(() => {
      if (firstByteSeen) return;
      const t = document.querySelector('#chatBody .msg.thinking');
      if (t && !t.classList.contains('timeout')) {
        const lbl = t.querySelector('.label');
        if (lbl) lbl.textContent = T('studio.connecting');
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
        if (d.paywall) {
          addMsg('ai', T('studio.paywall'), true);
          return;
        }
        if (d.needLogin) {
          addMsg('ai', T('studio.guestLimit'), true);
          openAuth('reg');
          return;
        }
        const msg = d.error || (T('status.requestFailed') + ' ' + res.status);
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
          aiEl.innerHTML = '<div class="ai-gen-badge">' + esc(T('studio.aiBadge')) + '</div><div class="ai-content"></div>';
          aiContent = aiEl.querySelector('.ai-content');
          setLlmStatus(T('studio.generating'));
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim(); if (!t.startsWith('data:')) continue;
          const p = t.slice(5).trim(); if (p === '[DONE]') continue;
          try {
            const j = JSON.parse(p);
            // P0-9 · 输出侧软改写：流末 disclaimer event（L2 基线 / L3 高风险追加），视觉区分渲染
            if (j.type === 'disclaimer') { renderStreamDisclaimer(j.level, j.text); continue; }
            if (j.text) {
              acc += j.text;
              if (aiContent) { aiContent.innerHTML = md(acc); withEl('chatBody', (cb) => { cb.scrollTop = cb.scrollHeight; }); }
            }
            if (j.systemNote) {
              // P0-9 · 输出侧系统免责后缀：视觉区分（分隔线 + 灰字 + 图标），不与 AI 正文混淆
              sysNoteShown = true;
              if (!aiEl) { aiEl = addMsg('ai', ''); aiEl.innerHTML = '<div class="ai-gen-badge">' + esc(T('studio.aiBadge')) + '</div><div class="ai-content"></div>'; aiContent = aiEl.querySelector('.ai-content'); }
              const note = document.createElement('div');
              note.className = 'sys-note sys-note-' + (j.level === 'L3' ? 'l3' : 'l2');
              note.textContent = '🔻 ' + j.systemNote;
              if (aiContent) aiContent.appendChild(note); else aiEl.appendChild(note);
              withEl('chatBody', (cb) => { cb.scrollTop = cb.scrollHeight; });
              continue;
            }
            if (j.fallback) {
              // R5a · 检索式兜底卡片：渲染命盘相关内容 + L2 免责 + 重试按钮
              removeThinkingBubble();
              if (!aiEl) { aiEl = addMsg('ai', ''); aiEl.innerHTML = '<div class="ai-gen-badge">' + esc(T('studio.aiBadge')) + '</div><div class="ai-content"></div>'; aiContent = aiEl.querySelector('.ai-content'); }
              const card = document.createElement('div'); card.className = 'fallback-card';
              card.innerHTML = md(j.card || '');
              if (j.disclaimer) { const d = document.createElement('div'); d.className = 'l3-tail'; d.textContent = j.disclaimer; card.appendChild(d); }
              const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn-retry'; retry.textContent = T('studio.retry');
              retry.onclick = () => {
                if (aiEl && aiEl.parentNode) {
                  const prev = aiEl.previousElementSibling;
                  aiEl.parentNode.removeChild(aiEl);
                  if (prev && prev.classList.contains('user')) prev.parentNode.removeChild(prev);
                }
                const t = $('chatText'); if (t) t.value = text;
                send();
              };
              card.appendChild(retry);
              if (aiContent) { aiContent.innerHTML = ''; aiContent.appendChild(card); }
              clearTimeout(firstByteTimer);
              clearTimeout(slowHintTimer);
              setLlmStatus(T('studio.fallbackMode'));
              trackEvent('ai_q_fail', { reason: 'fallback' }); // R3 · 降级视为失败
              return;
            }
            if (j.error) {
              removeThinkingBubble();
              if (!aiEl) { aiEl = addMsg('ai', ''); aiEl.innerHTML = '<div class="ai-gen-badge">' + esc(T('studio.aiBadge')) + '</div><div class="ai-content"></div>'; aiContent = aiEl.querySelector('.ai-content'); }
              if (j.blocked) appendL3Tail();
              if (aiContent) aiContent.textContent = '⚠️ ' + j.error;
              clearTimeout(firstByteTimer);
              clearTimeout(slowHintTimer);
              trackEvent('ai_q_fail', { reason: j.error || 'error' }); // R3 · 对话失败
              return;
            }
          } catch {}
        }
      }
      // 流正常结束
      if (aiContent) aiContent.innerHTML = md(acc);
      if (!aiEl) removeThinkingBubble();
      // R1† · 流式尾注（固定，不可被模型覆盖）。若服务端已下发 disclaimer event（P0-9 软改写），则不重复追加硬编码尾注。
      if (acc && !state.gotStreamDisclaimer) appendL3Tail();
      if (acc && !state.aiTracked) { state.aiTracked = true; trackEvent('ai_first_q', {}); } // R3 · 首问成功
      setLlmStatus(acc ? T('studio.received') : '');
    } catch (e) {
      if (e.name === 'AbortError') {
        const t = document.querySelector('#chatBody .msg.thinking');
        if (t && !t.classList.contains('timeout')) {
          t.classList.add('timeout');
          t.innerHTML = esc(T('studio.aborted'));
        }
      } else if (aiEl) {
        aiEl.textContent = '⚠️ ' + (e.message || T('studio.chatFailed'));
      } else {
        removeThinkingBubble();
        addMsg('ai', '⚠️ ' + (e.message || T('studio.chatFailed')), false);
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
        if (!data || !data.charts || !data.charts.length) { box.innerHTML = '<div class="hint">' + esc(T('studio.emptyRecent')) + '</div>'; return; }
        box.innerHTML = data.charts.map((c) => `<div class="item" data-id="${c.id}"><div class="p">${(c.pillars || []).join(' ')}</div><div class="t">${esc(fmtTime(c.created_at))}</div></div>`).join('');
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
      if (!loaded) addMsg('ai', T('studio.chartLoaded', { pillars: data.chart.pillars.join(' '), dayMaster: data.chart.dayMaster }));
      withEl('status', (s) => { s.textContent = T('studio.chartLoadedOk'); });
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
    const status = $('authStatus'); if (status) status.textContent = T('studio.processing');
    try {
      let user, merged = 0;
      if (kind === 'login') {
        const username = (($('aLUser') || {}).value || '').trim();
        const password = (($('aLPwd') || {}).value || '');
        if (!username || !password) { if (status) status.textContent = '⚠️ ' + T('status.needCreds'); return; }
        const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (status) status.textContent = '⚠️ ' + (d.error || T('studio.loginFailed')); return; }
        user = d.user;
      } else {
        const username = (($('aRUser') || {}).value || '').trim();
        const nickname = (($('aRNick') || {}).value || '').trim();
        const password = (($('aRPwd') || {}).value || '');
        const consent = !!($('aRConsent') || {}).checked;
        if (!username || !password) { if (status) status.textContent = '⚠️ ' + T('status.needCreds'); return; }
        if (password.length < 6) { if (status) status.textContent = '⚠️ ' + T('status.pwdShort'); return; }
        if (!$('aRConsent') || !consent) { if (status) status.textContent = '⚠️ ' + T('status.consentNeeded'); return; }
        const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, nickname, password, consent: true }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (status) status.textContent = '⚠️ ' + (d.error || T('studio.regFailed')); return; }
        user = d.user; merged = d.merged || 0;
      }
      applyLoggedInUI(user);
      refreshQuota(); // I3 · 登录/注册后刷新付费态与额度展示
      if (kind === 'reg') trackEvent('anon_to_signup', { merged }); // R3 · 游客→注册
      closeAuth();
      loadRecent();
      refreshLlm();
      const saved = merged > 0 ? T('studio.merged', { n: merged }) : '';
      withEl('status', (s) => { s.textContent = (kind === 'reg' ? T('studio.regOk') : T('studio.loginOk')) + saved; });
    } catch (e) {
      if (status) status.textContent = T('studio.netError', { msg: e.message || '' });
    }
  }

  // 等 DOM 解析完成再初始化，避免 race
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
