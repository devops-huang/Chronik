#!/usr/bin/env node
/**
 * 辰箓 Chronik · 生产部署脚本 (tools/deploy.mjs)
 * ----------------------------------------------------------------------------
 * 设计原则：默认「只打印、不改动」(DRY_RUN)，所有会改变生产状态的动作
 * 仅在显式置 DEPLOY_EXEC=1 时真实执行；.env 同步是独立步骤，默认不执行。
 *
 * 运行模式（环境变量）：
 *   DRY_RUN=1   （默认）只打印将要执行的命令，绝不触碰生产。
 *   DEPLOY_EXEC=1  真正执行：git pull → npm ci → rsync → 重启 → 健康检查。
 *   ENV_SYNC=1   （需配合 DEPLOY_EXEC=1）额外 rsync .env（独立安全步骤，默认关闭）。
 *
 * 可配置目标（环境变量，均带默认值）：
 *   PROD_HOST   SSH 目标，默认 "chronik@chronik.cn"
 *   PROD_PATH   远端应用根目录，默认 "/opt/chronik"
 *   DOMAIN      健康检查域名，默认 "chronik.cn"
 *
 * 用法示例：
 *   node tools/deploy.mjs                     # 只见命令，不执行
 *   DEPLOY_EXEC=1 node tools/deploy.mjs       # 真实部署（需可达 PG + 有效 SSH）
 *   DEPLOY_EXEC=1 ENV_SYNC=1 node tools/deploy.mjs   # 部署并同步 .env
 *
 * 前置（本脚本不负责）：可达的 PG、有效的 prod SSH 凭证、sudo systemd 权限。
 * 本脚本绝不执行 git push / 绝不直连生产数据库做写操作。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// ── 模式解析 ──────────────────────────────────────────────────────────────
const EXEC = process.env.DEPLOY_EXEC === '1';
const ENV_SYNC = process.env.ENV_SYNC === '1';
const PROD_HOST = process.env.PROD_HOST || 'chronik@chronik.cn';
const PROD_PATH = process.env.PROD_PATH || '/opt/chronik';
const DOMAIN = process.env.DOMAIN || 'chronik.cn';

const MODE = EXEC ? 'EXEC (真实执行)' : 'DRY_RUN (仅打印)';
console.log(`\n=== 辰箓 v6.3.0 部署脚本 · ${MODE} ===`);
console.log(`   目标主机 : ${PROD_HOST}`);
console.log(`   远端路径 : ${PROD_PATH}`);
if (EXEC && ENV_SYNC) console.log('   ⚠  ENV_SYNC=1 → 将额外同步 .env');
if (EXEC && !ENV_SYNC) console.log('   · .env 默认不同步（独立步骤，见下方注释）');

// ── 安全执行封装 ──────────────────────────────────────────────────────────
// dry-run 下仅打印；exec 下真正运行。任何写操作都必须经由本函数。
function run(cmd, args = [], { pipe = false } = {}) {
  const full = `${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  if (!EXEC) {
    console.log(`  $ ${full}`);
    return { status: 0, stdout: '' };
  }
  console.log(`  ▶ ${full}`);
  const res = spawnSync(cmd, args, { stdio: pipe ? 'pipe' : 'inherit', cwd: ROOT });
  if (res.status !== 0 && res.error) {
    console.error(`  ✗ 命令失败: ${res.error.message}`);
  }
  return { status: res.status ?? (res.error ? 1 : 0), stdout: res.stdout?.toString() || '' };
}

// 本地只读命令，dry-run 与 exec 下都真实运行（用于自检，不改变生产）
function local(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout?.toString() || '';
  }
}

// ── 0. 前置检查 ───────────────────────────────────────────────────────────
console.log('\n[0/6] 前置检查');
const nodeVer = process.versions.node;
const [major, minor] = nodeVer.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`  ✗ Node ${nodeVer} 过旧：需 ≥22.6（package.json 使用 --experimental-strip-types）。中止。`);
  process.exit(2);
}
console.log(`  ✓ Node ${nodeVer} (≥22.6)`);

// ── 1. 语法校验 (node --check) ─────────────────────────────────────────────
console.log('\n[1/6] 语法校验 node --check（仅本地只读，生产零触碰）');
function collectJs(rootDir, acc = []) {
  for (const name of readdirSync(rootDir)) {
    if (name === 'node_modules' || name === '.git' || name === 'data') continue;
    const p = join(rootDir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectJs(p, acc);
    else if (/\.(js|mjs)$/.test(name)) acc.push(p);
  }
  return acc;
}
const entries = [
  join(ROOT, 'server.js'),
  ...collectJs(join(ROOT, 'lib')),
  ...collectJs(join(ROOT, 'public')),
  ...collectJs(join(ROOT, 'tools')),
];
let checkFail = 0;
for (const f of entries) {
  const r = run('node', ['--check', f]);
  if (EXEC && r.status !== 0) checkFail++;
}
// dry-run 下也要真正校验一遍，确保脚本本身没写坏
if (!EXEC) {
  for (const f of entries) {
    const r = spawnSync('node', ['--check', f], { cwd: ROOT });
    if (r.status !== 0) { checkFail++; console.error(`  ✗ 语法错误: ${relative(ROOT, f)}`); }
  }
}
if (checkFail > 0) {
  console.error(`  ✗ ${checkFail} 个文件语法校验失败，中止部署。`);
  process.exit(3);
}
console.log(`  ✓ ${entries.length} 个 .js/.mjs 入口全部通过 node --check`);

// ── 2. 拉取最新 ───────────────────────────────────────────────────────────
console.log('\n[2/6] 拉取最新 (git pull --ff-only)');
run('git', ['pull', '--ff-only']);

// ── 3. 依赖安装 ───────────────────────────────────────────────────────────
console.log('\n[3/6] 依赖安装 (npm ci，失败回退 npm install)');
const r = run('npm', ['ci']);
if (EXEC && r.status !== 0) run('npm', ['install']);

// ── 4. 同步代码到生产 (rsync) ──────────────────────────────────────────────
console.log('\n[4/6] 同步代码到生产 (rsync，--delete 保证幂等)');
// 目录：带 --delete，确保远端与服务端一致
run('rsync', ['-az', '--delete', '--exclude=.env', 'public/', `${PROD_HOST}:${PROD_PATH}/public/`]);
run('rsync', ['-az', '--delete', 'lib/', `${PROD_HOST}:${PROD_PATH}/lib/`]);
// 根文件：server.js / package.json / schema.sql
run('rsync', ['-az', 'server.js', 'package.json', 'schema.sql', `${PROD_HOST}:${PROD_PATH}/`]);

// .env 是独立安全步骤：默认不同步，需 ENV_SYNC=1 显式开启
console.log('\n  # —— .env 是独立步骤，默认不同步（含密钥，需单独授权） ——');
if (EXEC && ENV_SYNC) {
  run('rsync', ['-az', '.env', `${PROD_HOST}:${PROD_PATH}/.env`]);
} else {
  console.log(`  # 如需同步：${EXEC ? 'ENV_SYNC=1 ' : ''}rsync -az .env ${PROD_HOST}:${PROD_PATH}/.env`);
  console.log('  # 生产 .env 必须含: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PORT ICP_NO，以及 LLM 预设(经 admin)。');
}

// ── 5. 重启 systemd 服务（远端） ───────────────────────────────────────────
console.log('\n[5/6] 重启服务 (ssh → sudo systemctl restart chronik)');
run('ssh', [PROD_HOST, `'sudo systemctl restart chronik && sleep 2 && sudo systemctl is-active chronik'`]);

// ── 6. 健康检查 (curl /api/health) ────────────────────────────────────────
console.log('\n[6/6] 健康检查 (curl https://' + `${DOMAIN}/api/health)`);
run('curl', ['-fsS', '--max-time', '15', `https://${DOMAIN}/api/health`]);

console.log('\n=== 完成 ===');
if (!EXEC) {
  console.log('   当前为 DRY_RUN：以上命令未真正执行。');
  console.log('   确认无误后运行：DEPLOY_EXEC=1 node tools/deploy.mjs');
}
process.exit(0);
