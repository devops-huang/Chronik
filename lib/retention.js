/**
 * 辰箓 · I2 留存「节律调度器」(Backend-B)
 *
 * 职责：进程内轻量扫描器，按节律/节点给用户生成站内信（notifications）。
 *   - 节气提醒（未来 7 天内的节气）
 *   - 流年 / 运势节点（本命年 / 冲太岁 / 三合 / 大运交接）
 *   - 生日彩蛋
 *   - 续费提醒（I3 付费已上线，一并实现，C1）
 *
 * 设计约定（arch §7）：
 *   1. 只用 lib/db.js 的 query()；不新建 PG 连接。
 *   2. fail-open：每个 scan 独立 try/catch，异常仅 console.error，绝不抛到主服务。
 *   3. 幂等：所有写走 INSERT ... ON CONFLICT DO NOTHING（依赖 idx_notif_uniq 唯一部分索引）。
 *   4. 合规：所有命理文案含 L2 免责声明（文化研究/娱乐参考，不构成建议）。
 *   5. 偏好开关：生成前先读 users.notification_settings[type]，关则跳过。
 *
 * 历法依赖：cantian-tymext（透传 tyme4ts）。已实读确认方法签名：
 *   SolarTerm.fromIndex(year, i) / fromName(year, name) → getSolarDay() → getJulianDay().getDay()
 *   SolarDay.fromYmd(y, m, d).getLunarDay().getYearSixtyCycle() → SixtyCycle
 *     SixtyCycle.getName() / getHeavenStem().getName() / getEarthBranch().getName()
 */

import { query } from './db.js';
import {
  SolarTerm, SolarDay, LunarDay,
} from 'cantian-tymext';
import { DISCLAIMER_L2 } from './content-policy.js';

// ── 常量 ──
const RENEWAL_LEAD_DAYS = 7; // R5 续费提前提醒天数（arch §8.5 默认 7）
const DAYUN_WINDOW_DAYS = 182; // 大运交接窗口 ±0.5 年（arch B2）

// 24 节气中文名 → 拼音（ref_period 去重键用，匹配 arch 示例 solar_term:2026-shuangjiang）
const SOLAR_TERM_PINYIN = {
  冬至: 'dongzhi', 小寒: 'xiaohan', 大寒: 'dahan', 立春: 'lichun',
  雨水: 'yushui', 惊蛰: 'jingzhe', 春分: 'chunfen', 清明: 'qingming',
  谷雨: 'guyu', 立夏: 'lixia', 小满: 'xiaoman', 芒种: 'mangzhong',
  夏至: 'xiazhi', 小暑: 'xiaoshu', 大暑: 'dashu', 立秋: 'liqiu',
  处暑: 'chushu', 白露: 'bailu', 秋分: 'qiufen', 寒露: 'hanlu',
  霜降: 'shuangjiang', 立冬: 'lidong', 小雪: 'xiaoxue', 大雪: 'daxue',
};

// 通知偏好默认值（与 schema.sql / server.js 保持一致）
const NOTIF_DEFAULTS = {
  solar_term: true, liunian: true, destiny_node: true, birthday: true, email: false,
};

// 六冲（地支对）
const CHONG_PAIRS = [
  ['子', '午'], ['丑', '未'], ['寅', '申'], ['卯', '酉'], ['辰', '戌'], ['巳', '亥'],
];
// 三合（地支三元素组）
const SANHE_GROUPS = [
  ['申', '子', '辰'], ['亥', '卯', '未'], ['寅', '午', '戌'], ['巳', '酉', '丑'],
];

// ── 工具函数 ──

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 读取并归一化单个偏好键（缺省回默认全开；异常安全）。 */
function isEnabled(raw, key) {
  if (!raw || typeof raw !== 'object') return NOTIF_DEFAULTS[key] !== false;
  const v = raw[key];
  if (v === undefined || v === null) return NOTIF_DEFAULTS[key] !== false;
  return Boolean(v);
}

