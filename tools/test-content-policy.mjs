// tools/test-content-policy.mjs
// 测试对象：lib/content-policy.js（R1† 内容安全闭环，依据 PRD §6.1 A–J 类）
// 运行：node tools/test-content-policy.mjs
// 依赖：主程实现 lib/content-policy.js，导出：
//   DISCLAIMER_L1 / DISCLAIMER_L2 / DISCLAIMER_L3 / DISCLAIMER_L4（四层免责文本）
//   BLOCKLIST（正则数组，覆盖 §6.1 A–J，含同义变体与插空绕过如「不一 定」）
//   getRefusal(category)（按类别返回非 null 拒答文本）
// 失败策略：任意断言失败即 process.exit(1)。

import assert from 'node:assert';

let BLOCKLIST, getRefusal, DISCLAIMER_L1, DISCLAIMER_L2, DISCLAIMER_L3, DISCLAIMER_L4;
try {
  ({ BLOCKLIST, getRefusal, DISCLAIMER_L1, DISCLAIMER_L2, DISCLAIMER_L3, DISCLAIMER_L4 } =
    await import('../lib/content-policy.js'));
} catch (e) {
  console.error('❌ 无法加载 lib/content-policy.js：' + (e && e.message));
  console.error('   请先由主程创建该模块（PRD R1† 步骤 1）。');
  process.exit(1);
}

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

// ── 容错：BLOCKLIST 可能是正则数组，或对象数组（含 .re / .pattern）──
function isBlocked(text) {
  assert.ok(Array.isArray(BLOCKLIST), 'BLOCKLIST 必须是数组');
  for (const item of BLOCKLIST) {
    if (item instanceof RegExp) {
      if (item.test(text)) return true;
    } else if (item && item.re instanceof RegExp) {
      if (item.re.test(text)) return true;
    } else if (item && typeof item.pattern === 'string') {
      if (new RegExp(item.pattern, 'i').test(text)) return true;
    } else if (item && typeof item.test === 'function') {
      if (item.test(text)) return true;
    }
  }
  return false;
}

// 容错：getRefusal 可能接受 A–J 字母、英文语义键或中文标签；逐一尝试。
function refusalFor(cat) {
  const candidates = [cat.key, cat.en, cat.label].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = getRefusal(c);
      if (typeof r === 'string' && r.length > 0) return r;
    } catch { /* 尝试下一个候选键 */ }
  }
  return null;
}

// ── §6.1 A–J 十类禁区，每类 3 条样本（含插空绕过 / 同义变体）──
const CATEGORIES = [
  {
    key: 'A', en: 'medical', label: '医疗建议',
    samples: [
      '你这个八字显示肝脏有病变，建议吃中药调理治疗',
      '根据命盘你得了胃病，应该尽快去医院手术',
      '你 的 命 盘 预 示 有 癌 症 风险 赶紧 去 看病', // 插空绕过
    ],
  },
  {
    key: 'B', en: 'legal', label: '法律建议',
    samples: [
      '你这个官司必赢，按我说的去起诉对方准没错',
      '命里显示你会被告，最好马上请律师打继承官司',
      '依 照 八 字 你 应 该 立 遗 嘱 避 免 家 产 纠 纷', // 插空绕过
    ],
  },
  {
    key: 'C', en: 'death', label: '死亡/血光/灾祸预测',
    samples: [
      '你今年有血光之灾，会出车祸死人',
      '命盘注定你明年横死街头无人收尸',
      '你 近 期 必 有 血 光 之 灾 慎 防 身 亡', // 插空绕过
    ],
  },
  {
    key: 'D', en: 'pay-to-change', label: '改运敛财/付费消灾',
    samples: [
      '花8888元做场法事就能帮你改运化解厄运',
      '转账给我帮你调风水改命，不然厄运缠身',
      '只 需 付 费 请 道 长 画 符 即 可 改 变 你 的 命 运', // 插空绕过
    ],
  },
  {
    key: 'E', en: 'investment', label: '投资建议',
    samples: [
      '你命带财星，赶紧全仓买入这只股票',
      '按命盘你应该杠杆炒币实现暴富',
      '听 我 的 重 仓 买 基 金 必 赚 三 倍', // 插空绕过
    ],
  },
  {
    key: 'F', en: 'porn', label: '色情低俗',
    samples: [
      '想看香艳命盘私密解读，加我进成人资源群',
      '命理师提供色情陪聊和线下特殊服务',
      '私 密 桃 花 运 聊 天 限 制 级 内 容 仅 供 付 费', // 插空绕过
    ],
  },
  {
    key: 'G', en: 'political', label: '政治敏感',
    samples: [
      '用八字推算国家领导人的运势和政权更迭',
      '命理显示某政治人物会下台引发社会动荡',
      '推 算 政 治 局 势 与 选 举 结 果 的 八 字', // 插空绕过
    ],
  },
  {
    key: 'H', en: 'extreme-superstition', label: '极端封建迷信',
    samples: [
      '供奉我这个方法能通灵驱鬼请神上身',
      '你被邪灵附体了必须跳大神才能驱邪',
      '只 有 请 神 附 体 才 能 化 解 你 的 劫 难', // 插空绕过
    ],
  },
  {
    key: 'I', en: 'suicide', label: '自杀自残',
    samples: [
      '你命里该绝，不如自杀一了百了',
      '既然运势这么差去自残发泄一下吧',
      '活 着 没 意 义 赶 紧 轻 生 解 脱 吧', // 插空绕过
    ],
  },
  {
    key: 'J', en: 'gambling', label: '赌博',
    samples: [
      '按命盘今晚必中彩票，去赌场搏一把',
      '带你进地下六合彩群稳赚不赔',
      '跟 我 下 注 赌 博 一 夜 翻 本', // 插空绕过
    ],
  },
];

try {
  // ── 四层免责声明：必须存在且非空 ──
  for (const [name, val] of [['L1', DISCLAIMER_L1], ['L2', DISCLAIMER_L2], ['L3', DISCLAIMER_L3], ['L4', DISCLAIMER_L4]]) {
    assert.ok(typeof val === 'string' && val.trim().length > 0, `DISCLAIMER_${name} 必须为非空字符串`);
    console.log(`✅ DISCLAIMER_${name} 已定义（${val.length} 字）`);
  }

  // ── 拒答模板：每类都应返回非 null 拒答 ──
  let refusalOk = 0;
  for (const cat of CATEGORIES) {
    const r = refusalFor(cat);
    assert.ok(r !== null, `getRefusal(${cat.key}/${cat.label}) 应返回非 null 拒答`);
    refusalOk++;
  }
  console.log(`✅ getRefusal 对 §6.1 全部 ${refusalOk} 类均返回拒答`);

  // ── 每类 3 条样本必须全部命中 BLOCKLIST ──
  let total = 0, blocked = 0, firstFail = null;
  for (const cat of CATEGORIES) {
    for (const s of cat.samples) {
      total++;
      if (isBlocked(s)) {
        blocked++;
        console.log(`✅ [${cat.key}] 命中拦截：${s.slice(0, 18)}…`);
      } else {
        console.error(`❌ [${cat.key}] 未拦截（应被 BLOCKLIST 命中）：${s}`);
        if (!firstFail) firstFail = `[${cat.key}] ${s}`;
      }
    }
  }
  assert.strictEqual(blocked, total, `应有 ${total} 条样本全部命中，实际命中 ${blocked}；首个失败：${firstFail}`);
  console.log(`\n🎉 test-content-policy 全部断言通过（${total}/${total} 样本拦截 + 4 层免责 + 10 类拒答）。`);
  process.exit(0);
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
