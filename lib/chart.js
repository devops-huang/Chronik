/**
 * 排盘服务层。
 *
 * 职责：把用户输入（阳历/农历、出生时刻、出生地、性别）转成统一结构的命盘对象。
 * 关键处理是「真太阳时校正」——钟表时间不等于太阳时，出生地经度会决定时柱归属。
 * 例如 1996-11-21 09:30 生于甘肃天水，回拨后为 08:46:59，时柱由乙巳变为甲辰。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildBaziFromSolar, buildBaziFromLunar } from 'cantian-tymext';
import { queryFortuneRange } from './fortune.ts';
import {
  resolveCityLongitude as resolveBuiltinCity,
  listSupportedCityNames,
  getEquationOfTimeSeconds,
} from './util.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

let extendedCities = null;
function loadExtendedCities() {
  if (extendedCities) return extendedCities;
  try {
    const raw = readFileSync(join(__dirname, '..', 'data', 'cities-extended.json'), 'utf8');
    extendedCities = JSON.parse(raw).cities;
  } catch {
    extendedCities = {};
  }
  return extendedCities;
}

/** 返回内置 + 扩展的完整城市名列表，供前端做输入联想。 */
export function listAllCities() {
  const builtin = listSupportedCityNames();
  const ext = Object.keys(loadExtendedCities());
  return Array.from(new Set([...builtin, ...ext])).sort((a, b) => a.localeCompare(b, 'zh'));
}

/**
 * 在线城市解析（Nominatim / OpenStreetMap，免费免 Key，覆盖全国行政区划）。
 * 作为本地城市库的兜底：本地库查不到时再走这里。
 * @returns {Promise<{longitude:number,label:string,source:'city'}|null>}
 */
