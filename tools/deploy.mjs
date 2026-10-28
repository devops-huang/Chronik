#!/usr/bin/env node
/**
 * 辰箓 Chronik · 生产部署脚本 (tools/deploy.mjs)
 * ----------------------------------------------------------------------------
 * 设计原则：默认「只打印、不改动」(DRY_RUN)，所有会改变生产状态的动作
 * 仅在显式置 DEPLOY_EXEC=1 时真实执行；.env 同步是独立步骤，默认不执行。
 *
 * 运行模式（环境变量）：
 *   DRY_RUN=1     （默认）只打印将要执行的命令，绝不触碰生产。
 *   DEPLOY_EXEC=1 真正执行：快照 → rsync → 重启 → 健康检查。
 *   ENV_SYNC=1    （需配合 DEPLOY_EXEC=1）额外 rsync .env（独立安全步骤，默认关闭）。
 *
 * 回滚模式（命令行参数，优先级高于部署）：
 *   node tools/deploy.mjs --rollback              # 打印回滚步骤（DRY_RUN）
 *   DEPLOY_EXEC=1 node tools/deploy.mjs --rollback # 用最近一版快照回滚并重启
 *
 * 可配置目标（环境变量，均带默认值）：
 *   PROD_HOST   SSH 目标，默认 "root@106.13.11.227"
 *   PROD_PATH   远端应用根目录，默认 "/opt/bazi-system"
 *   SERVICE     systemd 服务名，默认 "bazi-system"
 *   SSH_OPTS    ssh 选项，默认已验证可用的口令登录选项串
 *   SSHPASS     非空时，ssh/rsync 经 `sshpass -p "$SSHPASS"` 注入口令（非交互必需）；
 *               已配免密 key 的机器留空即可（脚本退回裸 ssh）。
 *   HEALTH_URL  健康检查地址（在远端执行 curl），默认 "http://127.0.0.1:8787/api/health"
 *
 * 用法示例：
 *   node tools/deploy.mjs                          # 只见命令，不执行
 *   DEPLOY_EXEC=1 node tools/deploy.mjs            # 真实部署（需可达 PG + 有效 SSH）
 *   DEPLOY_EXEC=1 ENV_SYNC=1 node tools/deploy.mjs # 部署并同步 .env
 *   DEPLOY_EXEC=1 node tools/deploy.mjs --rollback # 回滚到最近一版快照
 *
 * ── 2026-09-08 决议 W1-② 修正说明（本文件曾与生产严重漂移，现按实际对齐）──
 *   1) 生产 /opt/bazi-system **不是 git 仓库**（部署 = rsync），故删除 git pull / npm ci 步骤。
 *   2) 服务名 chronik → bazi-system；目录 /opt/chronik → /opt/bazi-system。
 *   3) rsync 去掉 --delete：远端非 git 仓库，误删无版本库可救；删除动作一律交给快照回滚。
 *   4) 新增「快照留一版」：rsync 前先把将被覆盖的目标（public/ lib/ tools/ server.js）
 *      整棵 cp -a 到 /opt/bazi-system.bak.<YYYYmmdd-HHMMSS>/，并原子更新
 *      /opt/bazi-system.bak.latest 指向它；随后只保留最近一版，其余删除。
 *   5) 范围封顶 0.5d：只做「修对 + 快照留一版」，不做多版本管理、不做 git 化、
 *      不做交互确认流程（交互确认由 DRY_RUN 默认行为替代）。
 *
 * 前置（本脚本不负责）：可达的 PG、有效的 prod SSH 凭证、systemd 权限。
 * 本脚本绝不执行 git push / 绝不直连生产数据库做写操作。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// ── 模式解析 ──────────────────────────────────────────────────────────────
const EXEC = process.env.DEPLOY_EXEC === '1';
const ENV_SYNC = process.env.ENV_SYNC === '1';
const ROLLBACK = process.argv.includes('--rollback');

const PROD_HOST = process.env.PROD_HOST || 'root@106.13.11.227';
const PROD_PATH = process.env.PROD_PATH || '/opt/bazi-system';
const SERVICE = process.env.SERVICE || 'bazi-system';
const HEALTH_URL = process.env.HEALTH_URL || 'http://127.0.0.1:8787/api/health';
// 远端快照根目录：与 PROD_PATH 同级，命名 <basename>.bak.<时间戳>
const SNAP_PREFIX = `${PROD_PATH}.bak.`;
const SNAP_LATEST = `${PROD_PATH}.bak.latest`;
// 已验证可用的口令登录选项（生产未配免密 key；如需 key 登录可覆盖 SSH_OPTS=""）
const SSH_OPTS = (process.env.SSH_OPTS ??
  '-o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=no')
  .split(/\s+/).filter(Boolean);
// 非交互口令注入：SSHPASS 非空时给 ssh/rsync 套一层 sshpass。
// 生产当前只开口令登录且未配免密 key，不套 sshpass 会卡在交互输入口令而失败。
const SSHPASS = process.env.SSHPASS || '';
const SSH_CMD = SSHPASS ? `sshpass -p ${SSHPASS} ssh ${SSH_OPTS.join(' ')}`.trim() : `ssh ${SSH_OPTS.join(' ')}`;

// 同步范围：与 W1-④ 部署清单一致（public/、server.js、lib/、tools/）。
// 不动 node_modules、不动 .env、不动 package.json（远端非 git 仓库，依赖已就地安装）。
const SYNC_DIRS = ['public', 'lib', 'tools'];
const SYNC_FILES = ['server.js'];

const MODE = EXEC ? 'EXEC (真实执行)' : 'DRY_RUN (仅打印)';
console.log(`\n=== 辰箓 部署脚本 · ${MODE}${ROLLBACK ? ' · ROLLBACK (回滚)' : ''} ===`);
console.log(`   目标主机 : ${PROD_HOST}`);
console.log(`   远端路径 : ${PROD_PATH}`);
console.log(`   服务名   : ${SERVICE}`);
if (EXEC && ENV_SYNC) console.log('   ⚠  ENV_SYNC=1 → 将额外同步 .env');
if (EXEC && !ENV_SYNC) console.log('   · .env 默认不同步（独立步骤，见下方注释）');

// ── 安全执行封装 ──────────────────────────────────────────────────────────
// dry-run 下仅打印；exec 下真正运行。任何写操作都必须经由本函数。
function run(cmd, args = [], { pipe = false } = {}) {
  const raw = `${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  // 打印/日志脱敏：绝不把 SSHPASS 明文落到终端或 CI 日志里
  const full = SSHPASS ? raw.split(SSHPASS).join('******') : raw;
  if (!EXEC) {
    console.log(`  $ ${full}`);
    return { status: 0, stdout: '' };
  }
  console.log(`  ▶ ${full}`);
  const res = spawnSync(cmd, args, { stdio: pipe ? 'pipe' : 'inherit', cwd: ROOT });
  if (res.status !== 0 && res.error) console.error(`  ✗ 命令失败: ${res.error.message}`);
  return { status: res.status ?? (res.error ? 1 : 0), stdout: res.stdout?.toString() || '' };
}

/** 在本机执行只读命令（自检用，不触碰生产；当前自检由 statSync 承担，此入口保留给扩展）。 */
function local(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout?.toString() || '';
  }
}

