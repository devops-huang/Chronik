/**
 * lib/narrative.js —— 命盘报告「正文叙事」本地化层（i18n Phase 8）
 *
 * 背景：lib/interpreter.js 是纯规则引擎，输出的是大量中文短句
 * （旺衰判词、格局说明、十神注解、分领域要点…）。若在引擎里逐个改写成
 * 模板函数，会把 700 多行确定性代码搅乱，且极易引入回归。
 *
 * 因此本层采取「后处理」策略，引擎零改动：
 *   1) 整句精确匹配 narr/<lang>.json 的 exact 表
 *   2) 短语替换：按 key 长度从长到短做 substring 替换，
 *      用于「干支/十神 + 固定句式」这类组合句（先长后短，避免碎片化）
 *   3) 标点本地化：，。；：（）→ , . ; : ( )
 *   4) 正则兜底：处理替换后仍残留的结构（如「Direct Officer运」）
 *
 * 设计取舍：
 * - 只翻「展示字段」（见 FIELDS 白名单），绝不触碰 type/cls/key 这类
 *   参与逻辑判断的数据键 —— 否则 `p.type === '吉'` 之类的分支会失效。
 * - 未命中一律回落原文，不抛错、不输出 key 名：宁可中英混排，也不出乱码。
 * - 干支（甲子）、五行单字（木火土金水）按文化取舍保留中文，展示层另行标注。
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'narr');

/** 会被翻译的对象字段（展示用）。其余字段原样透传。 */
const FIELDS = new Set([
  'name', 'summary', 'text', 'headline', 'desc', 'description', 'verdict',
  'advice', 'brief', 'tip', 'why', 'note', 'tiaohouNote', 'label',
]);

/** 明确跳过的字段（即使名字在白名单里也不翻）。 */
const SKIP = new Set(['type', 'cls', 'key', 'category', 'tier', 'stem', 'branch',
  'ganzhi', 'ganji', 'pillars', 'icon', 'code', 'slug', 'id', 'el', 'elements']);

const DELIMS = [
  [/，/g, ', '], [/。/g, '. '], [/；/g, '; '], [/：/g, ': '],
  [/（/g, ' ('], [/）/g, ')'], [/、/g, ', '],
];

const CJK = /[\u4e00-\u9fff]/;
const cache = new Map();

function load(lang) {
  if (lang !== 'en' && lang !== 'pt') return null;
  const file = join(DIR, lang + '.json');
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return null; }
  const hit = cache.get(lang);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[narrative] 词表加载失败', lang, e.message);
    return null;
  }
  const exact = Object.assign({}, raw.exact || {});
  delete exact._comment;
  const data = {
    exact,
    // 长键优先：避免「正官」先于「正官格」被替换
    keys: Object.keys(exact).filter((k) => k.length >= 2).sort((a, b) => b.length - a.length),
    rules: (raw.rules || []).map(([re, to]) => [new RegExp(re), to]),
  };
  cache.set(lang, { data, mtimeMs });
  return data;
}

/** 中文标点 → 西文标点，并清理替换产生的多余空格。 */
function tidy(s) {
  let out = s;
  for (const [re, to] of DELIMS) out = out.replace(re, to);
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\)(?=[A-Za-z0-9])/g, ') ')
    .replace(/\s+\./g, '.')
    .trim();
}

/** 短语替换（长键优先）。返回 {text, changed}。 */
function phraseReplace(s, dict) {
  let out = s;
  let changed = false;
  for (const k of dict.keys) {
    if (out.indexOf(k) === -1) continue;
    out = out.split(k).join(dict.exact[k]);
    changed = true;
  }
  return { text: out, changed };
}

function translateString(s, dict) {
  if (typeof s !== 'string' || !s) return s;
  if (!CJK.test(s)) return s;

  const whole = dict.exact[s];
  if (whole) return whole;

  const { text, changed } = phraseReplace(s, dict);
  let out = changed ? tidy(text) : s;

  if (CJK.test(out)) {
    for (const [re, to] of dict.rules) {
      if (re.test(out)) {
        const r = out.replace(re, to);
        if (r !== out) { out = r; break; }
      }
    }
  }
  return out;
}

/**
 * 递归本地化。返回新对象（不改原对象，避免污染落库的 charts.interpret）。
 * @param {any} obj  interpret() 的返回值
 * @param {string} lang 'zh' | 'en' | 'pt'
 */
export function localizeNarrative(obj, lang) {
  if (!obj || lang === 'zh') return obj;
  const dict = load(lang);
  if (!dict) return obj;

  const walk = (v, key, parent) => {
    if (typeof v === 'string') {
      if (key && !FIELDS.has(key)) return v;
      return translateString(v, dict);
    }
    if (Array.isArray(v)) {
      // 数组元素通常是句子（points / advice / lines），一律尝试翻译
      return v.map((x) => (typeof x === 'string' ? translateString(x, dict) : walk(x, null, parent)));
    }
    if (v && typeof v === 'object') {
      const out = {};
      const isVerdict = Object.prototype.hasOwnProperty.call(v, 'cls');
      for (const k of Object.keys(v)) {
        if (SKIP.has(k)) { out[k] = v[k]; continue; }
        // label 只有「吉凶判定」对象才翻（pillar.label 是 年/月/日/时，参与展示拼装）
        if (k === 'label' && !isVerdict) { out[k] = v[k]; continue; }
        out[k] = walk(v[k], k, v);
      }
      return out;
    }
    return v;
  };

  return walk(obj, null, null);
}

export default { localizeNarrative };
