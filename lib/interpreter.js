/**
 * 命理规则引擎。
 *
 * 把命盘结构与岁运数据翻译成人话。这里不做随机发挥——每条结论都由命盘数据
 * 按固定规则推出，保证同一命盘每次生成同样的报告。大模型只负责在此之上做
 * 自由问答，不参与报告本身的生成，所以没有 API Key 也能出完整报告。
 */
import {
  WUXING, SHENG, KE, GAN_WUXING, ZHI_WUXING, ZHI_CANGGAN, GOD_GROUP, GOD_THEME,
  SHEN_SHA, WUXING_ORGAN, TIAOHOU, ZHI_SEASON, RELATION_IMPACT,
} from './constants.js';

// ────────────────────────────────────────────────────────────
// 一、五行分布
// ────────────────────────────────────────────────────────────

export function analyzeWuxing(pillars) {
  const score = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  const detail = [];

  for (const p of pillars) {
    if (p.stem && GAN_WUXING[p.stem]) {
      score[GAN_WUXING[p.stem]] += 1;
      detail.push(`天干${p.stem}(${GAN_WUXING[p.stem]}) +1`);
    }
    if (p.branch && ZHI_WUXING[p.branch]) {
      score[ZHI_WUXING[p.branch]] += 1;
      detail.push(`地支${p.branch}(${ZHI_WUXING[p.branch]}) +1`);
    }
  }

  // 藏干加权：主气 1.0 / 中气 0.6 / 余气 0.3
  const tierWeight = { 主气: 1, 中气: 0.6, 余气: 0.3 };
  for (const p of pillars) {
    for (const h of p.hidden ?? []) {
      const el = GAN_WUXING[h.stem];
      if (!el) continue;
      const w = tierWeight[h.tier] ?? 0.5;
      score[el] += w;
      detail.push(`${p.branch}藏${h.stem}(${el}) +${w}`);
    }
  }

  const total = Object.values(score).reduce((a, b) => a + b, 0) || 1;
  const percent = {};
  for (const el of WUXING) percent[el] = +((score[el] / total) * 100).toFixed(1);

  const sorted = [...WUXING].sort((a, b) => score[b] - score[a]);
  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];

  return {
    score: Object.fromEntries(Object.entries(score).map(([k, v]) => [k, +v.toFixed(2)])),
    percent,
    strongest,
    weakest,
    missing: WUXING.filter((el) => score[el] < 0.4),
    detail,
  };
}

// ────────────────────────────────────────────────────────────
// 二、日主旺衰
// ────────────────────────────────────────────────────────────

function relationToMonth(masterEl, monthEl) {
  if (masterEl === monthEl) return '同我';
  if (SHENG[monthEl] === masterEl) return '生我';
  if (SHENG[masterEl] === monthEl) return '我生';
  if (KE[monthEl] === masterEl) return '克我';
  return '我克';
}

