/**
 * lib/content-i18n.js —— 内容策略文案的多语言出口（i18n Phase 7）
 *
 * 为什么单独一个文件：lib/content-policy.js 会被原样暴露为 /content-policy.js
 * 供前端 ES module 直接 import，必须保持零 node 依赖。所以「多语言」这一层
 * 放在服务端专属模块里，复用同一份 public/locales/*.json。
 *
 * 三个函数都是 fail-soft：
 *   - lang='zh' → 直接返回 content-policy.js 的中文原文（单一数据源，不复制文案）
 *   - 词库缺键 → 同样回落中文原文（宁可显示中文，也不能显示 key 名或空串）
 */
import { t } from './i18n.js';
import {
  DISCLAIMER_L1, DISCLAIMER_L2, DISCLAIMER_L3, DISCLAIMER_L4,
  CHAT_SUFFIX_L2, CHAT_SUFFIX_L3,
  getRefusal, refusalCategoryKey,
} from './content-policy.js';

const ZH_DISCLAIMER = { 1: DISCLAIMER_L1, 2: DISCLAIMER_L2, 3: DISCLAIMER_L3, 4: DISCLAIMER_L4 };

/**
 * 四层免责声明（L1 页脚 / L2 流末 / L3 高风险热线 / L4 拒答兜底）。
 * @param {1|2|3|4|string} level
 * @param {string} lang
 */
export function disclaimer(level, lang) {
  const n = Number(level) || 2;
  const zh = ZH_DISCLAIMER[n] || DISCLAIMER_L2;
  if (!lang || lang === 'zh') return zh;
  const v = t(lang, 'srv.disclaimer.L' + n);
  return v && v !== 'srv.disclaimer.L' + n ? v : zh;
}

/**
 * A–J 十类禁区拒答。
 * @param {string} category A–J / 语义键 / 中文标签；未命中返回 L4 兜底
 * @param {string} lang
 */
export function refusal(category, lang) {
  const zh = getRefusal(category);
  if (!lang || lang === 'zh') return zh;
  const key = refusalCategoryKey(category);
  if (!key) return disclaimer(4, lang);
  const v = t(lang, 'srv.refusal.' + key);
  return v && v !== 'srv.refusal.' + key ? v : zh;
}

/**
 * 输出侧系统免责后缀（追加在每轮 AI 回复末尾）。
 * @param {'L2'|'L3'} level
 * @param {string} lang
 */
export function chatSuffix(level, lang) {
  if (!lang || lang === 'zh') return level === 'L3' ? CHAT_SUFFIX_L3 : CHAT_SUFFIX_L2;
  const l2 = disclaimer(2, lang);
  if (level !== 'L3') return l2;
  const tail = t(lang, 'srv.chatSuffixL3');
  return l2 + (tail && tail !== 'srv.chatSuffixL3' ? tail : '');
}
