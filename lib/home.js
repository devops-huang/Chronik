/**
 * 首页数据：万年历网格、今日运势（结合用户命盘）、天气（Open-Meteo）、阴阳建议。
 * 计算依赖 cantian-tymext；日历网格用 UTC 日期数学避免时区与 next/subtract 的坑。
 */
import { SolarDay } from 'cantian-tymext';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const STEM_ELEMENT = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
const YANG_STEM = new Set(['甲', '丙', '戊', '庚', '壬']);
const ELEMENT_REL = {
  木: { 木: '比劫', 火: '食伤', 土: '财', 金: '官杀', 水: '印' },
  火: { 火: '比劫', 土: '食伤', 金: '财', 水: '官杀', 木: '印' },
  土: { 土: '比劫', 金: '食伤', 水: '财', 木: '官杀', 火: '印' },
  金: { 金: '比劫', 水: '食伤', 木: '财', 火: '官杀', 土: '印' },
  水: { 水: '比劫', 木: '食伤', 火: '财', 土: '官杀', 金: '印' },
};
const REL_ADVICE = {
  财: '今日利于主动求财、推进事务，但量入为出、见好就收，忌冲动铺张。',
  官杀: '今日宜稳守、遵规、听长者言，压力与约束偏多，避免硬碰硬。',
  印: '今日利学习、沉淀、得长辈或文书之助，宜静养与谋划，少折腾。',
  食伤: '今日利表达、创意、沟通与展示，灵感活跃，适合把想法落地。',
  比劫: '今日人际平顺、合作顺畅，但防竞争分利、为他人背书。',
};

const pad = (n) => String(n).padStart(2, '0');

/** 十二时辰：地支 + 时辰区间 + 地支五行（用于与日干五行生克定吉凶）。 */
const HOUR_BRANCHES = [
  { b: '子', range: '23–01' }, { b: '丑', range: '01–03' }, { b: '寅', range: '03–05' },
  { b: '卯', range: '05–07' }, { b: '辰', range: '07–09' }, { b: '巳', range: '09–11' },
  { b: '午', range: '11–13' }, { b: '未', range: '13–15' }, { b: '申', range: '15–17' },
  { b: '酉', range: '17–19' }, { b: '戌', range: '19–21' }, { b: '亥', range: '21–23' },
];
const BRANCH_ELEMENT = { 子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火', 午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水' };
const REL_TO_LEVEL = { '财': 1, '印': 1, '食伤': 2, '比劫': 2, '官杀': 3 };
const REL_TIP = {
  '财': '利求財、謀事', '印': '利學習、得助', '食伤': '利表達、靈感', '比劫': '利合作、人緣', '官杀': '宜謹慎、守成',
};
/** 今日十二时辰吉凶：以日干五行与时辰地支五行生克定档。 */
function buildHours(dayElement) {
  return HOUR_BRANCHES.map((h) => {
    const rel = ELEMENT_REL[dayElement]?.[BRANCH_ELEMENT[h.b]] || '比劫';
    return { branch: h.b, range: h.range, rel, level: REL_TO_LEVEL[rel], tip: REL_TIP[rel] };
  });
}

/** 上海时区下的“今天”，避免服务端时区歧义。 */
export function todayInShanghai() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const y = Number(g('year')), m = Number(g('month')), d = Number(g('day'));
  return { y, m, d, dateStr: `${y}-${pad(m)}-${pad(d)}` };
}

function dayInfo(y, m, d) {
  const sd = SolarDay.fromYmd(y, m, d);
  const lunar = sd.getLunarDay();
  const sc = sd.getSixtyCycleDay();
  return {
    ganzhi: sc.getSixtyCycle().toString(),
    lunarText: lunar.toString().replace('农历', ''),
  };
}

/** 当前月万年历网格（6×7 = 42 格，含上月/下月补位），UTC 数学算日。 */
export function buildMonthGrid(year, month, todayStr) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const startUTC = Date.UTC(year, month - 1, 1 - firstDow);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const t = new Date(startUTC + i * 86400000);
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
    const ymd = `${y}-${pad(m)}-${pad(d)}`;
    const info = dayInfo(y, m, d);
    cells.push({
      ...info,
      ymd,
      weekday: WEEK[t.getUTCDay()],
      inMonth: m === month,
      isToday: ymd === todayStr,
    });
  }
  return cells;
}

