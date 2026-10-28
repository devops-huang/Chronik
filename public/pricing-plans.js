/*
 * 辰箓 · 定价与币种（按地区）
 * ------------------------------------------------------------
 * 设计原则：
 *  1) 价目表按「地区定价」而非实时汇率换算 —— 各地购买力不同，汇率实时浮动
 *     会造成标价抖动且无法做心理价位。改价只动 PRICES 一处。
 *  2) 币种由地区推导：navigator.language 区域码 > IANA 时区 > 默认 USD。
 *     支持 ?cc=xx 手动覆盖（客服/测试用），并写入 localStorage 便于复访。
 *  3) 结算现实：当前线上收款为微信支付个人收款码，只能收 CNY。
 *     非 CNY 地区展示「国际付款」通道（人工联系 → 卡/PayPal 链接），
 *     不用 CNY 二维码去误导海外用户。
 * ------------------------------------------------------------
 */
(function () {
  'use strict';

  // ── 价目表（一处改价，全站生效）─────────────────────────────
  // amount / original 以「法定货币单位」计；original 为划线原价，<=amount 则隐藏。
  const PRICES = {
    CNY: { amount: 99, original: 199, note: 'mainland' },
    USD: { amount: 14.99, original: 29.99, note: 'intl' },
    EUR: { amount: 13.99, original: 27.99, note: 'intl' },
    GBP: { amount: 11.99, original: 23.99, note: 'intl' },
    BRL: { amount: 49.9, original: 99.9, note: 'intl' }, // 拉美购买力定价，非汇率直换
  };

  // ── 地区 → 币种 ────────────────────────────────────────────
  const REGION_CURRENCY = {
    CN: 'CNY',
    // 中国香港 / 中国澳门 / 中国台湾：结算走同一收款通道，按 CNY 展示
    HK: 'CNY', MO: 'CNY', TW: 'CNY',
    US: 'USD', CA: 'USD', AU: 'USD', NZ: 'USD', SG: 'USD', JP: 'USD', KR: 'USD',
    BR: 'BRL',
    PT: 'EUR', ES: 'EUR', FR: 'EUR', DE: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR',
    AT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR',
    EE: 'EUR', LV: 'EUR', LT: 'EUR', CY: 'EUR', MT: 'EUR', HR: 'EUR',
    GB: 'GBP',
  };

  // 时区 → 地区（navigator.language 无区域码时的兜底；只列有独立定价的市场）
  const TZ_REGION = {
    'Asia/Shanghai': 'CN', 'Asia/Chongqing': 'CN', 'Asia/Urumqi': 'CN', 'Asia/Harbin': 'CN',
    'Asia/Hong_Kong': 'HK', 'Asia/Macau': 'MO', 'Asia/Taipei': 'TW',
    'America/Sao_Paulo': 'BR', 'America/Bahia': 'BR', 'America/Fortaleza': 'BR',
    'America/Recife': 'BR', 'America/Manaus': 'BR', 'America/Cuiaba': 'BR',
    'America/Belem': 'BR', 'America/Rio_Branco': 'BR', 'America/Noronha': 'BR',
    'Europe/Lisbon': 'PT', 'Atlantic/Azores': 'PT', 'Atlantic/Madeira': 'PT',
    'Europe/London': 'GB',
    'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
    'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA',
    'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Pacific/Auckland': 'NZ',
    'Asia/Singapore': 'SG', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
    'Europe/Berlin': 'DE', 'Europe/Paris': 'FR', 'Europe/Madrid': 'ES',
    'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE',
    'Europe/Vienna': 'AT', 'Europe/Dublin': 'IE', 'Europe/Helsinki': 'FI',
  };

  const LS_KEY = 'cl_cc';

  function langRegion() {
    let l = '';
    try { l = String(navigator.language || ''); } catch (e) {}
    // zh-Hant-TW / pt-BR / en-GB → 取区域子标签
    const m = l.match(/[-_]([A-Za-z]{2})\b/);
    return m ? m[1].toUpperCase() : '';
  }

  function tzRegion() {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    if (TZ_REGION[tz]) return TZ_REGION[tz];
    // 时区在欧区但未列名（如 Europe/Warsaw）→ 归 EUR
    if (/^Europe\//.test(tz) && tz !== 'Europe/London') return 'PT';
    return '';
  }

  function detectRegion() {
    // 1) URL ?cc= 覆盖（并记忆）
    let q = '';
    try { q = (new URLSearchParams(location.search).get('cc') || '').toUpperCase(); } catch (e) {}
    if (q && /^[A-Z]{2}$/.test(q)) {
      try { localStorage.setItem(LS_KEY, q); } catch (e) {}
      return q;
    }
    // 2) 上次记忆
    let saved = '';
    try { saved = (localStorage.getItem(LS_KEY) || '').toUpperCase(); } catch (e) {}
    if (saved && /^[A-Z]{2}$/.test(saved)) return saved;
    // 3) 浏览器语言区域 → 4) 时区 → 5) US
    return langRegion() || tzRegion() || 'US';
  }

  function currencyOf(region) {
    return REGION_CURRENCY[region] || 'USD';
  }

  /** 按语言格式化金额；整数不带小数（¥99），非整数保留两位（$14.99）。 */
  function formatMoney(currency, amount, lang) {
    const locale = lang === 'zh' ? 'zh-CN' : (lang === 'pt' ? 'pt-BR' : 'en-US');
    const digits = Number.isInteger(amount) ? 0 : 2;
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency', currency,
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(amount);
    } catch (e) {
      return currency + ' ' + amount;
    }
  }

  /**
   * 当前定价上下文。
   * @param {string} [lang] 'en'|'pt'|'zh'，影响金额的本地化格式
   */
  function current(lang) {
    const region = detectRegion();
    const currency = currencyOf(region);
    const p = PRICES[currency] || PRICES.USD;
    const cur = PRICES[currency] ? currency : 'USD';
    const l = lang || (window.i18n ? window.i18n.lang() : 'en');
    const saveAmount = p.original > p.amount ? +(p.original - p.amount).toFixed(2) : 0;
    return {
      region,
      currency: cur,
      amount: p.amount,
      original: p.original,
      saveAmount,
      priceText: formatMoney(cur, p.amount, l),
      originalText: formatMoney(cur, p.original, l),
      saveText: saveAmount ? formatMoney(cur, saveAmount, l) : '',
      isCny: cur === 'CNY',
      channel: p.note,
    };
  }

  // 联系邮箱（与隐私政策、页脚一致）
  const CONTACT_EMAIL = 'tonyandrewhn@outlook.com';

  window.ChronikPricing = { PRICES, current, formatMoney, detectRegion, CONTACT_EMAIL };
})();
