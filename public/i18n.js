/*
 * 辰箓 · i18n 引擎（轻量、无依赖）
 * ------------------------------------------------------------
 * 支持语言：en（默认）/ pt / zh
 * 解析优先级：URL ?lang= > localStorage(cl_lang) > navigator.language > 默认 en
 * 用法：
 *   - HTML 上标注：data-i18n="key"（替换文本）
 *                   data-i18n-html="key"（替换 innerHTML，用于含链接的句子）
 *                   data-i18n-placeholder="key" / data-i18n-aria="key" / data-i18n-title="key"
 *   - 切换按钮：<button data-lang-btn="en">EN</button>
 *   - JS 取值：window.i18n.t('login.tabLogin')
 *   - 语言变化事件：document.addEventListener('langchange', e => { e.detail.lang })
 * 词库文件：/locales/{en,pt,zh}.json
 * ------------------------------------------------------------
 */
(function () {
  const SUPPORTED = ['en', 'pt', 'zh'];
  const DEFAULT = 'en';
  const LS_KEY = 'cl_lang';
  const html = document.documentElement;

  // 防止首屏语言闪烁：先隐藏 body，翻译应用后显示（配合 head 里的 CSS）
  html.setAttribute('data-i18n-pending', '');

  function norm(l) {
    if (!l) return null;
    l = String(l).toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh';
    if (l.indexOf('pt') === 0) return 'pt';
    if (l.indexOf('en') === 0) return 'en';
    return null;
  }

  function detect() {
    let q = null;
    try { q = new URLSearchParams(location.search).get('lang'); } catch (e) {}
    let saved = null;
    try { saved = localStorage.getItem(LS_KEY); } catch (e) {}
    return norm(q) || norm(saved) || norm(navigator.language) || DEFAULT;
  }

  let lang = detect();
  let dict = {};

  function loadDict(l) {
    return fetch('/locales/' + l + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('dict ' + r.status); return r.json(); })
      .catch(function (e) { console.warn('[i18n] load failed:', l, e); return {}; });
  }

  function get(obj, path) {
    return path.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, obj);
  }

  function t(key, vars) {
    let s = get(dict, key);
    if (s == null) return key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split('{' + k + '}').join(vars[k]);
      });
    }
    return s;
  }

  function htmlLang(l) {
    return l === 'zh' ? 'zh-CN' : (l === 'pt' ? 'pt-BR' : 'en');
  }

  function apply() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const v = get(dict, el.getAttribute('data-i18n'));
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      const v = get(dict, el.getAttribute('data-i18n-html'));
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      const v = get(dict, el.getAttribute('data-i18n-placeholder'));
      if (v != null) el.setAttribute('placeholder', v);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      const v = get(dict, el.getAttribute('data-i18n-aria'));
      if (v != null) el.setAttribute('aria-label', v);
    });
    const tEl = document.querySelector('title');
    if (tEl && tEl.getAttribute('data-i18n-title')) {
      const v = get(dict, tEl.getAttribute('data-i18n-title'));
      if (v != null) document.title = v;
    }
    html.setAttribute('lang', htmlLang(lang));
    document.querySelectorAll('[data-lang-btn]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-lang-btn') === lang);
      b.setAttribute('aria-pressed', b.getAttribute('data-lang-btn') === lang ? 'true' : 'false');
    });
  }

  function reveal() {
    html.removeAttribute('data-i18n-pending');
  }

  function fire() {
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }));
  }

  function setLang(l, opts) {
    const nl = norm(l) || DEFAULT;
    lang = nl;
    try { localStorage.setItem(LS_KEY, nl); } catch (e) {}
    if (opts && opts.syncUrl) {
      try {
        const u = new URL(location.href);
        u.searchParams.set('lang', nl);
        history.replaceState(null, '', u);
      } catch (e) {}
    }
    return loadDict(nl).then(function (d) { dict = d; apply(); fire(); return nl; });
  }

  function init() {
    loadDict(lang).then(function (d) {
      dict = d;
      apply();
      reveal();
      fire();
    }).catch(function () { reveal(); });
    // 安全兜底：无论词库是否成功，2s 后一定显示，避免白屏
    setTimeout(reveal, 2000);
  }

  function bindSwitchers() {
    document.querySelectorAll('[data-lang-btn]').forEach(function (b) {
      b.addEventListener('click', function () {
        setLang(b.getAttribute('data-lang-btn'), { syncUrl: true });
      });
    });
  }

  window.i18n = {
    t: t,
    dict: function () { return dict; },
    lang: function () { return lang; },
    setLang: setLang,
    apply: apply,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindSwitchers(); init(); });
  } else {
    bindSwitchers();
    init();
  }
})();
