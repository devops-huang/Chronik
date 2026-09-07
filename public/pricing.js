/* 辰箓 · 结缘堂定价页（P0-8）
 * 年卡主推 99 缘券/年（原价 199 缘券 划线仅为展示）。
 * 价格常量集中此处：运营改价只动这一处即可全局生效。
 */
(() => {
  // ── 价格常量（运营待定，改此一处即可）──
  const PLAN_PRICE_YEAR = 99;      // 年卡主推价（Edward 拍板 99 缘券/年）
  const PLAN_PRICE_ORIGINAL = 199; // 原价划线展示（纯展示，可改或置 0 隐藏）

  const $ = (id) => document.getElementById(id);
  const status = (msg, cls) => { const s = $('redeemStatus'); if (s) { s.textContent = msg; s.className = 'status ' + (cls || 'info'); } };

  function renderPrices() {
    const y = $('priceYear'); if (y) y.textContent = PLAN_PRICE_YEAR;
    const y2 = $('priceYear2'); if (y2) y2.textContent = PLAN_PRICE_YEAR;
    const orig = $('priceOrig');
    if (orig) {
      if (PLAN_PRICE_ORIGINAL > PLAN_PRICE_YEAR) orig.textContent = PLAN_PRICE_ORIGINAL + ' 缘券';
      else orig.style.display = 'none';
    }
  }

  // 埋点：进页即上报 pricing_viewed（I0 白名单已含；失败静默忽略）
  function trackViewed() {
    try {
      fetch('/api/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pricing_viewed', payload: { plan: 'year', price: PLAN_PRICE_YEAR } }),
        keepalive: true,
      });
    } catch { /* 埋点失败不阻断 */ }
  }

  async function doRedeem() {
    const code = ($('redeemCode')?.value || '').trim();
    if (!code) { status('请输入兑换码', 'err'); return; }
    const btn = $('redeemBtn');
    btn.disabled = true; status('正在激活…', 'info');
    try {
      const r = await fetch('/api/redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        // 兑换成功 → 刷新付费态（广播给可能打开的 studio 页）
        try { localStorage.setItem('cl_entitlement_updated', String(Date.now())); } catch {}
        try {
          window.dispatchEvent(new StorageEvent('storage', { key: 'cl_entitlement_updated' }));
          if (window.BroadcastChannel) {
            const bc = new BroadcastChannel('cl_entitlement');
            bc.postMessage({ type: 'redeem_success', expiresAt: d.expiresAt });
            bc.close();
          }
        } catch {}
        const ok = $('redeemSuccess');
        if (ok) {
          ok.classList.add('show');
          const msg = $('redeemSuccessMsg');
          if (msg && d.expiresAt) {
            const exp = new Date(d.expiresAt);
            msg.textContent = `你的年卡结缘堂已生效，有效期至 ${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}-${String(exp.getDate()).padStart(2, '0')}，每日 30 轮 AI 答疑已解锁。`;
          }
        }
        status('激活成功！', 'ok');
        if ($('redeemCode')) $('redeemCode').value = '';
      } else {
        const map = {
          USED: '该兑换码已被使用', EXPIRED: '该兑换码已过期', INVALID: '兑换码不存在或无效',
          NEED_LOGIN: '请先登录后再兑换', ERROR: '处理失败，请稍后再试',
        };
        status(map[d.code] || d.error || '兑换失败，请检查兑换码', 'err');
      }
    } catch (e) {
      status('网络错误：' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function init() {
    renderPrices();
    trackViewed();
    checkRenewal(); // R5 UI · 登录且距到期 ≤7 天显示续费 Banner
    const btn = $('redeemBtn');
    if (btn) btn.onclick = doRedeem;
    const inp = $('redeemCode');
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRedeem(); });
  }

  // R5 UI（F4）：读 /api/auth/me 的 entitlementExpiresAt；登录且距到期 ≤7 天显示续费 Banner；否则隐藏。
  // 无新 API，复用现有 me 接口；fail-open：异常/未登录均不显示。
  async function checkRenewal() {
    const banner = $('renewBanner');
    if (!banner) return;
    try {
      const r = await fetch('/api/auth/me');
      if (!r.ok) return; // 未登录或异常 → 不显示
      const d = await r.json().catch(() => null);
      if (!d || !d.user) return; // 未登录态 → 不显示
      const exp = d.user.entitlementExpiresAt;
      if (!exp) return;
      const expMs = new Date(exp).getTime();
      if (isNaN(expMs)) return;
      const days = Math.ceil((expMs - Date.now()) / 86400000);
      if (days > 7 || days < 0) { banner.hidden = true; return; } // >7 天或已过期均不提示
      const dayText = days <= 0 ? '今日' : `${days} 天`;
      banner.innerHTML = `
        <div class="b-title">⏳ 结缘堂即将到期</div>
        <div class="b-text">结缘堂将于 <b>${dayText}</b> 到期，续费（年卡 / 兑换码）可连续持有权益，避免 AI 答疑与命盘保存中断。</div>
        <div class="b-actions"><a href="#redeem">立即续费 →</a></div>`;
      banner.hidden = false;
    } catch {
      banner.hidden = true; // fail-open：异常静默不显示
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
