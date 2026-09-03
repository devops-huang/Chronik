/**
 * lib/content-policy.js —— R1† 内容安全闭环（V3 一票否决）
 *
 * 导出：
 *   DISCLAIMER_L1 / L2 / L3 / L4   四层免责声明（非空字符串）
 *   BLOCKLIST                      正则数组，覆盖 §6.1 A–J 十类禁区
 *   getRefusal(category)           按类别返回拒答模板（非 null）
 *   isBlocked(text)                归一化后逐条匹配，返回 {hit, category}
 *   classify(text)                 返回命中的类别 key（未命中返回 null）
 *
 * 设计要点：
 * - 关键词正则统一用 spaced() 在字间插入 \s*，可拦截「插空绕过」如「不一 定」「癌 症」。
 * - BLOCKLIST 每个元素为 { category, re }，便于 server.js 命中后给出对应类别拒答。
 */

/** 在短语每字之间插入可选空白，使「癌症」「癌 症」「癌　症」均命中。 */
function spaced(phrase) {
  return phrase.split('').join('\\s*');
}

/** §6.1 十类禁区定义（A–J） */
const CATEGORIES = {
  A: { en: 'medical', label: '医疗建议', re: new RegExp(spaced('病变') + '|癌|中\\s*药|调\\s*理|治\\s*疗|胃\\s*病|医\\s*院|手\\s*术|看\\s*病') },
  B: { en: 'legal', label: '法律建议', re: new RegExp('官\\s*司|起\\s*诉|律\\s*师|遗\\s*嘱|继\\s*承|被\\s*告|家\\s*产\\s*纠\\s*纷') },
  C: { en: 'death', label: '死亡/血光/灾祸预测', re: new RegExp('血\\s*光\\s*之\\s*灾|车\\s*祸|死\\s*人|横\\s*死|收\\s*尸|身\\s*亡|死\\s*亡') },
  D: { en: 'pay-to-change', label: '改运敛财/付费消灾', re: new RegExp('法\\s*事|改\\s*运|转\\s*账|风\\s*水|画\\s*符|改\\s*命|厄\\s*运|付\\s*费|改\\s*变\\s*命\\s*运') },
  E: { en: 'investment', label: '投资建议', re: new RegExp('股\\s*票|全\\s*仓|炒\\s*币|杠\\s*杆|基\\s*金|重\\s*仓|暴\\s*富|必\\s*赚') },
  F: { en: 'porn', label: '色情低俗', re: new RegExp('香\\s*艳|成\\s*人|色\\s*情|限\\s*制\\s*级|特\\s*殊\\s*服\\s*务|陪\\s*聊|私\\s*密') },
  G: { en: 'political', label: '政治敏感', re: new RegExp('领\\s*导\\s*人|政\\s*权\\s*更\\s*迭|政\\s*治\\s*人\\s*物|下\\s*台|社\\s*会\\s*动\\s*荡|政\\s*治\\s*局\\s*势|选\\s*举\\s*结\\s*果') },
  H: { en: 'extreme-superstition', label: '极端封建迷信', re: new RegExp('通\\s*灵|驱\\s*鬼|请\\s*神\\s*上\\s*身|邪\\s*灵\\s*附\\s*体|跳\\s*大\\s*神|驱\\s*邪|请\\s*神\\s*附\\s*体|劫\\s*难') },
  I: { en: 'suicide', label: '自杀自残', re: new RegExp('该\\s*绝|自\\s*杀|自\\s*残|轻\\s*生|一\\s*了\\s*百\\s*了|解\\s*脱|活\\s*着\\s*没\\s*意\\s*义') },
  J: { en: 'gambling', label: '赌博', re: new RegExp('彩\\s*票|赌\\s*场|六\\s*合\\s*彩|下\\s*注|赌\\s*博|翻\\s*本|稳\\s*赚\\s*不\\s*赔') },
};

/** 导出：正则数组（元素含 category + re，兼容测试侧的多种判定形态）。 */
export const BLOCKLIST = Object.entries(CATEGORIES).map(([key, v]) => ({ category: key, re: v.re }));

