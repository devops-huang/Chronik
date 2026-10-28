/**
 * 子平八字 · 黑金风格 HTML 报告生成器。
 *
 * 输入是 buildChart / queryFortune / interpret 三者的产物，输出一段自包含
 * （内联样式 + 少量原生 JS）的 HTML 文档，可直接落盘、打印、或注入前端容器。
 * 设计语言遵循角色规范：黑底金边、四柱表、五行五色谱、大运时间轴、流年 Tab、
 * 流月 Timeline、分领域卡、三句话总结、浅红虚线免责框。
 */

import { DISCLAIMER_L2 } from './content-policy.js';
import { t, M, htmlLang } from './i18n.js';

const CSS = `
:root{
  --bg:#0e0b08; --panel:#16110b; --panel2:#1d160e; --line:#3a2d1c;
  --gold:#d4af6e; --gold-bright:#f3d99c; --ink:#ece4d3; --ink-dim:#b7a981;
  --red:#c44a3c; --green:#6b9a5c; --warn:#d8a24a;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);
  font-family:"Songti SC","STSong","PingFang SC","Hiragino Sans GB",serif;
  line-height:1.7;-webkit-font-smoothing:antialiased}
.report{max-width:920px;margin:0 auto;padding:28px 22px 60px}
header.top{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:22px}
.title-cn{font-size:26px;letter-spacing:6px;color:var(--gold-bright);font-weight:700}
.title-en{font-size:12px;letter-spacing:3px;color:var(--ink-dim);text-transform:uppercase;margin-top:4px}
.meta{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13px;color:var(--ink-dim)}
.meta b{color:var(--gold);font-weight:600}
.note-box{margin-top:12px;font-size:12.5px;color:var(--warn);
  background:rgba(216,162,74,.08);border:1px dashed var(--warn);border-radius:8px;padding:9px 12px}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));
  border:1px solid var(--line);border-radius:12px;padding:18px 18px 16px;margin-bottom:18px}
.card-h{display:flex;align-items:center;gap:10px;margin:0 0 14px}
.card-h .en{font-size:11px;letter-spacing:2px;color:var(--ink-dim);text-transform:uppercase}
.card-h h2{font-size:17px;margin:0;color:var(--gold-bright);letter-spacing:2px;font-weight:600}
.card-h::before{content:"";width:4px;height:18px;background:var(--gold);border-radius:2px;display:inline-block}

/* 四柱表 */
.pillars{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.pillar{background:#120d08;border:1px solid var(--line);border-radius:10px;padding:12px 8px;text-align:center}
.pillar .pl{font-size:11px;color:var(--ink-dim);letter-spacing:2px}
.pillar .gz{font-size:30px;letter-spacing:2px;margin:6px 0 2px;color:var(--gold-bright);font-weight:700}
.pillar .gz .g{color:var(--red)} .pillar .gz .z{color:var(--green)}
.pillar .god{font-size:13px;color:var(--gold)}
.pillar .sub{font-size:11.5px;color:var(--ink-dim);margin-top:4px}
.pillar .ny{font-size:11px;color:#8d7e5d;margin-top:3px}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:20px;
  border:1px solid var(--line);color:var(--ink-dim);margin:2px 3px 0}
.badge.good{color:var(--green);border-color:#2f4a2a}
.badge.bad{color:var(--red);border-color:#4a2823}

/* 五行 */
.wx{display:flex;flex-direction:column;gap:9px;margin-top:4px}
.wx-row{display:grid;grid-template-columns:42px 1fr 52px;align-items:center;gap:10px}
.wx-name{color:var(--ink);font-size:14px}
.wx-bar{height:16px;background:#120d08;border-radius:8px;overflow:hidden;border:1px solid var(--line)}
.wx-fill{height:100%;border-radius:8px}
.wx-pct{text-align:right;color:var(--gold);font-size:13px}
.wx-legend{font-size:12px;color:var(--ink-dim);margin-top:8px}

/* 格局用神 */
.kv{display:grid;grid-template-columns:96px 1fr;gap:8px 14px;font-size:14px}
.kv .k{color:var(--ink-dim)}
.kv .v{color:var(--ink)}
.tag{display:inline-block;font-size:12.5px;padding:2px 10px;border-radius:20px;
  border:1px solid var(--gold);color:var(--gold-bright);margin:0 6px 6px 0}
.tag.xi{background:rgba(107,154,92,.12);border-color:var(--green);color:var(--green)}
.tag.ji{background:rgba(196,74,60,.12);border-color:var(--red);color:#e08a7e}

/* 大运时间轴 */
.timeline{display:flex;overflow-x:auto;gap:8px;padding-bottom:8px}
.dy{min-width:78px;flex:0 0 auto;border:1px solid var(--line);border-radius:9px;
  padding:10px 8px;text-align:center;background:#120d08}
.dy.cur{border-color:var(--gold);background:rgba(212,175,110,.1);box-shadow:0 0 0 1px var(--gold) inset}
.dy .gz{font-size:17px;color:var(--gold-bright);font-weight:700}
.dy .yrs{font-size:11px;color:var(--ink-dim);margin-top:3px}
.dy .gd{font-size:12px;color:var(--gold);margin-top:3px}
.dy.cur .mark{font-size:10px;color:#0e0b08;background:var(--gold);border-radius:10px;padding:0 6px;display:inline-block;margin-top:4px}

/* 流年 Tab */
.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.tab{cursor:pointer;font-size:13px;padding:6px 14px;border-radius:20px;
  border:1px solid var(--line);color:var(--ink-dim);background:#120d08}
.tab.active{color:#0e0b08;background:var(--gold);border-color:var(--gold);font-weight:600}
.tab .yr{opacity:.7;font-size:11px;margin-left:4px}
.panel{display:none} .panel.active{display:block}
.ln-head{font-size:15px;color:var(--gold-bright);margin-bottom:8px}
.verdict{display:inline-block;font-size:12px;padding:2px 10px;border-radius:20px;margin-left:8px;vertical-align:middle}
.verdict.good{background:rgba(107,154,92,.15);color:var(--green);border:1px solid var(--green)}
.verdict.mid{background:rgba(216,162,74,.15);color:var(--warn);border:1px solid var(--warn)}
.verdict.warn{background:rgba(196,74,60,.15);color:#e08a7e;border:1px solid var(--red)}
.pt{font-size:13.5px;color:var(--ink);margin:6px 0;padding-left:14px;position:relative}
.pt::before{content:"·";color:var(--gold);position:absolute;left:2px}
.pt.opp{color:var(--green)} .pt.risk{color:#e08a7e} .pt.sug{color:var(--warn)}

/* 流月 Timeline */
.months{display:flex;flex-direction:column;gap:10px}
.month{display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:start;
  border-left:3px solid var(--line);padding-left:14px}
.month .when{font-size:13px;color:var(--ink-dim)}
.month .gz{font-size:18px;color:var(--gold-bright);font-weight:700}
.month .gd{font-size:12px;color:var(--gold);margin-top:2px}
.month .body{font-size:13.5px;color:var(--ink)}
.month .head{font-size:13.5px;color:var(--ink)}

/* 分领域 */
.domains{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.domain{background:#120d08;border:1px solid var(--line);border-radius:10px;padding:14px}
.domain .dn{font-size:15px;color:var(--gold-bright);letter-spacing:1px;margin-bottom:6px}
.domain .dn .ic{color:var(--gold);margin-right:6px}
.domain .ds{font-size:13px;color:var(--ink);margin-bottom:8px}
.domain .dp{font-size:12.5px;color:var(--ink-dim);margin:4px 0;padding-left:12px;position:relative}
.domain .dp::before{content:"◦";color:var(--gold);position:absolute;left:0}

/* 三句话 */
.summary{background:linear-gradient(180deg,#1b1410,#221a10);border:1px solid var(--gold);
  border-radius:12px;padding:18px;margin-bottom:18px}
.summary .h{font-size:14px;color:var(--gold);letter-spacing:3px;margin-bottom:10px}
.summary .s{font-size:15px;color:var(--gold-bright);margin:8px 0;line-height:1.8}
.summary .s b{color:#fff}

.disclaimer{margin-top:8px;font-size:12px;color:#d99;line-height:1.7;
  border:1px dashed var(--red);border-radius:8px;padding:12px 14px;background:rgba(196,74,60,.06)}

.report-l2-top{margin-bottom:14px;font-size:12.5px;color:#d9b88a;line-height:1.7;
  background:#1a120a;border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.report-l2-bottom{margin-top:18px}
.ai-badge{display:inline-block;margin-top:6px;font-size:11px;letter-spacing:1px;color:var(--gold-bright);
  border:1px solid var(--line);border-radius:20px;padding:2px 10px}

@media(max-width:720px){
  .report{padding:18px 14px 50px}
  .pillars{grid-template-columns:repeat(2,1fr)}
  .domains{grid-template-columns:1fr}
  .month{grid-template-columns:1fr}
  .title-cn{font-size:22px}
  .kv{grid-template-columns:80px 1fr}
}
`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function godClass(g) { return g || ''; }