/** 取今天（北京时间自然日，与全仓口径一致）SolarDay。 */
function todaySolarDay() {
  const now = new Date();
  return SolarDay.fromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** 取当前「流年」干支（SixtyCycle）。以立春为界（LunarDay.getYearSixtyCycle 已处理）。 */
function currentLiuNian() {
  return todaySolarDay().getLunarDay().getYearSixtyCycle();
}

/** 当前流年对应的公历年份（用于 ref_period 年份标签）。 */
function currentLiuNianYear() {
  const now = new Date();
  const todayJD = todaySolarDay().getJulianDay().getDay();
  const lichunJD = SolarTerm.fromName(now.getFullYear(), '立春').getSolarDay().getJulianDay().getDay();
  // 立春前仍属上一流年
  return todayJD >= lichunJD ? now.getFullYear() : now.getFullYear() - 1;
}

/** 未来 days 天内将发生的节气（含名称/日期/与今天天数差）。 */
function upcomingSolarTerms(days = 7) {
  const now = new Date();
  const todayJD = todaySolarDay().getJulianDay().getDay();
  const out = [];
  for (const yr of [now.getFullYear(), now.getFullYear() + 1]) {
    for (let i = 0; i < 24; i++) {
      try {
        const term = SolarTerm.fromIndex(yr, i);
        const sd = term.getSolarDay();
        const diff = sd.getJulianDay().getDay() - todayJD;
        if (diff >= 0 && diff <= days) {
          out.push({
            name: term.getName(),
            year: yr,
            diff,
            dateStr: `${sd.getSolarMonth().getSolarYear().getYear()}-${pad2(sd.getSolarMonth().getMonth())}-${pad2(sd.getDay())}`,
          });
        }
      } catch {
        /* 个别索引越界忽略 */
      }
    }
  }
  return out;
}

/** 从 charts 行中抽取最近命盘（chart/fortune/interpret）。 */
function latestChartOf(row) {
  return row?.last_chart || null;
}

/** 抽取大运序列（兼容 fortune.dayun 中文键 与 interpret.dayun 英文键）。 */
function extractDayun(chartRow) {
  const list = [];
  const f = chartRow?.fortune?.dayun;
  if (Array.isArray(f)) {
    for (const it of f) {
      const startYear = Number(it?.开始年份 ?? it?.startYear ?? it?.start_year ?? 0);
      const ganzhi = String(it?.干支 ?? it?.ganzhi ?? '').trim();
      if (startYear && ganzhi) list.push({ startYear, ganzhi });
    }
  }
  // 兜底：interpret.dayun（isCurrent 标记，含 startYear/ganzhi）
  const inter = chartRow?.interpret?.dayun;
  if (Array.isArray(inter)) {
    for (const it of inter) {
      const startYear = Number(it?.startYear ?? it?.start_year ?? 0);
      const ganzhi = String(it?.ganzhi ?? it?.干支 ?? '').trim();
      if (startYear && ganzhi) list.push({ startYear, ganzhi });
    }
  }
  return list;
}

/** 折线：当前用户是否处于某大运起运窗口（±0.5 年）。返回命中的大运项或 null。 */
function dayunTransitionNow(dayunList) {
  const todayJD = todaySolarDay().getJulianDay().getDay();
  let best = null;
  let bestAbs = Infinity;
  for (const dy of dayunList) {
    try {
      const lichun = SolarTerm.fromName(dy.startYear, '立春').getSolarDay();
      const diff = lichun.getJulianDay().getDay() - todayJD;
      const abs = Math.abs(diff);
      if (abs <= DAYUN_WINDOW_DAYS && abs < bestAbs) {
        bestAbs = abs;
        best = dy;
      }
    } catch {
      /* 忽略 */
    }
  }
  return best;
}

/** 写库核心：幂等插入（依赖 idx_notif_uniq 唯一部分索引 + ON CONFLICT DO NOTHING）。 */
async function writeNotification(user_id, type, ref_period, title, body, payload) {
  await query(
    `INSERT INTO notifications (user_id, type, ref_period, title, body, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, type, ref_period) WHERE ref_period IS NOT NULL DO NOTHING`,
    [Number(user_id), type, ref_period, title, body, JSON.stringify(payload || {})],
  );
}

/** 取偏好开启且近期有命盘的用户（chart/fortune/interpret 一并取回）。 */
async function fetchUsersWithChart(enabledKeys) {
  const cond = enabledKeys
    .map((k) => `notification_settings->>'${k}' IS DISTINCT FROM 'false'`)
    .join('\n        OR ');
  const sql = `
    SELECT u.id, u.notification_settings,
      (SELECT json_build_object('chart', c.chart, 'fortune', c.fortune, 'interpret', c.interpret)
       FROM charts c WHERE c.user_id = u.id ORDER BY c.created_at DESC LIMIT 1) AS last_chart
    FROM users u
    WHERE ${cond}`;
  const r = await query(sql);
  return r;
}

// ── B1 · 节气扫描 ──
async function scanSolarTerm() {
  const terms = upcomingSolarTerms(7);
  if (!terms.length) return 0;
  const users = await query(`
    SELECT u.id, u.notification_settings,
      (SELECT json_build_object('chart', c.chart, 'fortune', c.fortune, 'interpret', c.interpret)
       FROM charts c WHERE c.user_id = u.id ORDER BY c.created_at DESC LIMIT 1) AS last_chart
    FROM users u
    WHERE notification_settings->>'solar_term' IS DISTINCT FROM 'false'`);
  let n = 0;
  for (const u of users.rows) {
    if (!isEnabled(u.notification_settings, 'solar_term')) continue;
    const chart = latestChartOf(u);
    const pillars = chart?.chart?.pillars;
    const summary = Array.isArray(pillars) ? pillars.join(' ') : '';
    for (const t of terms) {
      const ref = `solar_term:${t.year}-${SOLAR_TERM_PINYIN[t.name] || t.name}`;
      const title = `${t.name}将至 · 你的命宫新节律`;
      const body =
        `${t.dateStr} ${t.name}将至。节气更替，气场流转，你的流年与命宫亦随之迎来新的节律节点。` +
        `不妨回到辰箓，看看这一节气与你的四柱如何相应。${DISCLAIMER_L2}`;
      await writeNotification(Number(u.id), 'solar_term', ref, title, body, {
        link: '/studio.html',
        ref,
        chart_summary: summary,
        disclaimer: 'L2',
      });
      n++;
    }
  }
  return n;
}

// ── B2 · 流年 + 运势节点（本命年 / 冲太岁 / 三合 / 大运交接）──
async function scanLiuNianAndDestiny() {
  const liu = currentLiuNian(); // SixtyCycle（当前流年干支）
  const curBranch = liu.getEarthBranch().getName(); // 当前流年地支
  const curName = liu.getName(); // 如 丙午
  const liuYear = currentLiuNianYear();
  const users = await fetchUsersWithChart(['liunian', 'destiny_node']);
  let n = 0;
  for (const u of users.rows) {
    const chart = latestChartOf(u);
    const pillars = chart?.chart?.pillars;
    // 年柱地支 = 用户四柱[0] 的第二字
    let userBranch = null;
    if (Array.isArray(pillars) && pillars[0] && typeof pillars[0] === 'string' && pillars[0].length >= 2) {
      userBranch = pillars[0][1];
    }
    if (!userBranch) continue; // 无命盘无法比对，跳过

    // ① 本命年（同支）→ liunian
    if (userBranch === curBranch && isEnabled(u.notification_settings, 'liunian')) {
      const ref = `liunian:${liuYear}-${curName}`;
      const title = `本命年将至 · 流年临命`;
      const body =
        `${curName}年（${liuYear}）是你的本命年——流年地支与年柱同支，气场共振更显。` +
        `不妨回望年初的命盘，看看这一年与你的四柱如何相应。${DISCLAIMER_L2}`;
      await writeNotification(Number(u.id), 'liunian', ref, title, body, {
        link: '/studio.html', ref, chart_summary: Array.isArray(pillars) ? pillars.join(' ') : '', disclaimer: 'L2',
      });
      n++;
    }

    // ② 冲太岁（六冲）→ destiny_node
    const isChong = CHONG_PAIRS.some(
      ([a, b]) => (a === userBranch && b === curBranch) || (b === userBranch && a === curBranch),
    );
    if (isChong && isEnabled(u.notification_settings, 'destiny_node')) {
      const ref = `destiny_node:${liuYear}-${curName}`;
      const title = `冲太岁临近 · 留意节律`;
      const body =
        `${curName}年，你的年柱地支与流年形成「冲」的关系，传统上视为变动较明显的年份。` +
        `可回到辰箓，借助 AI 重新梳理这一年的气场起伏。${DISCLAIMER_L2}`;
      await writeNotification(Number(u.id), 'destiny_node', ref, title, body, {
        link: '/studio.html', ref, chart_summary: Array.isArray(pillars) ? pillars.join(' ') : '', disclaimer: 'L2',
      });
      n++;
    }

    // ③ 三合（同组且非本命年/非同支）→ destiny_node（可选生成）
    // 注：userBranch === curBranch 已是本命年（①），不再重复生成三合。
    const inSanhe = userBranch !== curBranch && SANHE_GROUPS.some(
      (g) => g.includes(userBranch) && g.includes(curBranch),
    );
    if (inSanhe && isEnabled(u.notification_settings, 'destiny_node')) {
      const ref = `destiny_node:sanhe-${liuYear}-${curName}`;
      const title = `三合之年 · 气场相扶`;
      const body =
        `${curName}年与你年柱地支三合，传统上视为相扶之年，节奏或更为顺遂。` +
        `回到辰箓，看看这一年的流年如何与你的四柱相应。${DISCLAIMER_L2}`;
      await writeNotification(Number(u.id), 'destiny_node', ref, title, body, {
        link: '/studio.html', ref, chart_summary: Array.isArray(pillars) ? pillars.join(' ') : '', disclaimer: 'L2',
      });
      n++;
    }

    // ④ 大运交接（命宫变动落点，±0.5 年窗口）→ destiny_node
    if (isEnabled(u.notification_settings, 'destiny_node')) {
      const dy = dayunTransitionNow(extractDayun(chart));
      if (dy) {
        const ref = `destiny_node:dayun-${dy.startYear}`;
        const title = `大运交接 · 命宫新节律`;
        const body =
          `你即将迎来大运交接的节点（${dy.ganzhi}大运启程），命宫节律随之转换。` +
          `回到辰箓，看看新的大运如何与你的四柱相应。${DISCLAIMER_L2}`;
        await writeNotification(Number(u.id), 'destiny_node', ref, title, body, {
          link: '/studio.html', ref, chart_summary: Array.isArray(pillars) ? pillars.join(' ') : '', disclaimer: 'L2',
        });
        n++;
      }
    }
  }
  return n;
}

// ── B3 · 生日 / 周年彩蛋 ──
async function scanBirthday() {
  const now = new Date();
  const todayMmdd = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const users = await query(`
    SELECT id, birth_date, notification_settings
    FROM users
    WHERE birth_date IS NOT NULL
      AND notification_settings->>'birthday' IS DISTINCT FROM 'false'`);
  let n = 0;
  for (const u of users.rows) {
    if (!isEnabled(u.notification_settings, 'birthday')) continue;
    // 兼容 YYYY-MM-DD 与 YYYY-M-D 两种格式
    const m = String(u.birth_date).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) continue;
    const mmdd = `${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
    if (mmdd !== todayMmdd) continue;
    const ref = `birthday:${now.getFullYear()}`;
    const title = `生日快乐 · 你的命理彩蛋`;
    const body =
      `生日快乐 🎂 这是属于你的日子。回到辰箓，重温你的命盘与今年的流年节律，` +
      `也欢迎把这份命理彩蛋分享给朋友。${DISCLAIMER_L2}`;
    await writeNotification(Number(u.id), 'birthday', ref, title, body, {
      link: '/studio.html', ref, disclaimer: 'L2',
    });
    n++;
  }
  return n;
}

// ── C1 · 续费提醒（R5 通知侧，I3 付费已上线）──
async function scanRenewalReminder() {
  // 到期时间落在 [now, now+LEAD] 内的有效授权
  const r = await query(`
    SELECT id, grantee_type, grantee_id, expires_at
    FROM entitlement_grants
    WHERE expires_at BETWEEN now() AND now() + ($1 || ' days')::interval`, [String(RENEWAL_LEAD_DAYS)]);
  let n = 0;
  for (const g of r.rows) {
    // grantee_id 为 TEXT：user_id 类型需转数字；anon_id 尝试经 user_anon_link 解析
    let uid = null;
    if (g.grantee_type === 'user_id') {
      const num = Number(g.grantee_id);
      if (Number.isFinite(num)) uid = num;
    } else {
      try {
        const link = await query('SELECT user_id FROM user_anon_link WHERE anon_id=$1 LIMIT 1', [g.grantee_id]);
        if (link.rowCount) {
          const num = Number(link.rows[0].user_id);
          if (Number.isFinite(num)) uid = num;
        }
      } catch {
        /* 解析失败跳过 */
      }
    }
    if (!uid) continue;
    const expMs = new Date(g.expires_at).getTime();
    const days = Math.max(0, Math.ceil((expMs - Date.now()) / 86400000));
    const ymd = new Date(g.expires_at).toISOString().slice(0, 10).replace(/-/g, '');
    const ref = `renewal:${ymd}`;
    const title = `结缘堂将于 ${days} 天后续期`;
    const body =
      `你的结缘堂权益将于 ${days} 天后到期。续费（年卡 / 兑换码）即可连续持有权益，` +
      `AI 答疑与命理解读不断档。`;
    await writeNotification(uid, 'renewal_reminder', ref, title, body, {
      link: '/pricing.html', ref,
    });
    n++;
  }
  return n;
}

// ── 主入口 ──
/**
 * 运行一次完整留存扫描。fail-open：任一 scan 异常仅记录，不影响其余 scan 与主服务。
 * @returns {Promise<number>} 本次生成的站内信条数（近似，含 ON CONFLICT 跳过的）
 */
export async function runRetentionScan() {
  const start = Date.now();
  let total = 0;
  const scans = [
    scanSolarTerm,
    scanLiuNianAndDestiny,
    scanBirthday,
    scanRenewalReminder,
  ];
  for (const fn of scans) {
    try {
      const c = await fn();
      total += Number(c || 0);
    } catch (e) {
      console.error('[retention] scan 失败（fail-open）：', fn.name, e && e.message);
    }
  }
  console.log('[retention] 扫描完成，耗时 %dms，生成 %d 条', Date.now() - start, total);
  return total;
}

export default { runRetentionScan, RENEWAL_LEAD_DAYS };
