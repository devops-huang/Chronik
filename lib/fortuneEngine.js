/**
 * 5.3 今日运势「真个性化」—— 四元交互引擎
 *
 * 【旧实现的问题】
 *   旧版 = 日主五行 × 当日天干五行 → 5 条固定文案（REL_ADVICE）。
 *   5 种五行 × 5 种五行 = 25 种组合，却只映射到 5 条文案，
 *   同一天五行相同的用户必然撞文案，「撞车」是数学上的必然，不是概率问题。
 *
 * 【新实现：四元交互】
 *   四元 = 日主天干 × 月令(出生月支) × 流日天干 × 流日地支
 *   ① 旺相休囚死：以月令当令之气定日主先天旺衰
 *   ② 流日干支十神：叠加当日干支（含藏干）对日主的扶抑 → 身强/偏强/中和/偏弱/身弱
 *   ③ 扶抑法定喜忌：身强喜耗泄克（财/官杀/食伤），身弱喜生扶（印/比劫）
 *   ④ 四维度打分（事业/财/感情/健康）+ 总分（0-100，日间可比）
 *   ⑤ 输出「为什么」：把推导链条讲清楚 —— 这是个性化的最强证明
 *
 * 【Non-goals（严格遵守）】
 *   - 不做绝对化吉凶断言：文案禁用「必/一定/破财/灾」等词，一律用「利于/宜/偏/需留意/防」
 *   - 不做用户之间的对比与排行
 *   - 不做付费解锁详细版
 */
import { SolarDay, HeavenStem, EarthBranch, LunarDay } from 'cantian-tymext';

// ── 基础常量 ────────────────────────────────────────────────
const STEM_ELEMENT = {
  甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土',
  己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水',
};
const BRANCH_ELEMENT = {
  子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火',
  午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水',
};

/** 十神归五大类：扶抑法与维度映射都以「类」为单位判断，正偏只影响文案措辞。 */
const STAR_CATEGORY = {
  比肩: '比劫', 劫财: '比劫',
  食神: '食伤', 伤官: '食伤',
  正财: '财', 偏财: '财',
  正官: '官杀', 七杀: '官杀',
  正印: '印', 偏印: '印',
};

/**
 * 五行生克：ELEMENT_REL[我][他] = 「他」相对「我」的作用。
 * 例：ELEMENT_REL['木']['金'] === '克我'（金克木）。
 */
const ELEMENT_REL = {
  木: { 木: '同', 火: '我生', 土: '我克', 金: '克我', 水: '生我' },
  火: { 火: '同', 土: '我生', 金: '我克', 水: '克我', 木: '生我' },
  土: { 土: '同', 金: '我生', 水: '我克', 木: '克我', 火: '生我' },
  金: { 金: '同', 水: '我生', 木: '我克', 火: '克我', 土: '生我' },
  水: { 水: '同', 木: '我生', 火: '我克', 土: '克我', 金: '生我' },
};

/** 各十神类别对日主是「扶」还是「抑」（扶抑法核心）。 */
const SUPPORT_SIGN = { 印: 1, 比劫: 1, 财: -1, 官杀: -1, 食伤: -1 };

/** 各维度受哪些十神主导，及该星在该维度上的固有影响权重（负号=该星天然对此维度不利）。 */
const DIM_WEIGHTS = {
  career: { 官杀: 1, 印: 0.5, 财: 0.3, 食伤: 0.2, 比劫: 0.2 },
  wealth: { 财: 1, 食伤: 0.5, 比劫: -0.4, 官杀: -0.2, 印: -0.2 },
  health: { 印: 1, 比劫: 0.5, 官杀: -1, 食伤: -0.5, 财: -0.3 },
};

// ── 小工具 ──────────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 十神名（相对日主）。用库的 getTenStar 而非自造，保证与排盘/大运口径完全一致。 */
function tenStarOf(dayMasterStem, otherStem) {
  try {
    return HeavenStem.fromName(dayMasterStem).getTenStar(HeavenStem.fromName(otherStem)).getName();
  } catch {
    return '比肩';
  }
}

const categoryOf = (star) => STAR_CATEGORY[star] || '比劫';

/** 地支藏干（顺序：本气 → 中气 → 余气）。 */
function hiddenStems(zhi) {
  try {
    return EarthBranch.fromName(zhi).getHideHeavenStems().map((h) => h.getHeavenStem().toString());
  } catch {
    return [];
  }
}