const WX_COLOR = { 木: '#6b9a5c', 火: '#c44a3c', 土: '#d4af6e', 金: '#cfd2d6', 水: '#5a8fc4' };

// 柱位中文标签 → 词库键（pillarsData 的 label 是「年/月/日/时」）
const PILLAR_KEY = { 年: 'year', 月: 'month', 日: 'day', 时: 'hour' };

export function buildReportHtml({ chart, fortune, interpret, lang = 'en' }) {
  const { input, solarTime, lunarTimeText, trueSolarTime, pillars, dayMaster, pillarsData } = chart;
  const I = interpret;

  // ── 本地化助手（未命中一律回落中文原文，绝不显示 key 名）──
  const T = (key, vars) => {
    const v = t(lang, key, vars);
    return v === key ? '' : v;
  };
  const G = (zhGod) => (zhGod ? M(lang, 'report.god', zhGod) : '');
  // 纳音与神煞：按词表映射；未收录则回落中文原文（文化标识，不做意译猜测）
  const NY = (zh) => (zh ? M(lang, 'report.nayin', zh) : '');
  const SN = (zh) => (zh ? M(lang, 'report.shen', zh) : '');
  const EL = (zhEl) => M(lang, 'report.el', zhEl);

  const genderCn = input.gender === 1
    ? T('report.meta.male') || '男'
    : T('report.meta.female') || '女';
  const calendarCn = input.calendar === 'lunar'
    ? T('report.meta.lunarCal') || '农历'
    : T('report.meta.solarCal') || '阳历';

  // 四柱表
  const pillarRows = pillarsData.map((p, i) => {
    const shenTags = (p.shen || []).slice(0, 4).map((s) => {
      const cls = s.type === '吉' ? 'good' : s.type === '凶' ? 'bad' : '';
      return `<span class="badge ${cls}">${esc(SN(s.name))}</span>`;
    }).join('');
    const hidden = (p.hidden || []).map((h) => `${esc(h.stem)}(${esc(G(h.god))})`).join(' ');
    const g = esc(p.stem), z = esc(p.branch);
    const plKey = PILLAR_KEY[p.label];
    const plText = (plKey && T('report.pillar.' + plKey)) || (p.label + '柱');
    const hiddenLabel = T('report.pillar.hidden') || '藏：';
    return `<div class="pillar">
      <div class="pl">${esc(plText)}</div>
      <div class="gz"><span class="g">${g}</span><span class="z">${z}</span></div>
      <div class="god">${esc(G(p.god) || '—')}</div>
      <div class="sub">${hidden ? hiddenLabel + hidden : '—'}</div>
      <div class="ny">${esc(NY(p.naYin || ''))}</div>
      <div>${shenTags}</div>
    </div>`;
  }).join('');

  // 五行
  const wxRows = Object.keys(I.wuxing.percent).map((el) => {
    const v = I.wuxing.percent[el];
    return `<div class="wx-row">
      <div class="wx-name">${esc(EL(el))}</div>
      <div class="wx-bar"><div class="wx-fill" style="width:${Math.max(4, v)}%;background:${WX_COLOR[el]}"></div></div>
      <div class="wx-pct">${v}%</div>
    </div>`;
  }).join('');
  const sep = lang === 'zh' ? '、' : ', ';
  const noneTxt = T('report.lbl.none') || '无';
  const missingTxt = I.wuxing.missing.length ? I.wuxing.missing.map(EL).join(sep) : noneTxt;

  // 格局用神
  const xiTpl = T('report.tag.xi', { el: '{el}' }) || '喜{el}';
  const jiTpl = T('report.tag.ji', { el: '{el}' }) || '忌{el}';
  const xiTags = I.usefulGod.xiElements.map((e) => `<span class="tag xi">${esc(xiTpl.split('{el}').join(EL(e)))}</span>`).join('');
  const jiTags = I.usefulGod.jiElements.map((e) => `<span class="tag ji">${esc(jiTpl.split('{el}').join(EL(e)))}</span>`).join('');
  const yongShen = `<div class="kv">
    <div class="k">${esc(T('report.kv.strength') || '日主旺衰')}</div><div class="v">${esc(M(lang, 'report.strength', I.strength.verdict))}（${esc(I.strength.description || '')}）</div>
    <div class="k">${esc(T('report.kv.pattern') || '格局')}</div><div class="v">${esc(I.pattern.name)} · ${esc(I.pattern.brief || '')}</div>
    <div class="k">${esc(T('report.kv.tiaohou') || '调候用神')}</div><div class="v">${esc(I.usefulGod.tiaohouNote || '—')}</div>
    <div class="k">${esc(T('report.kv.favor') || '喜用')}</div><div class="v">${xiTags || '—'}</div>
    <div class="k">${esc(T('report.kv.avoid') || '忌神')}</div><div class="v">${jiTags || '—'}</div>
  </div>`;

  // 大运时间轴
  const curMark = T('report.lbl.current') || '当前';
  const dyRow = I.dayun.map((d) => `<div class="dy ${d.isCurrent ? 'cur' : ''}">
    <div class="gz">${esc(d.ganzhi)}</div>
    <div class="yrs">${d.startYear}–${d.endYear}</div>
    <div class="gd">${esc(G(d.stemGod) || '')}</div>
    ${d.isCurrent ? `<div class="mark">${esc(curMark)}</div>` : ''}
  </div>`).join('');

  // 流年 Tab
  const yearTabs = I.liunian.map((y, i) => `<div class="tab ${i === 0 ? 'active' : ''}" data-i="${i}">
    ${esc(y.ganzhi)}<span class="yr">${y.year}</span></div>`).join('');
  const yearLineTpl = T('report.liunianLine', { year: '{year}', gz: '{gz}' }) || '{year} 流年 {gz}';
  const yearPanels = I.liunian.map((y, i) => {
    const pts = (y.points || []).map((p) => `<div class="pt ${p.type === '机会' ? 'opp' : p.type === '风险' ? 'risk' : 'sug'}">${esc(p.text)}</div>`).join('');
    const shen = (y.shen || []).slice(0, 3).map((s) => `<span class="badge ${s.type === '吉' ? 'good' : s.type === '凶' ? 'bad' : ''}">${esc(SN(s.name))}</span>`).join(' ');
    const line = yearLineTpl.split('{year}').join(String(y.year)).split('{gz}').join(y.ganzhi);
    return `<div class="panel ${i === 0 ? 'active' : ''}" data-i="${i}">
      <div class="ln-head">${esc(line)} <span class="verdict ${y.verdict.cls}">${esc(M(lang, 'report.verdict', y.verdict.label))}</span></div>
      <div class="pt">${esc(y.headline)}</div>
      ${pts}
      <div style="margin-top:8px">${shen}</div>
    </div>`;
  }).join('');

  // 流月 Timeline
  const monthRows = I.months.map((m) => `<div class="month">
    <div><div class="when">${esc(m.start)} ~ ${esc(m.end)}</div><div class="gz">${esc(m.ganzhi)}</div>
      <div class="gd">${esc(G(m.stemGod) || '')} <span class="verdict ${m.verdict.cls}" style="font-size:11px;padding:1px 7px">${esc(M(lang, 'report.verdict', m.verdict.label))}</span></div></div>
    <div class="body"><div class="head">${esc(m.headline)}</div>${(m.points || []).map((p) => `<div class="pt ${p.type === '机会' ? 'opp' : p.type === '风险' ? 'risk' : 'sug'}">${esc(p.text)}</div>`).join('')}</div>
  </div>`).join('');

  // 分领域
  const domainCards = I.domains.map((d) => `<div class="domain">
    <div class="dn"><span class="ic">${esc(d.icon || '◈')}</span>${esc(d.name)}</div>
    <div class="ds">${esc(d.summary)}</div>
    ${(d.points || []).map((p) => `<div class="dp">${esc(p)}</div>`).join('')}
  </div>`).join('');

  // 三句话总结
  const s1 = (T('report.summary.line1', {
    name: esc(I.pattern.name),
    verdict: esc(M(lang, 'report.strength', I.strength.verdict)),
    advice: esc(I.pattern.advice || ''),
  }) || `${esc(I.pattern.name)}，${esc(I.strength.verdict)}。${esc(I.pattern.advice || '')}`);
  const s2 = (T('report.summary.dayun', {
    gz: `<b>${esc(I.currentDayun?.ganzhi || '')}</b>`,
    from: I.currentDayun?.startYear,
    to: I.currentDayun?.endYear,
    headline: esc(I.currentDayun?.headline || ''),
  }) || `当前走 <b>${esc(I.currentDayun?.ganzhi || '')}</b> 大运（${esc(I.currentDayun?.startYear)}–${esc(I.currentDayun?.endYear)}）：${esc(I.currentDayun?.headline || '')}`);
  const s3 = (T('report.summary.liunian', {
    gz: I.currentLiunian?.ganzhi || '',
    headline: esc(I.currentLiunian?.headline || ''),
  }) || `<b>${esc(I.currentLiunian?.ganzhi || '')}</b> 流年：${esc(I.currentLiunian?.headline || '')}`);

  // 真太阳时提醒
  const tstNote = trueSolarTime.applied
    ? (trueSolarTime.changedHourPillar
        ? (T('report.tst.appliedChanged', {
            from: trueSolarTime.uncorrectedPillars.split(' ')[3],
            to: pillars[3],
          }) || `已按出生地经度做真太阳时校正，时柱由「${esc(trueSolarTime.uncorrectedPillars.split(' ')[3])}」修正为「${esc(pillars[3])}」。这一步直接改变十神结构，全盘定性随之调整。`)
        : (T('report.tst.appliedSame', { minutes: trueSolarTime.totalOffsetMinutes })
            || `已做真太阳时校正（偏移 ${trueSolarTime.totalOffsetMinutes} 分钟），时柱未跨时辰。`))
    : (T('report.tst.notApplied') || '未启用真太阳时校正，按输入时间直接排盘。');

  // 区块标题：主标题走目标语言，副标题保留中文原文（文化标识）
  const H = (k) => esc(T('report.sec.' + k + '.h') || k);
  // 副标题是「双语对照」：中文站配英文，英文/葡语站不再回显中文，
  // 否则英文用户看到的是未翻译的残留。文化标识由页头的中英双语标题承担。
  const S = (k) => (lang === 'zh' ? esc(T('report.sec.' + k + '.s') || '') : '');
  const secHead = (k) => `<div class="card-h"><h2>${H(k)}</h2>${S(k) ? `<span class="en">${S(k)}</span>` : ''}</div>`;
  const metaLbl = (k, fb) => esc(T('report.meta.' + k) || fb);
  const l2 = (lang === 'zh' ? DISCLAIMER_L2 : (T('srv.disclaimer.L2') || DISCLAIMER_L2));

  const docTitle = T('report.docTitle', { pillars: pillars.join('') }) || `八字命盘 · ${pillars.join('')}`;

  const html = `<!doctype html><html lang="${htmlLang(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(docTitle)}</title>
<style>${CSS}</style></head>
<body><div class="report">
<div class="report-l2 report-l2-top">🤖 <b>${esc(T('report.aiBadge') || '本报告由 AI 生成')}</b> · ${esc(l2)}</div>
<header class="top">
  <div class="title-cn">${esc(T('report.titleMain') || '八字命盘')}</div>
  <div class="title-en">${esc(T('report.titleSub') || 'Ba Zi · Four Pillars of Destiny')}</div>
  <div class="ai-badge">${esc(T('report.aiBadge') || 'AI 生成 · 仅供娱乐参考')}</div>
  <div class="meta">
    <span>${metaLbl('birth', '生辰')}：<b>${esc(calendarCn)} ${esc(input.date)} ${esc(input.time)}</b></span>
    <span>${metaLbl('gender', '性别')}：<b>${esc(genderCn)}</b></span>
    <span>${metaLbl('place', '出生地')}：<b>${esc(input.location)}</b></span>
    <span>${metaLbl('trueSolar', '校正后真太阳时')}：<b>${esc(trueSolarTime.iso || solarTime)}</b></span>
    <span>${metaLbl('lunar', '对应农历')}：<b>${esc(lunarTimeText)}</b></span>
    <span>${metaLbl('dayMaster', '日主')}：<b>${esc(dayMaster)}（${esc(EL(I.strength.dayMasterElement))}）</b></span>
  </div>
  <div class="note-box">⏱ ${esc(tstNote)}</div>
</header>

<section class="card">${secHead('pillars')}
  <div class="pillars">${pillarRows}</div>
</section>

<section class="card">${secHead('wuxing')}
  <div class="wx">${wxRows}</div>
  <div class="wx-legend">${esc(T('report.lbl.strongest') || '最旺')}：${esc(EL(I.wuxing.strongest))}　${esc(T('report.lbl.weakest') || '最弱')}：${esc(EL(I.wuxing.weakest))}　${esc(T('report.lbl.missing') || '缺失')}：${esc(missingTxt)}</div>
</section>

<section class="card">${secHead('pattern')}
  ${yongShen}
  <div style="margin-top:10px;font-size:13px;color:var(--ink-dim)">${esc(I.pattern.text || '')}</div>
</section>

<section class="card">${secHead('dayun')}
  <div class="timeline">${dyRow}</div>
</section>

<section class="card">${secHead('liunian')}
  <div class="tabs">${yearTabs}</div>
  ${yearPanels}
</section>

<section class="card">${secHead('months')}
  <div class="months">${monthRows}</div>
</section>

<section class="card">${secHead('domains')}
  <div class="domains">${domainCards}</div>
</section>

<section class="summary"><div class="h">${esc(T('report.sec.summary.h') || '三句话总结')}</div>
  <div class="s">${s1}</div>
  <div class="s">${s2}</div>
  <div class="s">${s3}</div>
</section>

<div class="disclaimer report-l2 report-l2-bottom">⚠️ ${esc(l2)} ${esc(T('report.discBottom') || '')}</div>
</div>
<script>
(function(){
  var tabs=document.querySelectorAll('.tab'),panels=document.querySelectorAll('.panel');
  tabs.forEach(function(t){t.onclick=function(){var i=t.getAttribute('data-i');
    tabs.forEach(function(x){x.classList.remove('active')});panels.forEach(function(x){x.classList.remove('active')});
    t.classList.add('active');document.querySelector('.panel[data-i="'+i+'"]').classList.add('active');};});
})();
</script>
</body></html>`;
  return html;
}
