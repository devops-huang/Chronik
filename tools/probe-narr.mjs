/**
 * tools/probe-narr.mjs —— 叙事本地化覆盖率探测
 *
 * 用途：跑一份真实命盘，统计 en/pt 结果里还残留多少中文，
 * 用于决定下一批需要补哪些词条。不参与生产链路。
 *
 * 运行：node tools/probe-narr.mjs [YYYY-MM-DD] [HH:MM]
 */
import { computeAll } from '../lib/core.js';

const date = process.argv[2] || '1996-10-11';
const time = process.argv[3] || '09:30';
const input = { calendar: 'solar', date, time, gender: 1, location: '深圳' };

const CJK = /[\u4e00-\u9fff]/;

function walk(o, path, out) {
  if (typeof o === 'string') {
    if (CJK.test(o)) out.push([path, o]);
  } else if (Array.isArray(o)) {
    o.forEach((x, i) => walk(x, path + '[' + i + ']', out));
  } else if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) walk(o[k], path + '.' + k, out);
  }
  return out;
}

const summary = {};
for (const lang of ['zh', 'en', 'pt']) {
  const r = await computeAll(input, { lang });
  const resid = walk(r.interpret, '', []);
  summary[lang] = resid.length;
  console.log('---', lang, '残中文条数:', resid.length);
  if (lang !== 'zh') {
    for (const [p, v] of resid) console.log('   ', p, '=>', String(v).slice(0, 70));
  }
}
console.log('\n汇总:', JSON.stringify(summary));

// 报告 HTML 里的中文检查（排除干支与品牌等刻意保留项）
const r = await computeAll(input, { lang: 'en' });
const html = r.reportHtml.replace(/<style[\s\S]*?<\/style>/g, '');
const hits = [...new Set(html.match(/[\u4e00-\u9fff]{2,}/g) || [])];
console.log('报告 HTML 中连续中文片段（≥2 字）:', hits.length);
console.log(hits.slice(0, 30).join(' | '));