export function analyzeStrength(pillars, dayMaster) {
  const masterEl = GAN_WUXING[dayMaster];
  const monthBranch = pillars[1].branch;
  const monthEl = ZHI_WUXING[monthBranch];

  // 1) 得令：日主相对月令的状态
  const rel = relationToMonth(masterEl, monthEl);
  const lingScore = { 同我: 3, 我生: 1.5, 生我: 2, 克我: 0, 我克: -0.5 }[rel];
  const lingLabel = { 同我: '旺', 我生: '相', 生我: '休', 克我: '囚', 我克: '死' }[rel];

  // 2) 得地：地支藏干中是否有日主的根
  const roots = [];
  for (const p of pillars) {
    for (const h of p.hidden ?? []) {
      if (GAN_WUXING[h.stem] === masterEl) {
        const w = h.tier === '主气' ? 1 : h.tier === '中气' ? 0.6 : 0.3;
        roots.push({ pillar: p.label, branch: p.branch, stem: h.stem, tier: h.tier, weight: w });
      }
    }
  }
  const diScore = Math.min(3, roots.reduce((a, r) => a + r.weight, 0));

  // 3) 得势：其余天干中生我、同我者
  const helpers = [];
  for (const p of pillars) {
    if (p.label === '日' || !p.stem) continue;
    const el = GAN_WUXING[p.stem];
    if (el === masterEl) helpers.push({ pillar: p.label, stem: p.stem, kind: '同我' });
    else if (SHENG[el] === masterEl) helpers.push({ pillar: p.label, stem: p.stem, kind: '生我' });
  }
  const shiScore = Math.min(2, helpers.length * 0.8);

  const total = +(lingScore + diScore + shiScore).toFixed(2);
  let verdict, description;
  if (total >= 4.2) {
    verdict = '身旺';
    description = '日主根重身强，抗压与执行力是长项，独立性强；代价是凡事得自己扛，缺少倚靠。';
  } else if (total >= 3.2) {
    verdict = '偏旺';
    description = '日主略强于中和，有主见有担当，但仍需外力配合方能成事。';
  } else if (total >= 2.2) {
    verdict = '中和';
    description = '日主强弱适中，命局相对平衡，起伏较小，遇岁运变化适应能力好。';
  } else if (total >= 1.4) {
    verdict = '偏弱';
    description = '日主偏弱，需借力而行：靠平台、靠团队、靠专业背书，比单打独斗更顺。';
  } else {
    verdict = '身弱';
    description = '日主根轻身弱，宜补不宜耗，重在积累而非冒进，借势比强攻划算。';
  }

  return {
    dayMasterElement: masterEl,
    monthBranch,
    monthElement: monthEl,
    ling: { label: lingLabel, score: lingScore, note: `月令${monthBranch}(${monthEl})，日主${rel}` },
    di: { score: +diScore.toFixed(2), roots },
    shi: { score: +shiScore.toFixed(2), helpers },
    total,
    verdict,
    description,
    isStrong: total >= 3.2,
  };
}

// ────────────────────────────────────────────────────────────
// 三、格局
// ────────────────────────────────────────────────────────────

const PATTERN_DESC = {
  建禄格: {
    brief: '月令本气为比肩，日主在月令得禄',
    text: '建禄格的底色是自力更生：不靠祖荫、不靠人脉红利，靠自己的专业和执行力立身。好处是抗压强、独立性高；代价是没有躺赢这回事，凡事得自己扛。',
    advice: '身旺宜泄宜克，走「财官」或「食伤」路线最顺——要么用专业输出换资源，要么在组织里拿名分。',
  },
  月刃格: {
    brief: '月令本气为劫财，日主在月令得刃',
    text: '月刃格刚强果断、行动力强，但也主刚易折。性格上宁折不弯，遇事习惯硬扛。',
    advice: '宜以官杀制刃、以食伤泄秀，把冲劲导向具体目标，避免在情绪高点做决策。',
  },
  食神格: {
    brief: '月令本气为食神，秀气内蕴',
    text: '食神格性情温和、有审美、有口福，才华以温和的方式流露。适合靠作品、内容、技术立身。',
    advice: '食神生财是最佳路径——把能力产品化。忌见偏印夺食，即别让过度思虑打断输出。',
  },
  伤官格: {
    brief: '月令本气为伤官，锋芒外露',
    text: '伤官格聪明锐利、表达力强、不甘平庸，但天生与规则有张力，容易「赢了道理输了局面」。',
    advice: '伤官生财富贵自天来，配财星最佳；伤官见官则需收敛表达，把锋芒用在事上而非人上。',
  },
  正财格: {
    brief: '月令本气为正财，务实稳健',
    text: '正财格务实、守信用、重视积累，收入以稳定为主，不喜冒险。',
    advice: '宜稳扎稳打，靠复利而非杠杆。身弱时须先补自身，否则财多身弱反受其累。',
  },
  偏财格: {
    brief: '月令本气为偏财，善于抓机会',
    text: '偏财格人缘好、嗅觉灵敏、善于发现机会，进路多元不拘一格。',
    advice: '偏财宜流动不宜囤积，适合做资源整合与机会型业务，但要建立止盈纪律。',
  },
  正官格: {
    brief: '月令本气为正官，守规矩有名分',
    text: '正官格自律、讲原则、重视名誉，适合在有规则的环境里发展。',
    advice: '官星喜印相护、喜财相生，忌伤官来破。维护专业声誉是这格的核心资产。',
  },
  七杀格: {
    brief: '月令本气为七杀，压力中成长',
    text: '七杀格有魄力、能攻坚，但一生压力与责任感偏重，常被动承担难题。',
    advice: '七杀须制化：食神制杀最上，以技压杀；或印星化杀，以德服之。硬扛不是办法。',
  },
  正印格: {
    brief: '月令本气为正印，得滋养庇护',
    text: '正印格心性善良、学习力强、易得长辈与贵人相助，重视安全感与稳定。',
    advice: '印重须防依赖，宜配财星或食伤，把学到的东西转化为产出。',
  },
  偏印格: {
    brief: '月令本气为偏印，冷门中见长',
    text: '偏印格思维独特、善于钻研冷门领域，有不走寻常路的天赋，但也易钻牛角尖。',
    advice: '偏印宜配偏财或食伤，把冷门特长市场化；注意别让过度思考替代行动。',
  },
};

