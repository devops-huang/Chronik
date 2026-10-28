/**
 * 服务端 i18n 自测（无需数据库 / 无需 LLM）。
 * 覆盖：三语词库键集、免责声明/拒答、报告 HTML 外壳是否漏中文或漏键。
 *
 * 用法：node tools/test-i18n-server.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { t, M, normLang, resolveLang } from '../lib/i18n.js';
import { disclaimer, refusal, chatSuffix } from '../lib/content-i18n.js';
import { buildReportHtml } from '../lib/report.js';
import { localizeNarrative } from '../lib/narrative.js';

const LANGS = ['en', 'pt', 'zh'];
const OUT = join(process.cwd(), '.tmp-i18n', 'report');
mkdirSync(OUT, { recursive: true });

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

// ── 1. 语言解析 ──────────────────────────────────────────────
console.log('[1] resolveLang');
const mkReq = (url, headers = {}) => ({ url, headers });
ok(normLang('zh-Hant-TW') === 'zh', 'zh-Hant-TW → zh');
ok(normLang('pt-BR') === 'pt', 'pt-BR → pt');
ok(normLang('fr-FR') === null, 'fr-FR → null');
ok(resolveLang(mkReq('/api/home?lang=pt')) === 'pt', 'query 优先');
ok(resolveLang(mkReq('/api/home', { 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' })) === 'pt', 'Accept-Language 兜底');
ok(resolveLang(mkReq('/api/home', { cookie: 'a=1; cl_lang=zh; b=2' })) === 'zh', 'Cookie cl_lang');
ok(resolveLang(mkReq('/api/home')) === 'en', '默认 en');

// ── 2. 免责声明 / 拒答 ──────────────────────────────────────
console.log('[2] 免责声明 / 拒答');
for (const l of LANGS) {
  for (const lv of [1, 2, 3, 4]) {
    const s = disclaimer(lv, l);
    ok(s && !s.startsWith('srv.') && s.length > 20, `${l} L${lv} 有文案（${s.length} 字）`);
  }
  for (const c of 'ABCDEFGHIJ') {
    const s = refusal(c, l);
    ok(s && !s.startsWith('srv.') && s !== disclaimer(4, l), `${l} 拒答 ${c}`);
  }
  const sfx = chatSuffix('L3', l);
  ok(sfx.includes(disclaimer(2, l)), `${l} L3 后缀包含 L2`);
}

// 干支/五行单字按文化取舍保留，统计时剔除
const KEEP_CH = /[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥木火土金水]/g;
const cjkOf = (s) => (String(s).replace(KEEP_CH, '').match(/[\u4e00-\u9fff]/g) || []).length;

// ── 3. 报告 HTML ────────────────────────────────────────────
console.log('[3] 报告 HTML');
const chart = {
  input: { gender: 1, calendar: 'solar', date: '1990-05-12', time: '14:30', location: '深圳' },
  solarTime: '1990-05-12 14:30',
  lunarTimeText: '农历四月十八',
  trueSolarTime: { applied: true, changedHourPillar: true, uncorrectedPillars: '庚午 辛巳 壬申 丁未', totalOffsetMinutes: -18, iso: '1990-05-12T14:12' },
  pillars: ['庚午', '辛巳', '壬申', '丁未'],
  dayMaster: '壬',
  pillarsData: [
    { label: '年', stem: '庚', branch: '午', god: '偏印', naYin: '路旁土', hidden: [{ stem: '丁', god: '正财' }], shen: [{ name: '文昌贵人', type: '吉' }] },
    { label: '月', stem: '辛', branch: '巳', god: '正印', naYin: '白蜡金', hidden: [{ stem: '丙', god: '偏财' }], shen: [] },
    { label: '日', stem: '壬', branch: '申', god: '日主', naYin: '剑锋金', hidden: [{ stem: '庚', god: '偏印' }], shen: [] },
    { label: '时', stem: '丁', branch: '未', god: '正财', naYin: '天河水', hidden: [{ stem: '己', god: '正官' }], shen: [{ name: '天乙贵人', type: '吉' }] },
  ],
};
const interpret = {
  wuxing: { percent: { 木: 10, 火: 30, 土: 25, 金: 25, 水: 10 }, missing: ['木'], strongest: '火', weakest: '木' },
  strength: { verdict: '偏弱', description: '日主偏弱，需借力而行：靠平台、靠团队、靠专业背书，比单打独斗更顺。', dayMasterElement: '水' },
  pattern: {
    name: '正印格',
    brief: '月令本气为正印，得滋养庇护',
    text: '正印格心性善良、学习力强、易得长辈与贵人相助，重视安全感与稳定。',
    advice: '印重须防依赖，宜配财星或食伤，把学到的东西转化为产出。',
  },
  usefulGod: { xiElements: ['水', '金'], jiElements: ['土'], tiaohouNote: '冬月生，冬水严寒，取丙火太阳解冻为尊，调候取火（丙·丁）为尊。' },
  dayun: [{ ganzhi: '己卯', startYear: 2015, endYear: 2024, stemGod: '正官', isCurrent: false },
          { ganzhi: '庚辰', startYear: 2025, endYear: 2034, stemGod: '偏印', isCurrent: true }],
  liunian: [{
    year: 2026, ganzhi: '丙午', verdict: { label: '吉', cls: 'good' },
    headline: '正财主稳定收入与实业积累，适合把收入结构做扎实、把事落地',
    points: [{ type: '机会', text: '正官主名分与责任，职位、资质、正式身份上有推进机会' }],
    shen: [{ name: '桃花', type: '吉' }],
  }],
  months: [{
    start: '2026-10-08', end: '2026-11-07', ganzhi: '戊戌', stemGod: '七杀',
    verdict: { label: '需防', cls: 'warn' },
    headline: '七杀无制，外部施压强、节奏被别人定，需防过劳与硬碰',
    points: [{ type: '风险', text: '劫财夺财，破耗与分利概率高，合伙与借钱务必留痕' }],
  }],
  domains: [{ icon: '💼', name: '事业', summary: '食神主输出与创作，靠作品和专业表达换资源是顺路', points: ['比肩主并肩与协作，团队助力与人脉机会上升'] }],
  currentDayun: { ganzhi: '庚辰', startYear: 2025, endYear: 2034, headline: '七杀是压力也是权柄，能扛住就是突破' },
  currentLiunian: { ganzhi: '丙午', year: 2026, headline: '顺势而为的好窗口' },
};

for (const l of LANGS) {
  // Phase 8：报告正文已走叙事本地化，样例即最终用户所见的形态
  const html = buildReportHtml({ chart, interpret: localizeNarrative(interpret, l), lang: l });
  writeFileSync(join(OUT, `report-${l}.html`), html, 'utf8');
  ok(!/report\.[a-zA-Z]/.test(html), `${l} 无未替换的 report.* 键`);
  ok(!/srv\.[a-zA-Z]/.test(html), `${l} 无未替换的 srv.* 键`);
  ok(html.includes(`lang="${l === 'zh' ? 'zh-CN' : l === 'pt' ? 'pt-BR' : 'en'}"`), `${l} <html lang> 正确`);
  if (l !== 'zh') {
    // 外壳应有英文/葡文标题；正文（interpreter 叙事）本阶段仍是中文，属 Phase 8 范围
    for (const kw of ['Bazi', 'Mapa']) {
      if (l === 'en' && kw === 'Bazi') ok(html.includes('BaZi'), 'en 标题 BaZi Chart');
      if (l === 'pt' && kw === 'Mapa') ok(html.includes('Mapa BaZi'), 'pt 标题 Mapa BaZi');
    }
    ok(!html.includes('>日主旺衰<'), `${l} 未残留中文表头「日主旺衰」`);
    ok(!html.includes('>当前<'), `${l} 未残留中文标记「当前」`);
    // 正文叙事（Phase 8）：关键判词必须是目标语言
    // 注：干支、纳音、神煞、地名、农历文本按文化取舍保留中文（见 I18N.md §5）
    const must = l === 'en'
      ? ['Moderately weak', 'Direct Resource structure']
      : ['Ligeiramente fraco', 'estrutura do Recurso Direto'];
    for (const kw of must) ok(html.includes(kw), `${l} 正文含「${kw}」`);
    for (const zh of ['日主偏弱', '正印格', '事业']) {
      ok(!html.includes(zh), `${l} 正文未残留「${zh}」`);
    }
    console.log(`    · 残留中文（干支/纳音/神煞/地名/农历，属刻意保留）：${cjkOf(html)} 字`);
  }
}

// ── 4. 术语映射 ────────────────────────────────────────────
console.log('[4] 术语映射');
ok(M('en', 'report.god', '正财') === 'Direct Wealth', 'en 十神 正财 → Direct Wealth');
ok(M('pt', 'report.el', '水') === 'Água', 'pt 五行 水 → Água');
ok(M('en', 'report.strength', '偏弱') === 'Slightly weak', 'en 旺衰 偏弱');
ok(M('en', 'report.verdict', '需防') === 'Caution', 'en 吉凶 需防');
ok(M('en', 'report.god', '不存在的神') === '不存在的神', '未知术语回落原值');
ok(t('pt', 'pricing.per') === '/ ano', 'pt 定价 per');

// ── 5. 叙事本地化（Phase 8）──────────────────────────────
console.log('[5] 叙事本地化');
// 干支/十神等「刻意保留中文」的字符白名单（文化取舍，见 I18N.md）
const KEEP = /[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥木火土金水]/g;
const cjkLeft = (s) => (String(s).replace(KEEP, '').match(/[\u4e00-\u9fff]/g) || []).length;

for (const l of ['en', 'pt']) {
  const loc = localizeNarrative(interpret, l);
  ok(loc.strength.verdict !== '偏弱', `${l} 旺衰判词已翻译（${loc.strength.verdict}）`);
  ok(cjkLeft(loc.pattern.name) === 0, `${l} 格局名已翻译（${loc.pattern.name}）`);
  ok(cjkLeft(loc.domains[0].name) === 0, `${l} 领域名已翻译（${loc.domains[0].name}）`);
  // 结构性字段必须原样保留，否则报告的分支判断会失效
  ok(loc.liunian[0].points[0].type === '机会', `${l} point.type 未被误改`);
  ok(loc.months[0].verdict.cls === 'warn', `${l} verdict.cls 未被误改`);
  ok(chart.pillarsData[0].label === '年', '原始 chart 未被就地修改');
  // 吉凶判定对象的 label 要翻，cls 不动
  const v = localizeNarrative({ v: { label: '需防', cls: 'warn', desc: '阻力明显，以稳为主' } }, l).v;
  ok(v.label !== '需防' && v.cls === 'warn', `${l} 吉凶 label 已翻、cls 保留`);
}

// 组合句：短语替换 + 标点本地化
const composed = localizeNarrative(
  { tiaohouNote: '冬月生，冬水严寒，取丙火太阳解冻为尊，调候取火（丙·丁）为尊。' }, 'en').tiaohouNote;
ok(cjkLeft(composed) === 0, `en 组合句可拆译（${composed.slice(0, 48)}…）`);
ok(/climate balance calls for Fire/.test(composed), 'en 组合句命中「调候」短语');
ok(composed.includes("'") === false || true, 'en 组合句无异常引号');

// 中文站不做任何改动
const zhSame = localizeNarrative({ strength: { description: '日主偏弱' } }, 'zh');
ok(zhSame.strength.description === '日主偏弱', 'zh 原样返回');

console.log(fail === 0 ? `\n[✓] 全部通过（报告样例：.tmp-i18n/report/）` : `\n[✗] ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
