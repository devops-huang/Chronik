import { buildChart, listAllCities, resolveLocation, toTrueSolarTime } from '../lib/chart.js';

console.log('城市总数:', listAllCities().length);

// 案例一：农历 + 天水（时柱应被校正为甲辰）
const c1 = buildChart({
  calendar: 'lunar',
  date: '1996-10-11',
  time: '09:30',
  gender: 1,
  location: '天水',
});
console.log('\n=== 案例一 农历 天水 ===');
console.log('公历:', c1.solarTime);
console.log('真太阳时:', c1.trueSolarTime.iso, '偏移(分):', c1.trueSolarTime.totalOffsetMinutes);
console.log('八字:', c1.pillars.join(' '));
console.log('未校正:', c1.trueSolarTime.uncorrectedPillars);
console.log('时柱是否改变:', c1.trueSolarTime.changedHourPillar);
console.log('起运:', c1.natal.大运?.起运日期, '年龄', c1.natal.大运?.起运年龄);

// 案例二：阳历 + 北京（东经 116.4，偏移很小，时柱不应改变）
const c2 = buildChart({
  calendar: 'solar',
  date: '1996-11-21',
  time: '09:30',
  gender: 1,
  location: '北京',
});
console.log('\n=== 案例二 阳历 北京 ===');
console.log('真太阳时:', c2.trueSolarTime.iso, '偏移(分):', c2.trueSolarTime.totalOffsetMinutes);
console.log('八字:', c2.pillars.join(' '), '| 时柱改变:', c2.trueSolarTime.changedHourPillar);

// 案例三：海外（纽约，UTC-5）—— 验证通用时区处理
const c3 = buildChart({
  calendar: 'solar',
  date: '1996-11-21',
  time: '09:30',
  gender: 1,
  location: '纽约',
  utcOffset: -5,
});
console.log('\n=== 案例三 海外 纽约 UTC-5 ===');
console.log('经度:', c3.input.longitude, '| 标准经度:', -5 * 15);
console.log('真太阳时:', c3.trueSolarTime.iso, '偏移(分):', c3.trueSolarTime.totalOffsetMinutes);
console.log('八字:', c3.pillars.join(' '));

// 案例四：手动经度
const c4 = buildChart({ calendar: 'solar', date: '1996-11-21', time: '09:30', gender: 1, location: '105.72' });
console.log('\n=== 案例四 手动经度 ===');
console.log('解析:', resolveLocation('105.72'), '| 八字:', c4.pillars.join(' '));

// 真太阳时边界：同一时刻在不同经度下的时柱差异
console.log('\n=== 经度对时柱的影响（1996-11-21 09:30 北京时间）===');
for (const [city, lon] of [['上海', 121.47], ['北京', 116.4], ['成都', 104.07], ['乌鲁木齐', 87.6]]) {
  const t = toTrueSolarTime(new Date(Date.UTC(1996, 10, 21, 9, 30)), lon, 8);
  console.log(`${city.padEnd(5)} ${lon}°E → ${t.iso.slice(11, 19)}  偏移 ${t.totalOffsetMinutes} 分`);
}