export function determinePattern(pillars) {
  const monthPillar = pillars[1];
  const mainHidden = (monthPillar.hidden ?? []).find((h) => h.tier === '主气');
  const god = mainHidden?.god ?? monthPillar.god;

  let name = null;
  if (god === '比肩') name = '建禄格';
  else if (god === '劫财') name = '月刃格';
  else if (god === '食神') name = '食神格';
  else if (god === '伤官') name = '伤官格';
  else if (god === '正财') name = '正财格';
  else if (god === '偏财') name = '偏财格';
  else if (god === '正官') name = '正官格';
  else if (god === '七杀') name = '七杀格';
  else if (god === '正印') name = '正印格';
  else if (god === '偏印') name = '偏印格';

  // 透干配合：月令本气之外的天干有无透出，影响格局成败
  const exposed = pillars
    .filter((p) => p.god && p.god !== '元神')
    .map((p) => ({ pillar: p.label, god: p.god, stem: p.stem }));

  return {
    name: name ?? '无正格（月令本气未透，需看透干取格）',
    monthBranch: monthPillar.branch,
    mainHiddenGod: god,
    ...(PATTERN_DESC[name] ?? {
      brief: '',
      text: '此命月令本气未构成常规正格，需结合透干与整体组合判断，建议向命理师细询。',
      advice: '',
    }),
    exposed,
  };
}

// ────────────────────────────────────────────────────────────
// 四、用神喜忌
// ────────────────────────────────────────────────────────────

export function determineUsefulGod(strength, dayMaster) {
  const isStrong = strength.isStrong;
  const masterEl = GAN_WUXING[dayMaster];
  const season = ZHI_SEASON[strength.monthBranch];
  const tiaohou = TIAOHOU[season]?.[masterEl];

  // 扶抑：身旺喜克泄耗，身弱喜生扶
  const fuYi = isStrong
    ? { 喜: ['官杀', '财', '食伤'], 忌: ['印', '比劫'] }
    : { 喜: ['印', '比劫'], 忌: ['官杀', '财', '食伤'] };

  const godScore = {};
  const setScore = (gods, v) => {
    for (const g of gods) {
      if (g === '官杀') { godScore['正官'] = v; godScore['七杀'] = v - 0.2; }
      else if (g === '财') { godScore['正财'] = v; godScore['偏财'] = v; }
      else if (g === '食伤') { godScore['食神'] = v; godScore['伤官'] = v - 0.3; }
      else if (g === '印') { godScore['正印'] = v; godScore['偏印'] = v - 0.3; }
      else if (g === '比劫') { godScore['比肩'] = v - 0.2; godScore['劫财'] = v; }
    }
  };
  setScore(fuYi.喜, 2);
  setScore(fuYi.忌, -1.5);

  // 调候：寒暖燥湿的纠偏，优先于扶抑
  let tiaohouNote = '';
  if (tiaohou) {
    const el = tiaohou.god;
    const elGan = Object.entries(GAN_WUXING).filter(([, v]) => v === el).map(([k]) => k);
    tiaohouNote = `${season}月生，${tiaohou.why}，调候取${el}（${elGan.join('·')}）为尊。`;
  }

  const xiElements = isStrong
    ? [KE[masterEl], SHENG[masterEl] === undefined ? null : Object.keys(KE).find((k) => KE[k] === masterEl), Object.keys(SHENG).find((k) => SHENG[masterEl] === k)].filter(Boolean)
    : [Object.keys(SHENG).find((k) => SHENG[k] === masterEl), masterEl];

  return {
    strengthVerdict: strength.verdict,
    tiaohou: tiaohou ? { element: tiaohou.god, season, why: tiaohou.why } : null,
    tiaohouNote,
    fuYi,
    godScore,
    xiElements: Array.from(new Set(xiElements)),
    jiElements: isStrong
      ? [Object.keys(SHENG).find((k) => SHENG[k] === masterEl), masterEl]
      : [KE[masterEl], Object.keys(KE).find((k) => KE[k] === masterEl)],
  };
}