/** 今日运势：结合用户命盘（若有 dayMasterElement）。 */
export function buildTodayFortune(user, todayStr) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const sd = SolarDay.fromYmd(y, m, d);
  const sc = sd.getSixtyCycleDay();
  const dayGanZhi = sc.getSixtyCycle().toString();
  const dayStem = dayGanZhi[0];
  const dayElement = STEM_ELEMENT[dayStem];
  const isYang = YANG_STEM.has(dayStem);
  const lunar = sd.getLunarDay();
  const weekday = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

  let fortune;
  if (user?.dayMasterElement) {
    const rel = ELEMENT_REL[user.dayMasterElement]?.[dayElement] || '比劫';
    fortune = { dayMasterElement: user.dayMasterElement, dayElement, relation: rel, headline: REL_ADVICE[rel] };
  } else {
    fortune = {
      dayMasterElement: null, dayElement, relation: '五行',
      headline: isYang ? '阳日主动，适合推进与出击。' : '阴日主静，适合内省与沉淀。',
    };
  }

  let yi = [], ji = [];
  const pick = (arr) => (Array.isArray(arr) ? arr : []).flatMap((x) => (Array.isArray(x?.names) ? x.names : [x]));
  try { yi = pick(lunar.getRecommends?.()); } catch {}
  try { ji = pick(lunar.getAvoids?.()); } catch {}

  let term = '';
  try {
    // sd.getTerm() 返回 Term 对象，不是字符串。getTermDay().getName() 给出当前节气名（"立秋"等）；不在节气日返回 ''
    const td = sd.getTermDay?.();
    if (td && typeof td.getName === 'function') {
      const name = td.getName();
      if (typeof name === 'string') term = name;
    }
  } catch {}

  const advice = buildYinYangAdvice(dayStem, dayElement, isYang, term);

  return {
    date: todayStr,
    weekday: '星期' + weekday,
    ganzhi: dayGanZhi,
    lunarText: lunar.toString().replace('农历', ''),
    dayElement,
    isYang,
    fortune,
    yi: yi.slice(0, 6),
    ji: ji.slice(0, 6),
    term,
    advice,
    hours: buildHours(dayElement),
  };
}

function buildYinYangAdvice(dayStem, element, isYang, term) {
  const dyn = isYang ? '动' : '静';
  const eleText = {
    木: '木气生发，宜舒展条达', 火: '火气升腾，宜明快外显', 土: '土气厚重，宜稳健承载',
    金: '金气收敛，宜果决清爽', 水: '水气润下，宜沉静蓄势',
  }[element];
  const lines = [];
  lines.push(`今日日干为「${dayStem}」，属${element}之${isYang ? '阳' : '阴'}。`);
  lines.push(`阴阳取向：今日偏「${dyn}」，${isYang ? '主动出击、利外务' : '主静内守、利思虑'}。`);
  lines.push(`五行调理：${eleText}。`);
  if (term) lines.push(`时令提示：正值「${term}」前后，顺天时而为，事半功倍。`);
  lines.push('调候小建议：作息有常、饮食有节，动以养阳、静以养阴，今日尤宜如此。');
  return lines;
}

// ── 天气（Open-Meteo，免 Key） ──
const geoCache = new Map();
const WMO = {
  0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪', 95: '雷阵雨', 99: '强雷暴冰雹',
};

async function geocode(city) {
  if (geoCache.has(city)) return geoCache.get(city);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('地理编码失败');
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) throw new Error('未找到城市：' + city);
  const data = { lat: hit.latitude, lon: hit.longitude, name: hit.name, country: hit.country };
  geoCache.set(city, data);
  return data;
}

export async function getWeather(city = '北京') {
  const geo = await geocode(city);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}`
    + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`
    + `&hourly=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min`
    + `&timezone=auto&forecast_days=1&wind_speed_unit=ms`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('天气请求失败');
  const j = await r.json();
  const cur = j.current || {};
  const hourly = j.hourly || {};
  const series = (hourly.time || []).map((t, i) => ({ t, v: hourly.temperature_2m?.[i] ?? null }));
  return parseOmw(j, geo.name, geo.country, series);
}

/** 把 Open-Meteo 响应解析为前端天气结构（getWeather / getWeatherByLatLon 共用）。 */
function parseOmw(j, city, country, series) {
  const cur = j.current || {};
  return {
    city: city || '', country: country || '',
    temp: Math.round(cur.temperature_2m ?? NaN),
    feels: Math.round(cur.apparent_temperature ?? NaN),
    humidity: cur.relative_humidity_2m,
    wind: cur.wind_speed_10m,
    code: cur.weather_code,
    condition: WMO[cur.weather_code] || '未知',
    high: j.daily?.temperature_2m_max?.[0] != null ? Math.round(j.daily.temperature_2m_max[0]) : null,
    low: j.daily?.temperature_2m_min?.[0] != null ? Math.round(j.daily.temperature_2m_min[0]) : null,
    hourly: series || [],
  };
}

// ── 按经纬度查天气（反向地理编码 + Open-Meteo，免去固定城市，更适合“当前位置” ──
const REV_GEO = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
export async function getWeatherByLatLon(lat, lon) {
  let city = '', country = '';
  try {
    const r = await fetch(`${REV_GEO}?latitude=${lat}&longitude=${lon}&localityLanguage=zh`);
    if (r.ok) {
      const j = await r.json();
      city = j.city || j.locality || j.principalSubdivision || j.countryName || '';
      country = j.countryCode || j.countryName || '';
    }
  } catch (e) { /* 反向地理编码失败不影响天气本身 */ }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`
    + `&hourly=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min`
    + `&timezone=auto&forecast_days=1&wind_speed_unit=ms`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('天气请求失败');
  const j = await r.json();
  const series = (j.hourly?.time || []).map((t, i) => ({ t, v: j.hourly.temperature_2m?.[i] ?? null }));
  const w = parseOmw(j, city, country, series);
  w.lat = lat; w.lon = lon;
  return w;
}
