/**
 * 统一编排：排盘 → 查运 → 拆盘 → 解盘 → 出报告 HTML。
 * 后端接口和测试都走这里，保证路径一致。
 */
import { buildChart, queryFortune, extractPillars } from './chart.js';
import { interpret } from './interpreter.js';
import { buildReportHtml } from './report.js';

function defaultWindow() {
  const y = new Date().getFullYear();
  return { startDateTime: `${y - 1}-01-01`, endDateTime: `${y + 2}-12-31` };
}

export async function computeAll(input, opts = {}) {
  const chart = await buildChart(input);
  const fortune = queryFortune(chart, opts.fortune ?? { level: 'month', ...defaultWindow() });
  chart.pillarsData = extractPillars(chart.natal);
  const inter = interpret(chart, fortune, opts.interpret ?? {});
  const reportHtml = buildReportHtml({ chart, fortune, interpret: inter });
  return { chart, fortune, interpret: inter, reportHtml };
}

/** 把命盘浓缩成一段给大模型当 system context 的文本。 */
export function chartContextText(chart, inter) {
  const c = chart;
  const lines = [];
  lines.push('你是一位严谨、说话有层次的传统命理顾问，基于子平八字体系为用户答疑。');
  lines.push('以下为用户命盘，回答必须以此为依据，不得虚构干支与神煞：');
  lines.push(`八字：${c.pillars.join(' ')}（${c.input.calendar === 'lunar' ? '农历' : '阳历'}${c.input.date} ${c.input.time}，性别${c.input.gender === 1 ? '男' : '女'}，出生地${c.input.location}）`);
  lines.push(`日主：${c.dayMaster}（${inter.strength.dayMasterElement}），旺衰：${inter.strength.verdict}`);
  lines.push(`格局：${inter.pattern.name}。${inter.pattern.advice || ''}`);
  lines.push(`调候用神：${inter.usefulGod.tiaohouNote || '—'}`);
  lines.push(`喜用：${(inter.usefulGod.xiElements || []).join('、')}；忌神：${(inter.usefulGod.jiElements || []).join('、')}`);
  lines.push(`当前大运：${inter.currentDayun?.ganzhi}（${inter.currentDayun?.startYear}–${inter.currentDayun?.endYear}）：${inter.currentDayun?.headline || ''}`);
  lines.push(`当前流年：${inter.currentLiunian?.ganzhi}（${inter.currentLiunian?.year}）：${inter.currentLiunian?.headline || ''}`);
  lines.push('五行分布：' + Object.entries(inter.wuxing.percent).map(([k, v]) => `${k}${v}%`).join(' '));
  lines.push('吉神：' + (inter.shenSummary.good.map((s) => s.name).join('、') || '—'));
  lines.push('流月（未来6段）：' + inter.months.map((m) => `${m.start}~${m.end} ${m.ganzhi}(${m.verdict.label})`).join('；'));
  lines.push('要求：结论清楚、讲出“为什么”，不堆套话，不恐吓、不绝对化；涉及健康/法律/财务只做象征参考，提醒咨询专业人士。');
  return lines.join('\n');
}