/** 在远端执行 shell 脚本（不改变生产状态时亦可用于只读探查）。 */
function remote(script, { pipe = false } = {}) {
  const parts = [...SSH_OPTS, PROD_HOST, script];
  if (SSHPASS) return run('sshpass', ['-p', SSHPASS, 'ssh', ...parts], { pipe });
  return run('ssh', parts, { pipe });
}

/** rsync 通用封装：统一 -a -z，统一带 SSH_OPTS，且**不带 --delete**。 */
function rsync(src, dstDir, { pipe = false } = {}) {
  return run('rsync', ['-az', '-e', SSH_CMD, src, `${PROD_HOST}:${dstDir}`], { pipe });
}

// ── 0. 前置检查 ───────────────────────────────────────────────────────────
console.log('\n[0/5] 前置检查');
const nodeVer = process.versions.node;
const [major, minor] = nodeVer.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`  ✗ Node ${nodeVer} 过旧：需 ≥22.6（package.json 使用 --experimental-strip-types）。中止。`);
  process.exit(2);
}
console.log(`  ✓ Node ${nodeVer} (≥22.6)`);
for (const d of SYNC_DIRS) {
  try { statSync(join(ROOT, d)); } catch {
    console.error(`  ✗ 本地缺少待同步目录 ${d}/，中止。`); process.exit(2);
  }
}
for (const f of SYNC_FILES) {
  try { statSync(join(ROOT, f)); } catch {
    console.error(`  ✗ 本地缺少待同步文件 ${f}，中止。`); process.exit(2);
  }
}
console.log(`  ✓ 本地待同步内容齐全: ${[...SYNC_DIRS, ...SYNC_FILES].join(', ')}`);

// ── 1. 语法校验 (node --check) ─────────────────────────────────────────────
console.log('\n[1/5] 语法校验 node --check（仅本地只读，生产零触碰）');
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