/**
 * 旺相休囚死：以月令当令之气判定日主先天旺衰。
 * 同令者旺、令生者相、我生令者休、我克令者囚、令克我者死。
 */
function lingState(dayMasterElement, monthElement) {
  const rel = ELEMENT_REL[dayMasterElement]?.[monthElement] || '同';
  const table = {
    同: { key: '旺', score: 2.0, desc: '得令当旺' },
    生我: { key: '相', score: 1.0, desc: '得令相生' },
    我生: { key: '休', score: -0.5, desc: '泄气于令' },
    我克: { key: '囚', score: -1.0, desc: '受制于令' },
    克我: { key: '死', score: -2.0, desc: '受克于令' },
  };
  return table[rel] || table['同'];
}

// ── ① 身强弱 ────────────────────────────────────────────────
function buildStrength(dayMasterStem, monthZhi, flowDayStem, flowDayZhi) {
  const dmEl = STEM_ELEMENT[dayMasterStem];
  const monthEl = BRANCH_ELEMENT[monthZhi];
  const ling = lingState(dmEl, monthEl);

  let score = ling.score;

  // 流日天干：十神扶抑 × 当令力量（天干得月令生扶则力大，受月令克制则力弱）
  const ganStar = tenStarOf(dayMasterStem, flowDayStem);
  const ganCat = categoryOf(ganStar);
  const ganRel = ELEMENT_REL[STEM_ELEMENT[flowDayStem]]?.[monthEl] || '同';
  const ganPower = ganRel === '同' || ganRel === '生我' ? 1.3 : ganRel === '克我' ? 0.7 : 1.0;
  score += (SUPPORT_SIGN[ganCat] || 0) * ganPower;

  // 流日地支：藏干扶抑（权重低于天干）；干支同气则地支助力更大
  const hide = hiddenStems(flowDayZhi);
  const zhiPower = BRANCH_ELEMENT[flowDayZhi] === STEM_ELEMENT[flowDayStem] ? 0.9 : 0.6;
  hide.forEach((hs, i) => {
    // 本气 0.5、中气 0.3、余气 0.2 —— 藏干力量递减
    const w = [0.5, 0.3, 0.2][i] ?? 0.15;
    score += (SUPPORT_SIGN[categoryOf(tenStarOf(dayMasterStem, hs))] || 0) * zhiPower * w;
  });

  const label =
    score >= 2 ? '身强' : score >= 0.8 ? '偏强' : score > -0.8 ? '中和' : score > -2 ? '偏弱' : '身弱';

  return { score, label, ling, ganStar, ganCat, ganPower, hide };
}

/** 扶抑法定喜忌。 */
function likeDislike(strengthLabel) {
  if (strengthLabel === '身强' || strengthLabel === '偏强') {
    return { like: ['财', '官杀', '食伤'], dislike: ['印', '比劫'] };
  }
  if (strengthLabel === '身弱' || strengthLabel === '偏弱') {
    return { like: ['印', '比劫'], dislike: ['财', '官杀', '食伤'] };
  }
  return { like: ['财', '食伤'], dislike: [] };
}

// ── ② 维度打分 ──────────────────────────────────────────────
/**
 * @param weights 该维度上各星的固有权重（可正可负）
 * @param stars   当日实际出现的星及其力量 [{cat, power}]
 * 喜星加分、忌星减分；健康维度特殊：星本身对健康的负向影响会被「是否为忌神」放大或减弱。
 */
function scoreDimension(weights, stars, like, dislike) {
  let delta = 0;
  for (const { cat, power } of stars) {
    const w = weights[cat] || 0;
    if (w === 0) continue;
    if (like.includes(cat)) {
      // 喜神：正向促进；若该星本身对维度不利（如健康遇官杀），伤害减半
      delta += w > 0 ? w * 16 * power : w * 16 * power * 0.5;
    } else if (dislike.includes(cat)) {
      // 忌神：负向拖累；若该星本身对维度不利，伤害放大
      delta += w > 0 ? -w * 16 * power : w * 16 * power * 1.4;
    } else {
      delta += w * 2 * power;
    }
  }
  return clamp(Math.round(54 + delta), 18, 93);
}

/** 维度基线修正：健康以「大体无恙」为常态，只在忌神冲击时才明显走低。 */
const DIM_BONUS = { health: 5 };