// ────────────────────────────────────────────────────────────
// 五、神煞
// ────────────────────────────────────────────────────────────

export function interpretShen(shenList = []) {
  const out = [];
  for (const name of shenList) {
    const info = SHEN_SHA[name];
    out.push(info ? { name, ...info } : { name, type: '中性', text: '此煞象可参考' });
  }
  return out;
}

export function summarizeShen(pillars) {
  const all = [];
  for (const p of pillars) for (const s of p.shen ?? []) all.push({ ...interpretShen([s])[0], pillar: p.label });
  const good = all.filter((s) => s.type === '吉');
  const bad = all.filter((s) => s.type === '凶');
  return { all, good, bad, goodCount: good.length, badCount: bad.length };
}

// ────────────────────────────────────────────────────────────
// 六、岁运评分与解读
// ────────────────────────────────────────────────────────────

/** 关系去重：同一干支对同时出现「冲」与「双冲」时，只保留信息量更大的那条。 */
function dedupeRelations(relations = []) {
  const byDesc = new Map();
  for (const r of relations) {
    const key = r.描述 ?? r.description ?? '';
    const cur = byDesc.get(key);
    if (!cur) { byDesc.set(key, r); continue; }
    // 双冲 > 冲；三合 > 半合
    const rank = (x) => (x.关系 ?? x.relation ?? '').includes('双冲') ? 3
      : (x.关系 ?? x.relation ?? '').includes('三合') ? 2 : 1;
    if (rank(r) > rank(cur)) byDesc.set(key, r);
  }
  return [...byDesc.values()];
}

function normalizeRelation(r) {
  const type = r.关系 ?? r.relation ?? '';
  const desc = r.描述 ?? r.description ?? '';
  const pillars = r.关联柱 ?? r.pillars ?? [];
  const key = Object.keys(RELATION_IMPACT).find((k) => type.includes(k))
    ?? (type.includes('尅') || type.includes('克') ? '尅' : null);
  return { type, desc, pillars, impact: key ? RELATION_IMPACT[key] : null, key };
}

export function scorePeriod(period, opts) {
  const { godScore, shenWeight = 0.7 } = opts;
  const stemGod = period.十神?.天干十神 ?? period.stemGod;
  const branchGods = period.十神?.地支十神 ?? period.branchGods ?? [];

  let score = 0;
  if (stemGod && godScore[stemGod] !== undefined) score += godScore[stemGod];
  const branchAvg = branchGods.length
    ? branchGods.reduce((a, g) => a + (godScore[g] ?? 0), 0) / branchGods.length
    : 0;
  score += branchAvg;

  const relations = dedupeRelations(period.刑冲合会 ?? period.relations ?? []).map(normalizeRelation);
  for (const r of relations) if (r.impact) score += r.impact.score;

  const shen = period.神煞 ?? period.shen ?? [];
  let shenScore = 0;
  for (const s of shen) {
    const info = SHEN_SHA[s];
    if (!info) continue;
    if (info.type === '吉') shenScore += shenWeight;
    else if (info.type === '凶') shenScore -= shenWeight;
  }
  score += Math.max(-1.5, Math.min(1.5, shenScore));

  return +score.toFixed(2);
}

export function verdictOf(score) {
  if (score >= 3.2) return { label: '上吉', cls: 'good', desc: '顺势而为的好窗口' };
  if (score >= 1.4) return { label: '吉', cls: 'good', desc: '整体向好，值得主动推进' };
  if (score >= -0.6) return { label: '平', cls: 'mid', desc: '平稳过渡，宜守宜蓄' };
  if (score >= -2.4) return { label: '需防', cls: 'warn', desc: '阻力明显，以稳为主' };
  return { label: '大防', cls: 'warn', desc: '冲撞较重，宜守不宜攻' };
}