// ── 回滚模式（优先级最高，做完即退出）─────────────────────────────────────
if (ROLLBACK) {
  console.log('\n[回滚] 用最近一版快照还原');
  console.log(`  # 快照位置：${SNAP_PREFIX}<YYYYmmdd-HHMMSS>/，最近一版记录在 ${SNAP_LATEST}`);
  console.log('  # 说明：快照只含 public/ lib/ tools/ server.js 四项（部署同步范围）；');
  console.log('  #       node_modules / .env 不在同步范围，回滚不受影响。');
  console.log('  # 注意：回滚同样不带 --delete —— 它会把被覆盖的文件还原回快照版本，');
  console.log('  #       但不会删除错误版本「新增」的文件；如需彻底清除请人工核对后 rm。');

  let snap = '';
  if (EXEC) {
    const r = remote(`cat ${SNAP_LATEST} 2>/dev/null || true`, { pipe: true });
    snap = (r.stdout || '').trim().split('\n')[0].trim();
  } else {
    snap = `${SNAP_PREFIX}<YYYYmmdd-HHMMSS>`; // dry-run 下用占位符展示步骤
  }
  if (EXEC && !snap) {
    console.error(`  ✗ 未找到快照（${SNAP_LATEST} 为空或不存在），无法回滚。`);
    process.exit(4);
  }
  // 防御：只允许形如 <PROD_PATH>.bak.<8位日期>-<6位时间> 的路径，避免误伤其它目录
  if (EXEC && !new RegExp(`^${PROD_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak\\.\\d{8}-\\d{6}$`).test(snap)) {
    console.error(`  ✗ 快照路径异常（${snap}），拒绝回滚以避免误操作。`);
    process.exit(4);
  }
  console.log(`  · 将使用快照：${snap}`);
  const r1 = remote(`test -d "${snap}" && echo EXISTS || echo MISSING`, { pipe: true });
  if (EXEC && !String(r1.stdout || '').includes('EXISTS')) {
    console.error(`  ✗ 快照目录不存在：${snap}，无法回滚。`);
    process.exit(4);
  }

  for (const d of SYNC_DIRS) rsync(`${snap}/${d}/`, `${PROD_PATH}/${d}/`);
  for (const f of SYNC_FILES) rsync(`${snap}/${f}`, `${PROD_PATH}/${f}`);
  remote(`systemctl restart ${SERVICE} && sleep 2 && systemctl is-active ${SERVICE}`);
  remote(`curl -fsS --max-time 15 ${HEALTH_URL}`);

  console.log('\n=== 回滚完成 ===');
  if (!EXEC) {
    console.log('   当前为 DRY_RUN：以上回滚命令未真正执行。');
    console.log('   确认无误后运行：DEPLOY_EXEC=1 node tools/deploy.mjs --rollback');
  }
  process.exit(0);
}

// ── 2. 远端快照（回滚的唯一凭据，rsync 之前执行）──────────────────────────
console.log('\n[2/5] 远端快照（覆盖前留一版，保留最近 1 版）');
console.log(`  # 生产 ${PROD_PATH} 非 git 仓库，快照是唯一的回滚凭据。`);
// 只备份本次会覆盖的目标，避免把 node_modules 也复制一遍（体积大、且不在同步范围）
const snapScript = [
  `SNAP=${SNAP_PREFIX}$(date +%Y%m%d-%H%M%S)`,
  'mkdir -p "$SNAP"',
  ...SYNC_DIRS.map((d) => `if [ -d ${PROD_PATH}/${d} ]; then cp -a ${PROD_PATH}/${d} "$SNAP"/; fi`),
  ...SYNC_FILES.map((f) => `if [ -f ${PROD_PATH}/${f} ]; then cp -a ${PROD_PATH}/${f} "$SNAP"/; fi`),
  // 先写临时文件再 mv，保证 .latest 始终是完整快照（不会出现指向半成品的窗口）
  'echo "$SNAP" > "$SNAP.latest.tmp" && mv -f "$SNAP.latest.tmp" ' + SNAP_LATEST,
  'echo "SNAPSHOT=$SNAP"',
  // 只保留最近一版：列出所有合规快照目录，按字典序（时间戳单调）去掉最后一版以外的
  `ls -1d ${SNAP_PREFIX}* 2>/dev/null | grep -E '^${SNAP_PREFIX}[0-9]{8}-[0-9]{6}$' | sort | head -n -1 | while read d; do rm -rf "$d"; echo "PRUNED=$d"; done`,
].join('\n');
const snapRes = remote(snapScript, { pipe: true });
if (EXEC) {
  const line = String(snapRes.stdout || '').split('\n').find((l) => l.startsWith('SNAPSHOT='));
  if (snapRes.status !== 0 || !line) {
    console.error('  ✗ 快照失败：没有拿到 SNAPSHOT 路径。为安全起见中止部署（无快照不 deploy）。');
    process.exit(5);
  }
  console.log(`  ✓ ${line.trim()}`);
  for (const l of String(snapRes.stdout || '').split('\n')) {
    if (l.startsWith('PRUNED=')) console.log(`  · 清理旧快照 ${l.slice(7)}`);
  }
} else {
  console.log('  · (DRY_RUN) 将创建快照并清理更早版本，仅留最近一版');
}

