#!/usr/bin/env node
/**
 * 辰箓 Chronik · 每日数据库备份（C7）
 *
 * 复用 cleanup-orphans.mjs 的 .env 加载写法；调用系统 pg_dump（非 Node 依赖）
 * 将全量备份 gzip 落 /opt/bazi-system/backups/YYYY-MM-DD.sql.gz，并删除 >7 天的旧档。
 *
 * fail-open：任何异常仅 console.error + process.exitCode=1，绝不阻断主进程
 * （主进程通过 setInterval 兜底调用本脚本；本脚本自身异常也不影响线上服务）。
 *
 * 运行：node tools/backup-daily.mjs
 *   依赖：.env（PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE）或系统环境变量；
 *         系统已安装 pg_dump（生产盒默认具备，非 Node 依赖）。
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFile } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/bazi-system/backups';
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 7);

// ── 加载 .env（仅补充，不覆盖已存在的环境变量）──
try {
  const txt = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 无 .env 则全部依赖 process.env */ }

const PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: process.env.PGPORT || '5432',
  user: process.env.PGUSER || 'chenlu',
  password: process.env.PGPASSWORD || 'chenlu',
  database: process.env.PGDATABASE || 'chenlu',
};

function fail(msg, e) {
  console.error('[backup] ' + msg + (e ? '：' + e.message : ''));
  process.exitCode = 1;
}

/** Asia/Shanghai 本地日期戳（YYYY-MM-DD），与全站自然日口径一致。 */
function dateStamp(d = new Date()) {
  const sh = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
  return sh.toISOString().slice(0, 10);
}

(async () => {
  try {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = dateStamp();
    const outFile = join(BACKUP_DIR, `${stamp}.sql`);
    const gzFile = outFile + '.gz';

    // pg_dump → 临时 sql → gzip → 落盘（复用系统客户端，零新依赖）
    const tmpSql = outFile + '.tmp';
    await new Promise((resolveExec, rejectExec) => {
      execFile(
        'pg_dump',
        ['-h', PG.host, '-p', String(PG.port), '-U', PG.user, '-d', PG.database,
         '-f', tmpSql, '-F', 'p', '--no-owner', '--no-privileges'],
        { env: { ...process.env, PGPASSWORD: PG.password } },
        (err) => (err ? rejectExec(err) : resolveExec()),
      );
    });

    const sql = readFileSync(tmpSql);
    writeFileSync(gzFile, gzipSync(sql));
    try { unlinkSync(tmpSql); } catch { /* 临时文件清理失败不致命 */ }
    console.log(`[backup] 备份完成：${gzFile}（${Math.round(gzFile.length ? 0 : sql.length / 1024)} KB）`);

    // 保留 7 天：删除超过 RETENTION_DAYS 天的旧档
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const f of readdirSync(BACKUP_DIR)) {
      if (!/\.sql\.gz$/.test(f)) continue;
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.sql\.gz$/);
      if (!m) continue;
      try {
        const d = new Date(m[1] + 'T00:00:00+08:00').getTime();
        if (d < cutoff) { unlinkSync(join(BACKUP_DIR, f)); console.log(`[backup] 清理过期备份：${f}`); }
      } catch (e) { console.warn('[backup] 清理失败（跳过）：', f, e.message); }
    }
  } catch (e) {
    fail('备份失败', e);
  }
})();