const GOD_PERIOD_TEXT = {
  正财: { 喜: '正财主稳定收入与实业积累，适合把收入结构做扎实、把事落地', 忌: '财星为忌，钱事上易有压力，不宜扩大开支或加杠杆' },
  偏财: { 喜: '偏财是机会性进账，额外收入与投资机会活跃', 忌: '偏财为忌，机会多但难落袋，防冲动投入' },
  正官: { 喜: '正官主名分与责任，职位、资质、正式身份上有推进机会', 忌: '官星为忌，束缚感与规则压力上升，易被流程拖住' },
  七杀: { 喜: '七杀是压力也是权柄，能扛住就是突破', 忌: '七杀无制，外部施压强、节奏被别人定，需防过劳与硬碰' },
  食神: { 喜: '食神主输出与创作，靠作品和专业表达换资源是顺路', 忌: '食神为忌，产出转化效率偏低，别在细节上耗太久' },
  伤官: { 喜: '伤官主突破与锋芒，有才也能露，适合主动争取', 忌: '伤官见官，与规则、上级、制度的摩擦上升，表达要留分寸' },
  正印: { 喜: '正印主滋养与庇护，利于学习、考证、买房、得长辈助力', 忌: '印星为忌，易陷依赖与空想，行动力打折' },
  偏印: { 喜: '偏印主冷门与钻研，适合深挖专业壁垒', 忌: '偏印为忌，思虑过度、计划多变，防钻牛角尖' },
  比肩: { 喜: '比肩主并肩与协作，团队助力与人脉机会上升', 忌: '比肩夺财，竞争与分利者增多，成果归属要说清楚' },
  劫财: { 喜: '劫财主行动与开拓，敢打敢冲的阶段', 忌: '劫财夺财，破耗与分利概率高，合伙与借钱务必留痕' },
};

function godText(god, godScore) {
  const entry = GOD_PERIOD_TEXT[god];
  if (!entry) return null;
  const favorable = (godScore[god] ?? 0) > 0;
  return { god, favorable, text: favorable ? entry.喜 : entry.忌 };
}

/** 生成一段时期的解读要点 */
function buildPeriodPoints(period, godScore, opts = {}) {
  const points = [];
  const stemGod = period.十神?.天干十神;
  const branchGods = period.十神?.地支十神 ?? [];

  const stemT = godText(stemGod, godScore);
  if (stemT) points.push({ type: stemT.favorable ? '机会' : '风险', text: `天干${stemGod}：${stemT.text}` });

  for (const g of new Set(branchGods)) {
    const t = godText(g, godScore);
    if (t) points.push({ type: t.favorable ? '机会' : '风险', text: `地支${g}：${t.text}` });
  }

  const relations = dedupeRelations(period.刑冲合会 ?? []).map(normalizeRelation);
  const major = relations.filter((r) => r.impact && Math.abs(r.impact.score) >= 1.5);
  for (const r of major.slice(0, 3)) {
    const where = r.pillars.join('·');
    points.push({
      type: r.impact.score > 0 ? '机会' : '风险',
      text: `${r.type}（${where}）${r.desc}${r.desc ? '：' : ''}${r.impact.desc}`,
    });
  }

  // 神煞提醒：吉取一条、凶取一条，避免堆砌
  const shen = period.神煞 ?? [];
  const goodShen = shen.map((s) => SHEN_SHA[s]).filter((s) => s?.type === '吉');
  const badShen = shen.map((s) => SHEN_SHA[s]).filter((s) => s?.type === '凶');
  if (goodShen.length) points.push({ type: '机会', text: `吉神：${goodShen.slice(0, 2).map((s) => s.text).join('；')}` });
  if (badShen.length) points.push({ type: '建议', text: `留意：${badShen.slice(0, 2).map((s) => s.text).join('；')}` });

  return points.slice(0, opts.max ?? 5);
}

// ────────────────────────────────────────────────────────────
// 七、大运
// ────────────────────────────────────────────────────────────

