/* 辰箓 · 召回落地页 /r（F3，PRD 4.2 + 2026-09-08 决议 W1-④「破站内信死锁」）
 * 公开页，无需登录（沉默用户回流）。A 案「用户自携链接」：站内信 link 一律为 /r?ref=type:period。
 *
 * 按 URL 的 ref 前缀分流（后端 lib/retention.js recallLink 已全部改为 /r?ref=）：
 *   ref 以 'renewal:' 开头  → 主按钮去结缘堂续费 /pricing.html?ref=…#redeem；次按钮去推演阁看命盘
 *   其余（solar_term: / liunian: / destiny_node: / birthday: / 无 ref / 其它自携值）
 *                           → 保持原样：两按钮均去 /studio.html
 *
 * 埋点（沿用 I2 口径，/api/track 白名单已含）：
 *   载入   recall_open  { ref }
 *   点击   recall_click { ref, target }
 *
 * 合规红线：公开免登录、保留 L2 免责声明、禁用恐惧诉求（不得出现"太岁当头/灾厄将至"等恐吓文案拉开门率）。
 */
(() => {
  const DEFAULT_REF = 'direct'; // 无 ref / 解析失败时的归因值（与历史口径一致）

  /** 业务埋点：单端点上报，静默失败，绝不阻断主流程。 */
  function track(action, payload) {
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload: payload || {} }),
        keepalive: true,
      });
    } catch (e) { /* 埋点失败不阻断业务 */ }
  }

  /** 解析 ?ref=（URLSearchParams 已自动解码，如 solar_term%3A2026-bailu → solar_term:2026-bailu）。 */
  function getRef() {
    try {
      const v = new URLSearchParams(location.search).get('ref');
      return (v || '').trim() || DEFAULT_REF;
    } catch { return DEFAULT_REF; }
  }

  const ref = getRef();
  // 仅 renewal: 前缀走续费分支；其余（含无 ref、人工自携 wx-manual）走常规分支。
  const isRenewal = ref.indexOf('renewal:') === 0;

  /**
   * 目标 URL 带上 ref，便于落地页（推演阁 / 结缘堂）复用于「带走回访问入口」。
   * 注意：query 必须插在 #hash 之前，否则 ?ref= 会被当成 fragment 的一部分而失效。
   */
  function withRef(path) {
    if (ref === DEFAULT_REF) return path;
    const hashIdx = path.indexOf('#');
    const hash = hashIdx >= 0 ? path.slice(hashIdx) : '';
    const base = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'ref=' + encodeURIComponent(ref) + hash;
  }

  /** 分流文案表：key = 分流场景。文案一律中性，禁恐惧诉求。
   *  文案本体走 i18n 词库（r.*），此处只保留场景与跳转目标。 */
  const T = (k) => (window.i18n ? window.i18n.t(k) : k);

  const SCENES = {
    renewal: {
      subKey: 'r.subRenewal',
      summaryKey: 'r.summaryRenewal',
      primary: { textKey: 'r.btnRenew', href: '/pricing.html#redeem', target: 'renewal' },
      ghost: { textKey: 'r.btnFlowGhost', href: '/studio.html', target: 'flow' },
    },
    normal: {
      subKey: 'r.subNormal',
      summaryKey: 'r.summaryNormal',
      primary: { textKey: 'r.btnFlow', href: '/studio.html', target: 'flow' },
      ghost: { textKey: 'r.btnAsk', href: '/studio.html', target: 'ask' },
    },
  };

  const scene = isRenewal ? SCENES.renewal : SCENES.normal;

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function applyScene() {
    setHtml('rSubText', T(scene.subKey));
    setText('rSummaryText', T(scene.summaryKey));

    const primary = document.getElementById('btnFlow');
    if (primary) {
      primary.textContent = T(scene.primary.textKey);
      primary.setAttribute('href', withRef(scene.primary.href));
    }
    const ghost = document.getElementById('btnAsk');
    if (ghost) {
      ghost.textContent = T(scene.ghost.textKey);
      ghost.setAttribute('href', withRef(scene.ghost.href));
    }
  }

  /** 按钮点击：埋点后由 <a href> 自然跳转（keepalive 保证埋点发出）。 */
  function bind(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      track('recall_click', { ref, target });
    });
  }

  applyScene();
  // 语言切换后重刷场景文案（href 与埋点绑定不受影响）
  document.addEventListener('langchange', applyScene);

  // 载入即上报 recall_open
  track('recall_open', { ref, ua_fallback: true });

  bind('btnFlow', scene.primary.target);
  bind('btnAsk', scene.ghost.target);
})();
