/* 辰箓 · 结缘堂定价页（P0-8 / i18n Phase 7）
 * 价格不再写死在此处：由 /pricing-plans.js 按地区出币种与金额（一处改价，全站生效）。
 * 本文件只负责：渲染价格、切换付款通道（CNY 扫码 / 国际邮件）、兑换码核销、续费 Banner。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  // 词库取值（i18n 未就绪时退回内置中文，保证首屏不空）
  const T = (key, fallback, vars) => {
    try {
      const s = window.i18n && window.i18n.t(key, vars);
      return (s && s !== key) ? s : (fallback || key);
    } catch (e) { return fallback || key; }
  };
  const L = () => (window.i18n ? window.i18n.lang() : 'en');

  let ctx = null; // 定价上下文（币种 / 金额 / 通道）

  const status = (msg, cls) => {
    const s = $('redeemStatus');
    if (s) { s.textContent = msg; s.className = 'status ' + (cls || 'info'); }
  };

  function renderPrices() {
    ctx = window.ChronikPricing ? window.ChronikPricing.current(L()) : null;
    if (!ctx) return;

    const y = $('priceYear'); if (y) y.textContent = ctx.priceText;
    const y2 = $('priceYear2'); if (y2) y2.textContent = ctx.priceText;

    const orig = $('priceOrig');
    if (orig) {
      if (ctx.original > ctx.amount) orig.textContent = ctx.originalText;
      else orig.style.display = 'none';
    }
    const save = $('saveTag');
    if (save) save.textContent = ctx.saveText ? T('pricing.save', '省 {amount}', { amount: ctx.saveText }) : '';

    // 「1 缘券 = 1 元」仅对人民币口径有意义
    const unit = $('unitNote');
    if (unit) unit.style.display = (ctx.isCny && L() === 'zh') ? '' : 'none';

    renderChannel();
  }

  /** 付款通道：CNY 走微信收款码；其它币种走人工国际结算（不用 CNY 二维码误导海外用户）。 */
  function renderChannel() {
    if (!ctx) return;
    const cny = $('payBoxCny'), intl = $('payBoxIntl');
    if (cny) cny.hidden = !ctx.isCny;
    if (intl) intl.hidden = ctx.isCny;

    if (ctx.isCny) {
      const hint = $('payHintCny');
      if (hint) {
        hint.innerHTML = T('pricing.payHintCny',
          '扫码付款 <b>{price}</b> 后，凭转账<b>备注 / 订单号</b>联系运营获取<b>兑换码</b>，即可激活结缘堂。',
          { price: ctx.priceText + T('pricing.per', '/年') });
      }
    } else {
      const hint = $('payHintIntl');
      if (hint) {
        hint.innerHTML = T('pricing.payHintIntl',
          '海外暂不支持微信收款码直接结算。请邮件联系我们，一个工作日内回复卡支付或 PayPal 链接；确认到账后发放兑换码。',
          { price: ctx.priceText, currency: ctx.currency });
      }
    }
  }

  // 埋点：进页即上报 pricing_viewed（I0 白名单已含；失败静默忽略）
  function trackViewed() {
    try {
      fetch('/api/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'pricing_viewed',
          payload: { plan: 'year', currency: ctx ? ctx.currency : 'CNY', region: ctx ? ctx.region : '', amount: ctx ? ctx.amount : 99 },
        }),
        keepalive: true,
      });
    } catch { /* 埋点失败不阻断 */ }
  }

  async function doRedeem() {
    const code = ($('redeemCode')?.value || '').trim();
    if (!code) { status(T('pricing.statusNeedCode', '请输入兑换码'), 'err'); return; }
    const btn = $('redeemBtn');
    btn.disabled = true; status(T('pricing.statusActivating', '正在激活…'), 'info');
    try {
      const r = await fetch('/api/redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, lang: L() }),
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
          if (msg) {
            if (d.expiresAt) {
              const exp = new Date(d.expiresAt);
              const dateStr = new Intl.DateTimeFormat(
                L() === 'zh' ? 'zh-CN' : (L() === 'pt' ? 'pt-BR' : 'en-US'),
                { year: 'numeric', month: 'long', day: 'numeric' }
              ).format(exp);
              msg.textContent = T('pricing.redeemOkMsgExp',
                '你的年卡结缘堂已生效，有效期至 {date}，每日 30 轮 AI 答疑已解锁。', { date: dateStr });
            } else {
              msg.textContent = T('pricing.redeemOkMsg', '你的年卡结缘堂已生效，每日 30 轮 AI 答疑已解锁。');
            }
          }
        }
        status(T('pricing.statusOk', '激活成功！'), 'ok');
        if ($('redeemCode')) $('redeemCode').value = '';
      } else {
        const map = {
          USED: T('pricing.errUsed', '该兑换码已被使用'),
          EXPIRED: T('pricing.errExpired', '该兑换码已过期'),
          INVALID: T('pricing.errInvalid', '兑换码不存在或无效'),
          NEED_LOGIN: T('pricing.errNeedLogin', '请先登录后再兑换'),
          ERROR: T('pricing.errFail', '处理失败，请稍后再试'),
        };
        status(map[d.code] || d.error || T('pricing.errFallback', '兑换失败，请检查兑换码'), 'err');
      }
    } catch (e) {
      status(T('pricing.statusNetwork', '网络错误：{msg}', { msg: e.message }), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function init() {
    renderPrices();
    trackViewed();          // 需在 renderPrices 之后：埋点要带上币种
    checkRenewal();         // R5 UI · 登录且距到期 ≤7 天显示续费 Banner
    const btn = $('redeemBtn');
    if (btn) btn.onclick = doRedeem;
    const inp = $('redeemCode');
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRedeem(); });
    // 语言切换 → 金额格式、付款说明、状态文案整体重渲染
    document.addEventListener('langchange', () => {
      renderPrices();
      checkRenewal();
      const s = $('redeemStatus');
      if (s && !s.dataset.dirty) s.className = 'status info';
    });
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
      const dayText = days <= 0
        ? T('pricing.renewToday', '今日')
        : T('pricing.renewDays', '{n} 天', { n: days });
      banner.innerHTML = `
        <div class="b-title">${T('pricing.renewTitle', '⏳ 结缘堂即将到期')}</div>
        <div class="b-text">${T('pricing.renewText',
          '结缘堂将于 <b>{days}</b> 到期，续费（年卡 / 兑换码）可连续持有权益，避免 AI 答疑与命盘保存中断。',
          { days: dayText })}</div>
        <div class="b-actions"><a href="#redeem">${T('pricing.renewCta', '立即续费 →')}</a></div>`;
      banner.hidden = false;
    } catch {
      banner.hidden = true; // fail-open：异常静默不显示
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