export function interpretDayun(dayunList, godScore, currentYear) {
  return dayunList.map((d) => {
    const stemGod = d.天干十神;
    const branchGods = d.地支十神 ?? [];
    const score = scorePeriod(
      { 十神: { 天干十神: stemGod, 地支十神: branchGods }, 刑冲合会: [], 神煞: [] },
      { godScore }
    );
    const stemT = godText(stemGod, godScore);
    const isCurrent = currentYear >= d.开始年份 && currentYear <= d.结束;

    return {
      ganzhi: d.干支,
      startYear: d.开始年份,
      endYear: d.结束,
      startAge: d.开始年龄,
      endAge: d.结束年龄,
      stemGod,
      branchGods,
      hidden: d.地支藏干 ?? [],
      score,
      verdict: verdictOf(score),
      isCurrent,
      headline: stemT
        ? `${stemGod}${(godScore[stemGod] ?? 0) > 0 ? '为喜' : '为忌'}，${stemT.text}`
        : `${stemGod}运`,
      detail: [
        `天干${stemGod}主前半段（约前五年）：${stemT?.text ?? '—'}`,
        `地支${branchGods.join('·')}主后半段：${branchGods.map((g) => godText(g, godScore)?.text ?? '').filter(Boolean).join('；') || '—'}`,
      ],
    };
  });
}

// ────────────────────────────────────────────────────────────
// 八、流年 / 流月
// ────────────────────────────────────────────────────────────

export function interpretLiunian(years, godScore) {
  return years.map((y) => {
    const score = scorePeriod(
      { 十神: y.流年十神, 刑冲合会: y.流年刑冲合会, 神煞: y.流年神煞 },
      { godScore }
    );
    const stemGod = y.流年十神?.天干十神;
    const branchGods = y.流年十神?.地支十神 ?? [];
    const v = verdictOf(score);

    return {
      year: y.年份,
      ganzhi: y.流年干支,
      stemGod,
      branchGods,
      score,
      verdict: v,
      isCurrent: false,
      nayin: y.流年扩展?.纳音,
      starFortune: y.流年扩展?.星运,
      kongWang: y.流年扩展?.空亡,
      relations: dedupeRelations(y.流年刑冲合会).map(normalizeRelation),
      shen: interpretShen(y.流年神煞),
      dayun: y.当前大运?.干支,
      headline: `${stemGod}坐${branchGods.join('·')}——${v.label}，${v.desc}`,
      points: buildPeriodPoints({ 十神: y.流年十神, 刑冲合会: y.流年刑冲合会, 神煞: y.流年神煞 }, godScore),
    };
  });
}

export function interpretLiuyue(months, godScore) {
  return months.map((m) => {
    const score = scorePeriod(
      { 十神: m.流月十神, 刑冲合会: m.流月刑冲合会, 神煞: m.流月神煞 },
      { godScore }
    );
    const stemGod = m.流月十神?.天干十神;
    const branchGods = m.流月十神?.地支十神 ?? [];
    const v = verdictOf(score);
    const stemT = godText(stemGod, godScore);

    return {
      ganzhi: m.流月干支,
      start: m.开始日期,
      end: m.结束日期,
      liunian: m.流年干支,
      stemGod,
      branchGods,
      score,
      verdict: v,
      shen: interpretShen(m.流月神煞),
      relations: dedupeRelations(m.流月刑冲合会).map(normalizeRelation),
      headline: stemT ? `${stemGod}：${stemT.text}` : `${stemGod}月`,
      points: buildPeriodPoints({ 十神: m.流月十神, 刑冲合会: m.流月刑冲合会, 神煞: m.流月神煞 }, godScore, { max: 3 }),
    };
  });
}

// ────────────────────────────────────────────────────────────
// 九、分领域
// ────────────────────────────────────────────────────────────

