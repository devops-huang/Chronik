import { buildChart, queryFortune, extractPillars } from '../lib/chart.js';
import { interpret } from '../lib/interpreter.js';

const chart = buildChart({
  calendar: 'lunar', date: '1996-10-11', time: '09:30',
  gender: 1, location: '天水',
});
const fortune = queryFortune(chart, {
  level: 'month',
  startDateTime: '2026-01-01',
  endDateTime: '2028-12-31',
});
chart.pillarsData = extractPillars(chart.natal);
const r = interpret(chart, fortune);

console.log('八字:', chart.pillars.join(' '), '| 日主:', chart.dayMaster);
console.log('真太阳时校正跨时辰:', chart.trueSolarTime.changedHourPillar, '| 校正前:', chart.trueSolarTime.uncorrectedPillars);
console.log('五行:', JSON.stringify(r.wuxing.percent));
console.log('旺衰:', r.strength.label, '| 日主五行:', r.strength.dayMasterElement);
console.log('格局:', r.pattern);
console.log('用神:', r.usefulGod.label, '| 调候:', r.usefulGod.tiaohou);
console.log('神煞(吉):', r.shenSummary.good.map(s => s.name).join('、'));
console.log('大运条数:', r.dayun.length, '| 当前大运:', r.currentDayun?.ganzhi, r.currentDayun?.stemGod);
console.log('流年条数:', r.liunian.length);
console.log('流月(前6):', r.months.length);
console.log('领域:', r.domains.map(d => d.name).join('、'));
console.log('\n=== 事业解读 ===');
console.log(r.domains[0].summary);
r.domains[0].points.forEach(p => console.log(' -', p));
console.log('\n=== 当前流年 headline ===');
console.log(r.currentLiunian?.ganzhi, '|', r.currentLiunian?.headline);
console.log('\n=== 当前大运 headline ===');
console.log(r.currentDayun?.headline);
