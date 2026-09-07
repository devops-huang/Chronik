/* 辰箓 · 召回落地页（F3，PRD 4.2）
 * 公开页，无需登录（沉默用户回流）。
 * 载入即 POST /api/track {action:'recall_open', payload:{ref}}（复用 I0 归因口径，/api/track 白名单已含 recall_open）。
 * 按钮点击 POST /api/track {action:'recall_click', payload:{ref}} → 跳 /studio.html。
 */
(() => {
  const track = (action, payload) => {
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload: payload || {} }),
        keepalive: true,
      });
    } catch (e) { /* 埋点失败不阻断业务 */ }
  };

  function getRef() {
    try {
      return new URLSearchParams(location.search).get('ref') || 'direct';
    } catch { return 'direct'; }
  }

  const ref = getRef();

  // 载入选 recall_open
  track('recall_open', { ref, ua_fallback: true });

  function bind(id, extra) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      track('recall_click', Object.assign({ ref }, extra || {}));
      // 链接本身会跳转 /studio.html，此处仅补埋点（keepalive 保证发送）
    });
  }

  bind('btnFlow', { target: 'flow' });
  bind('btnAsk', { target: 'ask' });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => {});
})();