export function buildDomains(ctx) {
  const { pillars, strength, usefulGod, wuxing, currentDayun, currentYear, gender, pattern, shenSummary } = ctx;
  const godScore = usefulGod.godScore;
  const favor = (g) => (godScore[g] ?? 0) > 0;

  const domains = [];

  // 事业：看官杀、印、食伤
  {
    const careerGods = ['正官', '七杀', '正印', '偏印', '食神', '伤官'];
    const present = pillars.filter((p) => p.god && careerGods.includes(p.god));
    const hasOfficer = pillars.some((p) => p.god === '正官' || p.god === '七杀');
    const hasOutput = pillars.some((p) => p.god === '食神' || p.god === '伤官');
    const hasSeal = pillars.some((p) => p.god === '正印' || p.god === '偏印');

    let main = '';
    if (hasOutput) main = '靠专业输出与作品立身';
    else if (hasOfficer) main = '适合在规则清晰的体系内发展，重视名分与职级';
    else if (hasSeal) main = '靠学历、资质与专业背书取胜';
    else main = '以资源整合与机会捕捉见长';

    domains.push({
      key: 'career',
      name: '事业',
      icon: '◈',
      summary: `${main}。当前${currentDayun?.ganzhi ?? ''}大运${currentDayun?.stemGod ?? ''}当令，${currentDayun?.headline ?? ''}` ,
      points: [
        present.length
          ? `命局透出：${present.map((p) => `${p.label}柱${p.god}`).join('、')}`
          : '命局事业星未透干，需借岁运引发',
        strength.isStrong
          ? '身旺能扛事，适合独立负责与攻坚，但需防大包大揽导致过劳'
          : '身弱宜借势，找对平台与团队比单打独斗更划算',
        hasOfficer && hasOutput
          ? '官星与食伤同见，才华与规则会有拉扯，用「分场景」处理：工作讲流程，创作讲自由'
          : null,
      ].filter(Boolean),
    });
  }

  // 财运
  {
    const wealthPillars = pillars.filter((p) => p.god === '正财' || p.god === '偏财');
    const hasRobber = pillars.some((p) => p.god === '比肩' || p.god === '劫财');
    const wealthEl = Object.keys(GAN_WUXING).find((k) => GAN_WUXING[k] === Object.keys(KE).find((x) => KE[strength.dayMasterElement] === undefined) ) ;
    const wealthElement = Object.entries(KE).find(([, v]) => v === undefined);
    // 日主所克之五行即为财
    const target = WUXING.find((el) => KE[strength.dayMasterElement] === el);
    const wealthStrength = wuxing.percent[target] ?? 0;

    domains.push({
      key: 'wealth',
      name: '财运',
      icon: '◈',
      summary: wealthPillars.length
        ? `命局财星透于${wealthPillars.map((p) => p.label).join('、')}柱，财星${wealthStrength >= 18 ? '有根' : '偏弱'}（${wealthStrength}%）`
        : '命局财星未透干，财运需靠岁运引发',
      points: [
        wealthPillars.some((p) => p.god === '偏财')
          ? '偏财透干：机会性、项目性收入是主要来源，来得快也去得快，别当稳定现金流规划'
          : null,
        wealthPillars.some((p) => p.god === '正财')
          ? '正财透干：稳定收入与实业积累是基本盘，适合长期配置'
          : null,
        hasRobber
          ? '命带比劫，合作与分利是常态：合伙要写清楚，成果要可归属，忌口头约定'
          : null,
        !strength.isStrong && wealthStrength > 20
          ? '财旺身弱，需先补自身能力再谈扩张，否则财多反成负担'
          : null,
      ].filter(Boolean),
    });
  }

  // 感情
  {
    const spouseGod = gender === 1 ? ['正财', '偏财'] : ['正官', '七杀'];
    const spousePillars = pillars.filter((p) => spouseGod.includes(p.god));
    const dayBranch = pillars[2].branch;
    const hasYinCha = pillars[2].shen?.includes('阴差阳错');
    const chongDay = pillars[3] && ['辰', '戌'].includes(pillars[2].branch) && ['辰', '戌'].includes(pillars[3].branch);

    domains.push({
      key: 'love',
      name: '感情',
      icon: '◈',
      summary: spousePillars.length
        ? `${gender === 1 ? '财星（妻缘）' : '官杀（夫缘）'}透于${spousePillars.map((p) => p.label).join('、')}柱，感情线索清晰`
        : `${gender === 1 ? '财星' : '官杀'}未透干，感情多靠岁运引动`,
      points: [
        spousePillars.length
          ? `感情星为${spousePillars.map((p) => p.god).join('、')}，${favor(spousePillars[0].god) ? '为喜用，感情是加分项' : '为忌，感情易带来牵绊与消耗'}`
          : '感情星不显，缘分节奏偏慢，急不来',
        hasYinCha ? '日坐阴差阳错：容易「时机不对」，不是人不合适，是节奏常差半拍。冲突期别做关系判断' : null,
        chongDay ? '日时支相冲：内心不安定、生活节奏易被打断，亲密关系需要刻意经营' : null,
        shenSummary.all.some((s) => s.name === '桃花' || s.name === '红艳')
          ? '命带桃花/红艳：个人吸引力强，异性缘好，也需留意分寸'
          : null,
      ].filter(Boolean),
    });
  }

  // 健康：五行过旺与过弱对应脏腑
  {
    const strongEl = wuxing.strongest;
    const weakEl = wuxing.weakest;
    const missing = wuxing.missing;
    domains.push({
      key: 'health',
      name: '健康',
      icon: '◈',
      summary: `${strongEl}气最旺（${wuxing.percent[strongEl]}%），${weakEl}气最弱（${wuxing.percent[weakEl]}%）`,
      points: [
        `${strongEl}过旺，需留意${WUXING_ORGAN[strongEl]}的负担`,
        `${weakEl}偏弱，${WUXING_ORGAN[weakEl]}是先天薄弱环节`,
        missing.length ? `五行缺${missing.join('、')}，对应系统日常需多关注` : null,
        '命理只提示倾向，不作医学判断；有不适请咨询专业医生并定期检查',
      ].filter(Boolean),
    });
  }

  // 人际
  {
    const robber = pillars.filter((p) => p.god === '比肩' || p.god === '劫财');
    const chongPairs = [];
    for (const p of pillars) {
      for (const q of pillars) {
        if (p.label >= q.label) continue;
        const a = p.branch, b = q.branch;
        const map = { 子: '午', 丑: '未', 寅: '申', 卯: '酉', 辰: '戌', 巳: '亥' };
        if (map[a] === b) chongPairs.push(`${p.label}${a}冲${q.label}${b}`);
      }
    }
    domains.push({
      key: 'social',
      name: '人际与决策',
      icon: '◈',
      summary: robber.length
        ? `命带${robber.map((p) => p.god).join('、')}，同辈互动是人生主旋律之一`
        : '命局比劫不显，独立性较强',
      points: [
        robber.length
          ? '比劫透干：敢说有主见，但「赢了道理输了局面」是常见坑，注意场合与分寸'
          : '缺少比劫：独立但易孤立，需主动经营协作网络',
        chongPairs.length ? `命局有${chongPairs.join('、')}：内在张力明显，变动与走动的概率高于常人` : null,
        shenSummary.goodCount >= 3
          ? `命带${shenSummary.good.slice(0, 3).map((s) => s.name).join('、')}等吉神，贵人缘是重要资产`
          : null,
        shenSummary.badCount >= 2 ? `需注意${shenSummary.bad.slice(0, 2).map((s) => s.name).join('、')}带来的消耗` : null,
      ].filter(Boolean),
    });
  }

  return domains;
}