async function resolveLocationOnline(raw) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(raw)}&format=json&limit=1&accept-language=zh&countrycodes=cn`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ChenLu-Bazi/1.0 (destiny-tools)' },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    if (!hit || hit.lon === undefined) return null;
    const lng = Number.parseFloat(hit.lon);
    if (!Number.isFinite(lng)) return null;
    const name = hit.display_name ? hit.display_name.split(',')[0].trim() : raw;
    return { longitude: +lng.toFixed(2), label: name, source: 'city' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析出生地。支持三种输入：城市名、纯经度数字、城市名+经度。
 * 本地库（内置 + 扩展）查不到时，自动调用在线城市 API 兜底。
 * @returns {Promise<{longitude:number, label:string, source:'city'|'longitude'}>}
 */
export async function resolveLocation(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请填写出生地（城市名或经度）');

  // 纯经度
  const asNumber = Number.parseFloat(raw);
  if (Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(raw)) {
    if (asNumber < -180 || asNumber > 180) throw new Error('经度需在 -180 到 180 之间');
    return { longitude: asNumber, label: `${asNumber}°E`, source: 'longitude' };
  }

  const builtin = resolveBuiltinCity(raw);
  if (builtin !== undefined) return { longitude: builtin, label: raw, source: 'city' };

  const ext = loadExtendedCities();
  if (ext[raw] !== undefined) return { longitude: ext[raw], label: raw, source: 'city' };

  // 去掉常见行政后缀再试一次
  const stripped = raw.replace(/(市|县|区|省|自治州|地区)$/g, '');
  if (stripped !== raw) {
    const b2 = resolveBuiltinCity(stripped);
    if (b2 !== undefined) return { longitude: b2, label: raw, source: 'city' };
    if (ext[stripped] !== undefined) return { longitude: ext[stripped], label: raw, source: 'city' };
  }

  // 本地库未命中 → 在线城市 API 兜底（先原词，再去掉后缀）
  const online = (await resolveLocationOnline(raw)) ||
    (stripped !== raw ? await resolveLocationOnline(stripped) : null);
  if (online) return online;

  throw new Error(`无法识别出生地「${raw}」。可直接填经度（如 105.72），或确认城市名是否正确。`);
}

function parseLocalDateTime(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  if (!y || !m || !d) throw new Error('日期格式无效，应为 YYYY-MM-DD');
  return new Date(Date.UTC(y, m - 1, d, hh ?? 0, mm ?? 0, 0));
}

function formatDateTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(
    date.getUTCHours()
  )}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

function safeEquationOfTime(date) {
  try {
    return getEquationOfTimeSeconds(date);
  } catch {
    return 0;
  }
}

/**
 * 真太阳时换算（通用版，支持海外）。
 *
 * 平太阳时 = 地方时钟时间 + (当地经度 - 标准经度) × 4 分钟
 * 标准经度 = UTC 偏移 × 15（中国 UTC+8 → 标准经度 120，与内置算法一致）
 * 真太阳时 = 平太阳时 + 真平太阳时差
 */
export function toTrueSolarTime(localDateTime, longitude, utcOffsetHours = 8) {
  const standardLongitude = utcOffsetHours * 15;
  const meanOffsetSeconds = Math.round((longitude - standardLongitude) * 4 * 60);
  const meanSolarTime = new Date(localDateTime.getTime() + meanOffsetSeconds * 1000);
  const eotSeconds = safeEquationOfTime(meanSolarTime);
  const totalSeconds = meanOffsetSeconds + eotSeconds;
  const trueSolarTime = new Date(localDateTime.getTime() + totalSeconds * 1000);

  return {
    trueSolarTime,
    iso: formatDateTime(trueSolarTime),
    meanSolarTimeIso: formatDateTime(meanSolarTime),
    meanOffsetMinutes: +(meanOffsetSeconds / 60).toFixed(2),
    eotMinutes: +(eotSeconds / 60).toFixed(2),
    totalOffsetMinutes: +(totalSeconds / 60).toFixed(2),
    standardLongitude,
  };
}

/** 将引擎返回的「1996年11月21日 09:30:00」解析为 Date。 */
function parseEngineSolarDateTime(text) {
  const m = String(text).match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error(`无法解析阳历时间：${text}`);
  return new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0)
  );
}

/**
 * 主入口：生成命盘。
 *
 * @param {object} input
 * @param {'solar'|'lunar'} input.calendar   输入日期的历法
 * @param {string} input.date                YYYY-MM-DD
 * @param {string} input.time                HH:mm
 * @param {0|1} input.gender                 1 男，0 女
 * @param {1|2} input.sect                   1 晚子时算次日，2 算当日
 * @param {string} input.location            城市名或经度
 * @param {number} [input.utcOffset]         出生地时钟的 UTC 偏移（小时），中国为 8
 * @param {boolean} [input.enableTrueSolar]  是否做真太阳时校正，默认 true
 */
export async function buildChart(input) {
  const {
    calendar = 'solar',
    date,
    time = '00:00',
    gender = 1,
    sect = 2,
    location,
    utcOffset = 8,
    enableTrueSolar = true,
  } = input;

  if (!date) throw new Error('请填写出生日期');

  const locationInfo = await resolveLocation(location);
  const localDateTime = parseLocalDateTime(date, time);

  // 第一步：按输入历法确定公历时刻。农历输入先用引擎换算一次拿到阳历。
  let solarDateText = null;
  if (calendar === 'lunar') {
    const probe = buildBaziFromLunar({
      lunarTime: `${date}T${time}:00`,
      gender,
      sect,
    });
    solarDateText = probe.阳历;
  }

  const baseSolarDateTime =
    calendar === 'lunar' ? parseEngineSolarDateTime(solarDateText) : localDateTime;

  // 第二步：真太阳时校正
  const tst = toTrueSolarTime(baseSolarDateTime, locationInfo.longitude, utcOffset);
  const finalTime = enableTrueSolar ? tst.iso : formatDateTime(baseSolarDateTime);

  // 第三步：按校正后的时间正式排盘
  const bazi = buildBaziFromSolar({ solarTime: finalTime, gender, sect });

  // 校正是否改变了时柱（提示用户这一步的影响）
  const uncorrected = buildBaziFromSolar({
    solarTime: formatDateTime(baseSolarDateTime),
    gender,
    sect,
  });

  return {
    input: {
      calendar,
      date,
      time,
      gender,
      sect,
      location: locationInfo.label,
      longitude: locationInfo.longitude,
      locationSource: locationInfo.source,
      utcOffset,
      enableTrueSolar,
    },
    solarTime: formatDateTime(baseSolarDateTime),
    lunarTimeText: bazi.农历,
    trueSolarTime: {
      applied: !!enableTrueSolar,
      iso: tst.iso,
      meanSolarTimeIso: tst.meanSolarTimeIso,
      meanOffsetMinutes: tst.meanOffsetMinutes,
      eotMinutes: tst.eotMinutes,
      totalOffsetMinutes: tst.totalOffsetMinutes,
      pillarChanged: uncorrected.八字 !== bazi.八字,
      uncorrectedPillars: uncorrected.八字,
      changedHourPillar:
        uncorrected.时柱?.天干?.天干 !== bazi.时柱?.天干?.天干 ||
        uncorrected.时柱?.地支?.地支 !== bazi.时柱?.地支?.地支,
    },
    natal: bazi,
    pillars: bazi.八字.trim().split(/\s+/),
    dayMaster: bazi.日主,
  };
}

/**
 * 查询大运与流年 / 流月。
 * @param {object} chart  buildChart 的返回值
 * @param {object} opts   { level, startDateTime, endDateTime }
 */
export function queryFortune(chart, opts = {}) {
  const level = opts.level ?? 'month';
  const input = {
    birth: {
      calendar: 'solar',
      time: chart.trueSolarTime.iso,
      gender: chart.input.gender,
      sect: chart.input.sect,
    },
    query: {
      startDateTime: opts.startDateTime,
      endDateTime: opts.endDateTime,
      level,
    },
  };
  return queryFortuneRange(input);
}

/** 把四柱拆成结构化数组，便于规则引擎消费。 */
export function extractPillars(natal) {
  const order = ['年柱', '月柱', '日柱', '时柱'];
  return order.map((key) => {
    const p = natal[key];
    const hidden = [];
    const cg = p.地支?.藏干 ?? {};
    for (const tier of ['主气', '中气', '余气']) {
      if (cg[tier]?.天干) hidden.push({ tier, stem: cg[tier].天干, god: cg[tier].十神 });
    }
    return {
      key,
      label: key.replace('柱', ''),
      stem: p.天干?.天干,
      stemElement: p.天干?.五行,
      stemYinYang: p.天干?.阴阳,
      branch: p.地支?.地支,
      branchElement: p.地支?.五行,
      branchYinYang: p.地支?.阴阳,
      god: p.天干?.十神,
      hidden,
      naYin: p.纳音,
      xun: p.旬,
      kongWang: p.空亡,
      starFortune: p.星运,
      ziZuo: p.自坐,
      shen: natal.神煞?.[key] ?? [],
    };
  });
}