// ── 3. 同步代码到生产 (rsync，不带 --delete) ───────────────────────────────
console.log('\n[3/5] 同步代码到生产 (rsync -az，不带 --delete)');
console.log('  # 不带 --delete：远端非 git 仓库，误删无版本库可救；多余文件由人工/快照处理。');
// 生产 SSH 偶发 "Permission denied"（限流）/ "Operation timed out"：重试 + 退避。
// 同步失败绝不能静默放过——否则会留下「部分部署」的不一致状态（本次 W1 部署已真实踩到：
// lib/ 一项超时但脚本继续往下走并重启了服务）。故：失败重试，重试仍失败则中止并提示回滚。
const RSYNC_TRIES = Number(process.env.RSYNC_TRIES || 3);
const RSYNC_BACKOFF_SEC = Number(process.env.RSYNC_BACKOFF_SEC || 10);
function rsyncRetry(src, dstDir) {
  for (let i = 1; i <= RSYNC_TRIES; i++) {
    const r = rsync(src, dstDir);
    if (r.status === 0) return r;
    if (i < RSYNC_TRIES) {
      console.warn(`  ! 同步失败（第 ${i}/${RSYNC_TRIES} 次）：${src} → 退避 ${RSYNC_BACKOFF_SEC}s 后重试`);
      spawnSync('sleep', [String(RSYNC_BACKOFF_SEC)]);
    }
  }
  console.error(`  ✗ 同步失败（已重试 ${RSYNC_TRIES} 次）：${src}`);
  return { status: 1, stdout: '' };
}

let syncFail = 0;
for (const d of SYNC_DIRS) if (rsyncRetry(`${d}/`, `${PROD_PATH}/${d}/`).status !== 0) syncFail++;
for (const f of SYNC_FILES) if (rsyncRetry(f, `${PROD_PATH}/${f}`).status !== 0) syncFail++;
if (syncFail > 0) {
  console.error(`\n  ✗ ${syncFail} 项同步失败：生产已处于「部分部署」不一致状态，已中止后续重启。`);
  console.error('     处理：退避后重跑本脚本（rsync 幂等，会补齐缺失项）；');
  console.error('     若已重启并需撤销：DEPLOY_EXEC=1 node tools/deploy.mjs --rollback');
  process.exit(6);
}
console.log(`  ✓ ${SYNC_DIRS.length + SYNC_FILES.length} 项同步完成`);

// .env 是独立安全步骤：默认不同步，需 ENV_SYNC=1 显式开启
console.log('\n  # —— .env 是独立步骤，默认不同步（含密钥，需单独授权） ——');
if (EXEC && ENV_SYNC) {
  rsync('.env', `${PROD_PATH}/.env`);
} else {
  console.log(`  # 如需同步：${EXEC ? 'ENV_SYNC=1 ' : ''}rsync -az -e "${SSHPASS ? SSH_CMD.split(SSHPASS).join('******') : SSH_CMD}" .env ${PROD_HOST}:${PROD_PATH}/.env`);
  console.log('  # 生产 .env 必须含: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PORT ICP_NO，以及 LLM 预设(经 admin)。');
}

// ── 4. 重启 systemd 服务（远端） ───────────────────────────────────────────
console.log(`\n[4/5] 重启服务 (ssh → systemctl restart ${SERVICE})`);
remote(`systemctl restart ${SERVICE} && sleep 2 && systemctl is-active ${SERVICE}`);

// ── 5. 健康检查（在远端 curl，避免 8787 未对外暴露导致误判）────────────────
console.log(`\n[5/5] 健康检查 (远端 curl ${HEALTH_URL})`);
remote(`curl -fsS --max-time 15 ${HEALTH_URL}`);

console.log('\n=== 完成 ===');
if (!EXEC) {
  console.log('   当前为 DRY_RUN：以上命令未真正执行。');
  console.log('   确认无误后运行：DEPLOY_EXEC=1 node tools/deploy.mjs');
}
console.log('   如需回滚：DEPLOY_EXEC=1 node tools/deploy.mjs --rollback（还原最近一版快照并重启）');
process.exit(0);