// ────────────────────────────────────────────────────────────
// 十、主入口
// ────────────────────────────────────────────────────────────

export function interpret(chart, fortune, options = {}) {
  const pillars = options.pillars ?? chart.pillarsData;
  const dayMaster = chart.dayMaster;
  const gender = chart.input.gender;
  const currentYear = options.currentYear ?? new Date().getFullYear();

  const wuxing = analyzeWuxing(pillars);
  const strength = analyzeStrength(pillars, dayMaster);
  const pattern = determinePattern(pillars);
  const usefulGod = determineUsefulGod(strength, dayMaster);
  const shenSummary = summarizeShen(pillars);
  const godScore = usefulGod.godScore;

  const dayun = interpretDayun(fortune.natal.大运 ?? [], godScore, currentYear);
  const currentDayun = dayun.find((d) => d.isCurrent) ?? dayun[0];

  const liunian = interpretLiunian(fortune.result.years ?? [], godScore);
  for (const y of liunian) y.isCurrent = y.year === currentYear;
  const currentLiunian = liunian.find((y) => y.isCurrent) ?? liunian[0];

  // 流月只取当前时间之后的 6 段，避免信息过载
  const allMonths = interpretLiuyue(fortune.result.months ?? [], godScore);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const upcoming = allMonths.filter((m) => m.end >= today).slice(0, 6);

  const domains = buildDomains({
    pillars, strength, usefulGod, wuxing, currentDayun, currentYear, gender, pattern, shenSummary,
  });

  return {
    wuxing, strength, pattern, usefulGod, shenSummary,
    dayun, currentDayun,
    liunian, currentLiunian,
    months: upcoming,
    allMonths,
    domains,
  };
}
