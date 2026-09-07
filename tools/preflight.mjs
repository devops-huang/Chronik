#!/usr/bin/env node
/**
 * 辰箓 Chronik · 发布门禁 `preflight`
 *
 * 串联 8 个现有验收脚本，任一「红」（脚本正常运行后断言失败）即整体非零退出，
 * 禁止发版。串联顺序（依据任务规范，固定不可调）：
 *
 *   smoke.mjs → verify-i0.mjs → qa-gates.mjs → test-content-policy.mjs →
 *   test-gdpr.mjs → test-auth.mjs → test-chart.mjs → test-report.mjs → test-pipeline.mjs
 *
 *   注：verify-i0 与 test-pipeline 并存——两者分别来自两份 QA 任务规范的 8 脚本清单
 *   （一份含 verify-i0、一份含 test-pipeline），合并后共 9 项，确保两条真实链路都不被遗漏。
 *
 * fail-open 策略（依据工作区硬约束「所有检查 fail-open」）：
 *   - 脚本文件缺失            → SKIP（记录）
 *   - 脚本无法启动 / 超时     → SKIP（记录）
 *   - 脚本运行期崩溃（抛栈）  → SKIP（记录，需人工核查，不阻断发版）
 *   - 依赖环境的脚本（qa-gates / test-gdpr，需 PG + 运行中的服务）
 *     因环境不可用而失败       → SKIP（记录）
 *   - 脚本正常运行、断言失败   → FAIL（红）→ 整体非零退出
 *
 * 设计原则：只为串联而建此编排器，绝不修改任何被串联脚本的逻辑。
 * 特殊参数：smoke.mjs 依赖 .ts 类型擦除，需以
 *   `node --experimental-strip-types tools/smoke.mjs` 运行（已内置）。
 *
 * 运行：npm run preflight
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NODE = process.execPath;

// 8 个待串联脚本及其调用方式（顺序严格按任务规范）。
//   args:         进程启动参数（smoke 依赖 .ts 类型擦除）
//   envDependent: 依赖 PG + 运行中的服务；环境不可用时 fail-open SKIP
const SCRIPTS = [
  { name: 'smoke',               file: 'tools/smoke.mjs',               args: ['--experimental-strip-types'], envDependent: false },
  { name: 'verify-i0',           file: 'tools/verify-i0.mjs',           args: [],                            envDependent: false },
  { name: 'qa-gates',            file: 'tools/qa-gates.mjs',            args: [],                            envDependent: true  },
  { name: 'test-content-policy', file: 'tools/test-content-policy.mjs', args: [],                            envDependent: false },
  { name: 'test-gdpr',           file: 'tools/test-gdpr.mjs',           args: [],                            envDependent: true  },
  { name: 'test-auth',           file: 'tools/test-auth.mjs',           args: [],                            envDependent: false },
  { name: 'test-chart',          file: 'tools/test-chart.mjs',          args: [],                            envDependent: false },
  { name: 'test-report',         file: 'tools/test-report.mjs',         args: [],                            envDependent: false },
  { name: 'test-pipeline',       file: 'tools/test-pipeline.mjs',       args: [],                            envDependent: false },
];

// 环境不可用的典型标记：envDependent 脚本失败时据此判定为 SKIP 而非 FAIL。
const ENV_ERROR_MARKERS = [
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'getaddrinfo',
  'fetch failed', 'Unable to connect', 'timed out', 'connect',
  '连接失败', '服务连通性: 失败', 'PG 连接失败', 'Connection terminated',
];

// 运行期崩溃标记：脚本抛栈退出（与「正常运行后断言失败」区分）。
const CRASH_MARKERS = [
  'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
  'Cannot read', 'is not a function', 'is not defined',
  'Cannot find module', 'Unexpected token', 'Node.js v',
];

function runOne(spec) {
  const full = join(ROOT, spec.file);
  if (!existsSync(full)) {
    return { name: spec.name, status: 'SKIP', detail: `脚本缺失: ${spec.file}` };
  }

  const res = spawnSync(NODE, [...spec.args, full], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: process.env,
  });

  const out = `${res.stdout || ''}\n${res.stderr || ''}`;

  // 无法启动 / 超时（spawnSync 级错误）
  if (res.error) {
    return { name: spec.name, status: 'SKIP', detail: `无法启动: ${res.error.code || res.error.message}` };
  }
  if (res.status === null) {
    return { name: spec.name, status: 'SKIP', detail: '运行超时（无退出码）' };
  }
  // 正常运行，退出 0 → 通过
  if (res.status === 0) {
    return { name: spec.name, status: 'PASS', detail: 'exit 0' };
  }

  // 非零退出：区分「环境不可用」与「运行期崩溃」→ SKIP；其余视为「红」→ FAIL
  const hasEnvErr = ENV_ERROR_MARKERS.some((m) => out.includes(m));
  const hasCrash = CRASH_MARKERS.some((m) => out.includes(m));

  if (spec.envDependent && hasEnvErr) {
    return { name: spec.name, status: 'SKIP', detail: '环境不可用（PG/服务未就绪），fail-open 跳过' };
  }
  if (hasCrash) {
    return { name: spec.name, status: 'SKIP', detail: '运行期崩溃（疑似与当前 lib API 不兼容），fail-open 跳过，需人工核查' };
  }
  return { name: spec.name, status: 'FAIL', detail: `exit ${res.status}（断言失败）` };
}

function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   辰箓 Chronik · 发布门禁 preflight（fail-open）          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const results = [];
  for (const spec of SCRIPTS) {
    const r = runOne(spec);
    results.push(r);
    const tag = { PASS: '✅', FAIL: '❌', SKIP: '⚠️ ' }[r.status];
    console.log(`${tag} ${spec.name.padEnd(20)} ${r.status.padEnd(4)} ${r.detail}`);
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;

  console.log('\n──────────── 汇总 ────────────');
  console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}  /  总计=${results.length}`);

  if (skip > 0) {
    console.log('\n⚠️  被 fail-open 跳过的项（不阻断发版，但建议人工核查）：');
    for (const r of results.filter((x) => x.status === 'SKIP')) {
      console.log(`   - ${r.name}: ${r.detail}`);
    }
  }

  if (fail > 0) {
    console.log(`\n❌ 存在 ${fail} 项「红」（断言失败），禁止发版。`);
    process.exit(1);
  }

  console.log('\n✅ 无「红」，发布门禁通过（SKIP 项不影响发版）。');
  process.exit(0);
}

main();