const tierOf = (s) => (s >= 75 ? '顺' : s >= 63 ? '向好' : s >= 50 ? '平稳' : s >= 38 ? '需稳' : '宜守');

// ── ③ 文案 ──────────────────────────────────────────────────
/** 各维度「星 × 喜忌」的核心表述（10 句/维度，避免旧版 5 条撞车）。 */
const DIM_PHRASE = {
  career: {
    '官杀:喜': '官杀得用，掌权与推进的机会出现，宜主动承担、把关键事项落地',
    '官杀:忌': '官杀压身，约束与考核偏多，宜按规矩把承诺的事收尾，忌硬碰硬',
    '印:喜': '印星护身，易得长辈或文书之助，宜借力、按流程推进',
    '印:忌': '印星过重，易陷于等待与空想，宜主动迈出第一步',
    '财:喜': '财星生官，利于以业绩换资源，谈事易成，宜把握对外机会',
    '财:忌': '财星耗身，事务繁冗易分心，宜聚焦主线、减少枝节',
    '食伤:喜': '食伤生财，创意与表达能换来实际回报，宜展示方案',
    '食伤:忌': '食伤泄身，想法多而落地少，宜先完成再完美',
    '比劫:喜': '比劫助力，合作与人脉带来机会，宜明确分工与利益',
    '比劫:忌': '比劫夺利，竞争与分功者增多，宜守成防人',
  },
  wealth: {
    '财:喜': '财星当值，利于主动求财、结算账目，量入为出更易有收获',
    '财:忌': '财星耗身，求财辛苦且易散，宜守财、忌冲动投入',
    '食伤:喜': '食伤生财，凭技艺与创意进账的机会出现，宜把想法变现',
    '食伤:忌': '食伤泄身，投入多而回报错位，宜收缩试错范围',
    '比劫:喜': '比劫帮身，合作分润可行，但需先小人后君子',
    '比劫:忌': '比劫夺财，防为人担保、合伙分利，宜守住钱袋',
    '官杀:喜': '官杀护财，规则与合同能保护你的利益，宜落在纸面',
    '官杀:忌': '官杀克身，压力性支出或罚款类风险上升，宜留足余量',
    '印:喜': '印星生身，稳健的资产与长期安排更有利，宜做规划',
    '印:忌': '印星滞财，易因保守错失机会，宜小幅试探',
  },
  love: {
    '财:喜': '妻财星得位，感情中愿付出也易得回应，宜主动表达',
    '财:忌': '妻财星受抑，易因现实压力生隙，宜多沟通少计较',
    '官杀:喜': '官杀为用，关系中有主导与承诺的机会，宜认真推进',
    '官杀:忌': '官杀攻身，易感压迫或受外界干扰，宜给彼此空间',
    '食伤:喜': '食伤生情，表达与浪漫运佳，宜制造相处时光',
    '食伤:忌': '食伤泄气，言语易生误会，宜少辩多听',
    '比劫:喜': '比劫助力，朋友牵线或共同爱好带来缘分，宜多参与',
    '比劫:忌': '比劫争合，需防第三者干扰或比较之心，宜专注眼前人',
    '印:喜': '印星温润，宜以体贴与陪伴维系，慢即是快',
    '印:忌': '印星自闭，易把心事藏着，宜主动开口',
  },
  health: {
    '印:喜': '印星生身，精神与恢复力较好，宜规律作息',
    '印:忌': '印星郁滞，易懒散困倦，宜起身活动、晒太阳',
    '比劫:喜': '比劫帮身，体力与抵抗力在线，宜适量运动',
    '比劫:忌': '比劫耗散，易因过劳或应酬透支，宜早睡',
    '官杀:喜': '官杀有制，压力在可控范围，宜张弛有度',
    '官杀:忌': '官杀攻身，压力直冲身体，宜减负、防过劳与受凉',
    '食伤:喜': '食伤舒畅，情志舒展，宜出行散心',
    '食伤:忌': '食伤泄身，思虑过多耗神，宜减少熬夜与刺激饮食',
    '财:喜': '财星有节，饮食作息较有规律，宜保持',
    '财:忌': '财星耗身，为事务奔波伤神，宜安排休息',
  },
};

