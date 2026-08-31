import { queryFortuneRange } from '../lib/fortune.ts';
import {
  convertBeijingDateTimeStringToTrueSolarTime,
  resolveCityLongitude,
  listSupportedCityNames,
} from '../lib/util.ts';
import { buildBaziFromSolar, buildBaziFromLunar } from 'cantian-tymext';

console.log('城市库数量:', listSupportedCityNames().length);
console.log('天水:', resolveCityLongitude('天水'), '| 天水市:', resolveCityLongitude('天水市'));

const tst = convertBeijingDateTimeStringToTrueSolarTime('1996-11-21T09:30:00', 105.72, 120);
console.log('真太阳时:', tst);

const b = buildBaziFromSolar({ solarTime: tst, gender: 1, sect: 2 });
console.log('八字:', b.八字, '| 日主:', b.日主, '| 命宫:', b.命宫, '| 身宫:', b.身宫);
console.log('大运起:', b.大运?.起运日期, '| 首运:', JSON.stringify(b.大运?.大运?.[0]));

const r = queryFortuneRange({
  birth: { calendar: 'solar', time: tst, gender: 1, sect: 2 },
  query: { startDateTime: '2026-01-01', endDateTime: '2027-12-31', level: 'month' },
});
console.log('流年条数:', r.result.years.length);
console.log('流年样本:', JSON.stringify(r.result.years[0]));
console.log('流月条数:', r.result.months.length);
console.log('流月样本:', JSON.stringify(r.result.months[0]));

// 农历入口校验
const lb = buildBaziFromLunar({ lunarTime: '1996-10-11T09:30:00', gender: 1, sect: 2 });
console.log('农历入口:', lb.阳历, lb.八字);