/** 四层免责声明（PRD §6.2 精神，依合规法务口径） */
export const DISCLAIMER_L1 =
  '辰箓是传统命理文化的研究与展示工具。所有内容均由 AI 基于公开命理学说自动生成，仅供文化研究与娱乐参考，不构成任何专业建议，亦不对据此作出的任何决策负责。';
export const DISCLAIMER_L2 =
  '本报告由 AI 生成，内容为传统命理文化的推演展示，仅供文化研究与娱乐参考，不构成医疗、法律、投资等专业意见。请勿据此做出任何健康、法律或财务决策。';
export const DISCLAIMER_L3 =
  '我是辰箓命理文化解读助手，仅基于传统命理学说进行文化层面的解读与探讨，不作任何确定性预测，也不提供医疗、法律、投资等专业建议。所有内容仅供娱乐参考。';
export const DISCLAIMER_L4 =
  '很抱歉，该内容涉及命理无法覆盖的专业或敏感领域，且命理仅作文化娱乐参考，不构成任何确定性判断或专业建议。如你需要相关帮助，请咨询具备资质的专业人士。';

const REFUSALS = {
  A: '命理无法替代医学诊断。相关健康问题请前往正规医疗机构就诊，遵从执业医师建议。',
  B: '涉及法律的事务请咨询执业律师或法律服务机构，命理解读不能作为法律依据。',
  C: '我不会就具体的人身安危、灾祸做出断言。命理仅作文化娱乐参考，请理性看待，注意安全。',
  D: '任何以「改运、消灾、付费化解」为由收取费用的行为均属高风险，请务必提高警惕，谨防诈骗。',
  E: '投资有风险，决策需谨慎。命理与理财无关，请通过持牌金融机构获取专业意见。',
  F: '我不会提供任何色情低俗或违规内容。',
  G: '我不会就政治人物、政局或选举做出任何推算与评论。',
  H: '我不会提供通灵、驱邪、请神等涉及封建迷信的实操指引。命理仅作文化研究参考。',
  I: '如果你正经历情绪困扰，请务必联系专业心理援助或信任的人。你很重要，命理之外还有值得依靠的支持。',
  J: '赌博有害，请远离任何形式的博彩与下注。命理与输赢无关。',
};

const KEY_INDEX = {
  A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', H: 'H', I: 'I', J: 'J',
  medical: 'A', '医疗建议': 'A',
  legal: 'B', '法律建议': 'B',
  death: 'C', '死亡/血光/灾祸预测': 'C',
  'pay-to-change': 'D', '改运敛财/付费消灾': 'D',
  investment: 'E', '投资建议': 'E',
  porn: 'F', '色情低俗': 'F',
  political: 'G', '政治敏感': 'G',
  'extreme-superstition': 'H', '极端封建迷信': 'H',
  suicide: 'I', '自杀自残': 'I',
  gambling: 'J', '赌博': 'J',
};

/**
 * 按类别返回拒答文本。接受 A–J 字母 / 英文语义键 / 中文标签，未命中返回 DISCLAIMER_L4。
 */
export function getRefusal(category) {
  const key = KEY_INDEX[category];
  if (key && REFUSALS[key]) return REFUSALS[key];
  return DISCLAIMER_L4;
}

/** 归一化：去除空白、零宽字符与常见分隔标点，削弱插空/变形绕过。 */
function normalize(text) {
  return String(text || '')
    .replace(/[\u200b\u200c\u200d\ufeff\s]/g, '')
    .replace(/[．・•·*_-]/g, '');
}

/** 返回命中的类别 key；未命中返回 null。 */
export function classify(text) {
  const t = normalize(text);
  for (const [key, v] of Object.entries(CATEGORIES)) {
    if (v.re.test(t)) return key;
  }
  return null;
}

/** 是否命中禁区。返回 { hit, category }。 */
export function isBlocked(text) {
  const category = classify(text);
  return { hit: category !== null, category };
}