/** 维度文案 = 星义句 + 档位收束（档位只做语气修饰，不改变命理判断）。 */
const TIER_TAIL = {
  顺: '，今日此项明显偏顺，可放心推进。',
  向好: '，今日此项有向上的劲头，值得投入。',
  平稳: '，今日此项平稳，按部就班即可。',
  需稳: '，今日此项需稳扎稳打，不宜冒进。',
  宜守: '，今日此项宜守不宜进，先稳住基本盘。',
};

function dimText(dim, cat, score, like, dislike) {
  const isLike = like.includes(cat);
  const isDislike = dislike.includes(cat);
  const key = `${cat}:${isLike ? '喜' : isDislike ? '忌' : '平'}`;
  const phrase = DIM_PHRASE[dim][key] || DIM_PHRASE[dim][`${cat}:喜`] || '今日此项平稳，按部就班即可。';
  return phrase + TIER_TAIL[tierOf(score)];
}

// ── ④ 宜做 / 忌做 ───────────────────────────────────────────
const DO_BY_STAR = {
  印: '读书充电、请教长辈、整理文档与手续',
  比劫: '联络合作、请朋友助力、团队协同',
  食伤: '表达创意、写方案、公开展示',
  财: '推进商务、结算账目、务实谈利',
  官杀: '守规执行、把承诺的事收尾',
};
const AVOID_BY_STAR = {
  官杀: '硬碰硬、越级争执、承担超额责任',
  财: '冲动消费、铺张、担保借贷',
  食伤: '口舌争辩、过度自我表现',
  印: '空想拖延、只计划不行动',
  比劫: '与人分利、为他人背书、合伙冒进',
};

// ── 主入口 ──────────────────────────────────────────────────
/**
 * 四元今日运势。
 * @param {{dayStem:string, monthZhi:string, gender?:number}} natal 命盘核心（日主天干 + 月令支）
 * @param {string} dateStr YYYY-MM-DD（上海时区的「今天」）
 * @returns {object|null} 无命盘时返回 null，由调用方降级为通用文案
 */
export function buildPersonalFortune(natal, dateStr) {
  if (!natal?.dayStem || !natal?.monthZhi) return null;
  const { dayStem, monthZhi, gender } = natal;
  if (!STEM_ELEMENT[dayStem] || !BRANCH_ELEMENT[monthZhi]) return null;

  const [y, m, d] = dateStr.split('-').map(Number);
  const solarDay = SolarDay.fromYmd(y, m, d);
  const cycle = solarDay.getSixtyCycleDay();
  const dayGanzhi = cycle.getSixtyCycle().toString();
  const flowStem = dayGanzhi[0];
  const flowZhi = dayGanzhi[1];

  const strength = buildStrength(dayStem, monthZhi, flowStem, flowZhi);
  const { like, dislike } = likeDislike(strength.label);

  // 当日出现的星：流日天干（主力）+ 流日地支本气（辅助）
  const hideMain = strength.hide[0];
  const stars = [{ cat: strength.ganCat, power: strength.ganPower }];
  if (hideMain) stars.push({ cat: categoryOf(tenStarOf(dayStem, hideMain)), power: 0.5 });

  // 感情星依性别取用：男命财为妻星，女命官杀为夫星，未填则二者并重
  const loveWeights =
    gender === 2
      ? { 官杀: 1, 财: 0.4, 食伤: 0.3, 印: 0.2, 比劫: -0.2 }
      : gender === 1
        ? { 财: 1, 官杀: 0.4, 食伤: 0.3, 印: 0.2, 比劫: -0.2 }
        : { 财: 0.7, 官杀: 0.7, 食伤: 0.3, 印: 0.2, 比劫: -0.2 };

  const dims = {
    career: { weights: DIM_WEIGHTS.career, label: '事业' },
    wealth: { weights: DIM_WEIGHTS.wealth, label: '财' },
    love: { weights: loveWeights, label: '感情' },
    health: { weights: DIM_WEIGHTS.health, label: '健康' },
  };

  const items = {};
  for (const [key, cfg] of Object.entries(dims)) {
    const raw = scoreDimension(cfg.weights, stars, like, dislike);
    const score = clamp(raw + (DIM_BONUS[key] || 0), 18, 93);
    items[key] = { score, tier: tierOf(score), text: dimText(key, strength.ganCat, score, like, dislike) };
  }

  // 总分：事业/财各 30%，感情/健康各 20% 加权平均后，再做一次温和拉伸。
  // 加权平均天然会抹平极值（四项很难同时走高），拉伸让「好日子真的好、差日子真的差」，
  // 从而具备日间可比性：中心约 54，实际分布约 31–77。
  const rawAvg =
    items.career.score * 0.3 + items.wealth.score * 0.3 + items.love.score * 0.2 + items.health.score * 0.2;
  const total = clamp(Math.round(54 + (rawAvg - 50) * 1.35), 22, 92);

  // 宜/忌：优先提示「当日主星」本身，与「为什么」的推导链条保持一致；
  // 当日主星既非喜也非忌时，才退而取喜神/忌神之首
  const dayCat = strength.ganCat;
  const doStar = like.includes(dayCat) ? dayCat : (like[0] || dayCat);
  const avoidStar = dislike.includes(dayCat) ? dayCat : (dislike[0] || (dayCat === '印' ? '食伤' : '官杀'));

  const why = buildWhy({
    dayStem, monthZhi, flowStem, flowZhi, dayGanzhi, strength, like, dislike, total,
  });

  return {
    personalized: true,
    score: total,
    tier: tierOf(total),
    strength: strength.label,
    strengthScore: Number(strength.score.toFixed(2)),
    ling: strength.ling.key,
    lingDesc: strength.ling.desc,
    dayGanzhi,
    dayStar: strength.ganStar,
    dayStarCategory: strength.ganCat,
    like,
    dislike,
    items,
    do: { text: DO_BY_STAR[doStar], star: doStar },
    avoid: { text: AVOID_BY_STAR[avoidStar], star: avoidStar },
    why: { text: why },
  };
}

