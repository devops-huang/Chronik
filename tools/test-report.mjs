import { buildChart, queryFortune, extractPillars } from '../lib/chart.js';
import { interpret } from '../lib/interpreter.js';
import { buildReportHtml } from '../lib/report.js';
import { writeFileSync } from 'node:fs';

const chart = buildChart({
  calendar: 'lunar', date: '1996-10-11', time: '09:30',
  gender: 1, location: '天水',
});
const fortune = queryFortune(chart, { level: 'month', startDateTime: '2026-01-01', endDateTime: '2028-12-31' });
chart.pillarsData = extractPillars(chart.natal);
const inter = interpret(chart, fortune);
const html = buildReportHtml({ chart, fortune, interpret: inter });

const checks = {
  '含四柱': html.includes('丙子') && html.includes('甲辰'),
  '含真太阳时提醒': html.includes('真太阳时'),
  '含五行': html.includes('五行分布'),
  '含大运': html.includes('大运'),
  '含流年Tab': html.includes('class="tab'),
  '含流月': html.includes('近期流月'),
  '含分领域': html.includes('分领域解读'),
  '含三句话': html.includes('三句话总结'),
  '含免责': html.includes('不构成医疗'),
  'HTML闭合': html.startsWith('<!doctype html>') && html.trim().endsWith('</html>'),
};
console.log('长度:', html.length, '字节');
for (const [k, v] of Object.entries(checks)) console.log((v ? '✅' : '❌'), k);

writeFileSync('tools/_sample_report.html', html);
console.log('\n已写出样例: tools/_sample_report.html');
