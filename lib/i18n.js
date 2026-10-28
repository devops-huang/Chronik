/**
 * lib/i18n.js —— 服务端三语词库（与前端共用同一份 JSON，避免两套文案漂移）
 *
 * 前端 public/i18n.js 负责静态页；本模块负责服务端生成的文本：
 * 命盘报告 HTML、今日运势判词、免责声明、拒答模板、接口错误信息。
 *
 * 解析优先级（与前端一致，只是多了 HTTP 头这一层）：
 *   ?lang=  >  X-Lang 头  >  Cookie cl_lang  >  Accept-Language  >  en
 *
 * 用法：
 *   import { resolveLang, t, M } from './i18n.js';
 *   const lang = resolveLang(req);
 *   t(lang, 'report.titleMain')
 *   M(lang, 'report.el', '木')        // 单键映射，命中返回译文，未命中回落原值
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'locales');

export const SUPPORTED = ['en', 'pt', 'zh'];
export const DEFAULT_LANG = 'en';

const dictCache = new Map();   // lang → { data, mtimeMs }
const warned = new Set();

/** 归一化语言码：zh-CN→zh，pt-BR→pt，en-US→en；其它返回 null。 */
export function normLang(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s.startsWith('zh')) return 'zh';
  if (s.startsWith('pt')) return 'pt';
  if (s.startsWith('en')) return 'en';
  return null;
}

/** 读取词库（按 mtime 缓存，改词库不必重启；解析失败回落空表并只告警一次）。 */
export function dict(lang) {
  const l = SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
  const file = join(LOCALES_DIR, l + '.json');
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* 文件缺失走下方告警 */ }
  const hit = dictCache.get(l);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  let data = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (!warned.has(l)) { warned.add(l); console.warn('[i18n] 词库加载失败', l, e.message); }
  }
  dictCache.set(l, { data, mtimeMs });
  return data;
}

/** 点分路径取值。 */
function get(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * 取译文。
 * @param {string} lang
 * @param {string} key   点分键，如 'report.sec.pillars.h'
 * @param {object} [vars] {name} 占位替换
 * @returns {string} 未命中返回 key 本身（便于发现漏键，不会抛错）
 */
export function t(lang, key, vars) {
  const d = dict(lang);
  let s = get(d, key);
  if (s == null) return key;
  if (typeof s !== 'string') return s;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

/**
 * 单键映射：把中文术语（十神/五行/旺衰/吉凶等数据键）翻成目标语言。
 * 查不到时**返回原值**——数据键本身要保留中文语义，不能变成 key 名。
 */
export function M(lang, ns, zhKey) {
  if (lang === 'zh') return zhKey;
  const v = get(dict(lang), ns + '.' + zhKey);
  return typeof v === 'string' ? v : zhKey;
}

/** 从 Cookie 头里取 cl_lang（前端 i18n.js 写入的语言偏好）。 */
function cookieLang(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return null;
  const m = String(raw).match(/(?:^|;\s*)cl_lang=([^;]+)/);
  if (!m) return null;
  try { return normLang(decodeURIComponent(m[1])); } catch { return normLang(m[1]); }
}

/** 从 Accept-Language 取最优匹配：按 q 值排序后取第一个支持的语言。 */
function acceptLang(req) {
  const raw = req && req.headers && req.headers['accept-language'];
  if (!raw) return null;
  const parts = String(raw).split(',').map((p) => {
    const [tag, ...attrs] = p.trim().split(';');
    let q = 1;
    for (const a of attrs) {
      const m = a.trim().match(/^q=([\d.]+)$/);
      if (m) q = parseFloat(m[1]) || 0;
    }
    return { tag, q };
  }).sort((a, b) => b.q - a.q);
  for (const p of parts) {
    const l = normLang(p.tag);
    if (l) return l;
  }
  return null;
}

/**
 * 解析本次请求的语言。
 * @param {import('node:http').IncomingMessage} req
 * @param {object} [body] 已解析的请求体（POST 时可用 body.lang 覆盖）
 */
export function resolveLang(req, body) {
  let q = null;
  try {
    const u = new URL(req.url, 'http://x');
    q = normLang(u.searchParams.get('lang'));
  } catch { /* url 异常忽略 */ }
  return q
    || normLang(body && body.lang)
    || normLang(req && req.headers && req.headers['x-lang'])
    || cookieLang(req)
    || acceptLang(req)
    || DEFAULT_LANG;
}

/** html lang 属性用的 BCP-47 标签（与前端 htmlLang 保持一致）。 */
export function htmlLang(lang) {
  return lang === 'zh' ? 'zh-CN' : (lang === 'pt' ? 'pt-BR' : 'en');
}
