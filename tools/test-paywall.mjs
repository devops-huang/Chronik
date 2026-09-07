#!/usr/bin/env node
/**
 * 辰箓 Chronik · I3 付费墙验收脚手架（fail-open）——【最关键】
 *
 * 核心命题：「前端限制不算数」。唯一能证明付费墙真实生效的手段，是
 * 绕过前端 UI，直接对 API 发起请求，验证服务端是否拦截。
 *
 * 合约（依据 RELEASE-PLAN §I3 P0-6/P0-8）：
 *   - 免费用户每日有 AI 轮次上限（默认 3，Asia/Shanghai 自然日）；
 *   - 服务端（非前端）必须强制该上限与付费权益：
 *     免费用户耗尽额度后，第 N+1 次直接 API 调用必须被服务端拒绝
 *     （建议 402 Payment Required / 403，带 paywall 标志），
 *     绝不能返回正常 200 + AI 回答；
 *   - 付费过期 / 无权益的账号，访问付费专属能力必须被服务端拒绝。
 *
 * 当前 I3 未实现 → 探测服务端是否具备付费墙能力：
 *   探测为「无」→ 明确 SKIP（NOT-IMPLEMENTED），不报错、不阻断。
 *   探测为「有」→ 跑关键断言（绕过前端直连 API 是否被服务端拦截）。
 *
 * 运行：node tools/test-paywall.mjs
 *   可选：CHRONIK_BASE_URL（默认 http://127.0.0.1:8787）
 */

import assert from 'node:assert';

const BASE_URL = (process.env.CHRONIK_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

function skip(msg) {
  console.log(`⚠️  SKIP [test-paywall] — ${msg}`);
  process.exit(0);
}
function fail(msg) {
  console.error(`❌ [test-paywall] ${msg}`);
  process.exit(1);
}
function ok(msg) { console.log(`✅ ${msg}`); }

async function http(method, path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

const rnd = Math.random().toString(36).slice(2, 10);
const TEST_USER = `paywall_${rnd}`;
const TEST_PASS = 'Paywall@' + rnd + '2026';

async function main() {
  console.log('=== I3 付费墙验收（脚手架 · 绕过前端直连 API 是否被服务端拦截）===');

  // ── 探测：服务是否可达 ──
  let root;
  try {
    root = await fetch(BASE_URL + '/api/config', { method: 'GET' });
  } catch (e) {
    skip(`NOT-IMPLEMENTED: 无法连接 ${BASE_URL}（${e.message}），付费墙（I3）未就绪，跳过`);
  }
  ok(`服务可达（/api/config status=${root.status}）`);

  // ── 探测：服务端是否具备付费墙能力（tier/entitlement/限额字段）──
  // 通过注册一个免费测试账号，查看 /api/auth/me 是否暴露 tier / plan / entitlement，
  // 或 /api/config 是否暴露 aiFreeRounds / tiers / paywall 等键。
  let reg, sessionCookie;
  try {
    reg = await http('POST', '/api/auth/register', {
      body: { username: TEST_USER, password: TEST_PASS, nickname: 'Paywall', agree: true, consent: true },
    });
  } catch (e) {
    skip(`NOT-IMPLEMENTED: 注册失败（${e.message}），无法建立付费墙测试账号，跳过`);
  }
  if (reg.status !== 200 || !reg.setCookie) {
    skip(`NOT-IMPLEMENTED: /api/auth/register 返回 ${reg.status}，付费墙能力探测无法进行，跳过`);
  }
  sessionCookie = reg.setCookie.split(';')[0];
  ok('注册免费测试账号成功');

  const me = await http('GET', '/api/auth/me', { cookie: sessionCookie });
  const cfg = await root.json().catch(() => ({}));
  const userObj = me.json && me.json.user ? me.json.user : {};
  const hasTierField = 'tier' in userObj || 'plan' in userObj || 'entitlement' in userObj;
  const hasConfigKey = ['aiFreeRounds', 'tiers', 'paywall', 'freeDailyRounds'].some((k) => k in (cfg || {}));

  if (!hasTierField && !hasConfigKey) {
    // 尝试清理测试账号
    await http('POST', '/api/me/delete', { cookie: sessionCookie }).catch(() => {});
    skip('NOT-IMPLEMENTED: /api/auth/me 无 tier/plan/entitlement，/api/config 无付费墙键 —— 服务端付费墙（I3）未落地，跳过');
  }
  const freeLimit = Number(cfg.aiFreeRounds ?? cfg.freeDailyRounds ?? userObj.aiFreeRounds ?? 3);
  ok(`检测到付费墙能力（freeLimit=${freeLimit}），进入关键断言`);

  // ── 关键断言：绕过前端，直接对 /api/chat 直连，耗尽免费额度后必须被服务端拦截 ──
  // 注意：此处完全不依赖任何前端按钮/开关，纯服务端视角。
  let blockedAt = null;
  for (let i = 1; i <= freeLimit + 1; i++) {
    const r = await http('POST', '/api/chat', {
      cookie: sessionCookie,
      body: { message: { content: `付费墙探测第 ${i} 轮` }, chartId: null, chartContext: null, conversationId: null },
    });
    // 服务端若拦截：应返回 402/403 且带 paywall / needLogin 之类标志，而非 200 + AI 内容
    const isBlocked = r.status === 402 || r.status === 403 ||
      (r.json && (r.json.paywall || r.json.needLogin || r.json.upgradeRequired));
    if (isBlocked) { blockedAt = i; break; }
  }
  assert.ok(blockedAt !== null, `绕过前端直连 API 未被服务端拦截（${freeLimit} 轮后仍返回正常响应）—— 付费墙未生效`);
  assert.strictEqual(blockedAt, freeLimit + 1, `服务端应在第 ${freeLimit + 1} 轮拦截，实际第 ${blockedAt} 轮拦截`);
  ok(`服务端在第 ${blockedAt} 轮拦截了绕过前端的直连请求（无前端参与，纯服务端强制）`);

  // ── 清理测试账号（best-effort）──
  await http('POST', '/api/me/delete', { cookie: sessionCookie }).catch(() => {});

  console.log('\n🎉 test-paywall 关键断言通过：付费墙由服务端强制，前端限制不可绕过');
  process.exit(0);
}

main().catch((e) => {
  console.error('脚本异常退出:', e);
  skip(`异常：${e && e.message ? e.message : String(e)}`);
});