/** 「为什么」：把四元推导链条讲清楚，一句话证明这不是随机文案。 */
function buildWhy({ dayStem, monthZhi, flowStem, flowZhi, dayGanzhi, strength, like, dislike, total }) {
  const dmEl = STEM_ELEMENT[dayStem];
  const monthEl = BRANCH_ELEMENT[monthZhi];
  const isLike = like.includes(strength.ganCat);
  const isDislike = dislike.includes(strength.ganCat);
  const flowEl = STEM_ELEMENT[flowStem];

  const s1 = `你日主「${dayStem}」属${dmEl}，生于${monthZhi}月（${monthEl}当令，${strength.ling.desc}），综合判定${strength.label}`;
  const s2 = `今日${dayGanzhi}，${flowStem}${flowEl}透出为${strength.ganStar}`;
  const s3 = isLike
    ? `恰为你${strength.label}所喜，属喜神当值`
    : isDislike
      ? `正值你${strength.label}所忌，属忌神当值`
      : '与你日主力量相当，属平神当值';
  // 结语阈值必须与 tierOf 保持一致，否则会出现「卡片显示需稳、推导却说平稳」的口径冲突
  const s4 =
    total >= 63
      ? '，故今日整体向好，值得主动投入。'
      : total >= 50
        ? '，故今日整体平稳，按部就班即可。'
        : total >= 38
          ? '，故今日需稳扎稳打，不宜冒进。'
          : '，故今日宜守不宜进，先稳住基本盘。';

  return `${s1}；${s2}，${s3}${s4}`;
}

/**
 * 从出生日期反推命盘核心（日主天干 + 月令地支）。
 * 日主与月令只由出生「日期」决定（与时辰无关），所以没填时辰、没排过盘的用户也能个性化。
 * @param {string} birthDate YYYY-MM-DD
 * @param {number} calendar 1=阳历 2=农历
 */
export function deriveNatalFromBirth(birthDate, calendar = 1) {
  if (!birthDate || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(birthDate)) return null;
  const [y, m, d] = birthDate.split('-').map(Number);
  try {
    // 农历需先转阳历（cantian 以负月表示闰月）；转换失败即降级为通用文案
    const solarDay =
      calendar === 2 ? LunarDay.fromYmd(y, m, d).getSolarDay() : SolarDay.fromYmd(y, m, d);
    const cycle = solarDay.getSixtyCycleDay();
    const dayGanzhi = cycle.getSixtyCycle().toString();
    const monthGanzhi = cycle.getSixtyCycleMonth().getSixtyCycle().toString();
    return { dayStem: dayGanzhi[0], monthZhi: monthGanzhi[1] };
  } catch {
    return null;
  }
}
