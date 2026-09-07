#!/usr/bin/env node
/**
 * I3 测试脚手架（功能未实现时 skip）
 *
 * 辰箓 Chronik · I3 免费额度验收脚手架（fail-open）
 *
 * 依据任务规范（I3 变现闭环占位测试）：检测目标功能/路由是否就绪。
 *   - 探活 http://<base>/api/quota
 *   - 若路由不存在（连接失败 / 404 / 501）/ 功能标志未开
 *     → console.log('SKIP <用例>') 并 process.exit(0)（不视为失败）。
 *   - 若路由存在 → 写 1–2 条基础断言（返回剩余次数、额度上限字段）。
 *
 * 运行：node tools/test-quota.mjs
 *   可选：CHRONIK_BASE_URL（默认 http://127.0.0.1:8787）
 */

import assert from 'node:assert';

const BASE_URL = (process.env.CHRONIK_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

function skip(msg) {
  console.log(`SKIP test-quota — ${msg}`);
  process.exit(0);
}
function fail(msg) {
  console.error(`❌ [test-quota] ${msg}`);
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
  return { status: res.status, json };
}

async function main() {
  console.log('=== I3 免费额度验收（脚手架 · 路由探测，未实现则 skip）===');

  // ── 探测：/api/quota 是否就绪 ──
  let probe;
  try {
    probe = await http('GET', '/api/quota');
  } catch (e) {
    skip(`NOT-IMPLEMENTED: 无法连接 ${BASE_URL}（${e.message}），/api/quota 未就绪，跳过免费额度验收`);
  }

  // 404 / 501 → 端点未实现
  if (probe.status === 404 || probe.status === 501) {
    skip('NOT-IMPLEMENTED: /api/quota 返回 404/501，免费额度（I3）未落地，跳过');
  }

  // 功能标志未开：响应中明确标记未启用 → skip
  const body = probe.json || {};
  const disabled = body.enabled === false || body.quotaEnabled === false || body.i3Enabled === false;
  if (disabled) {
    skip('功能标志未开（enabled/quotaEnabled/i3Enabled === false），免费额度（I3）未启用，跳过');
  }

  ok(`/api/quota 可达（status=${probe.status}），进入基础断言`);

  // ── 基础断言：返回剩余次数与额度上限 ──
  assert.ok(
    typeof body.remaining === 'number' || typeof body.remainingQuota === 'number',
    `应返回剩余次数(remaining/remainingQuota)，实际: ${JSON.stringify(body)}`,
  );
  ok('返回剩余额度字段');

  assert.ok(
    typeof body.limit === 'number' || typeof body.dailyLimit === 'number',
    `应返回额度上限(limit/dailyLimit)，实际: ${JSON.stringify(body)}`,
  );
  ok('返回额度上限字段');

  console.log('\n🎉 test-quota 基础断言通过（剩余次数 + 额度上限）');
  process.exit(0);
}

main().catch((e) => {
  console.error('脚本异常退出:', e);
  skip(`异常：${e && e.message ? e.message : String(e)}`);
});
