/**
 * 辰箓 · I2 留存调度器 · 可选 OS crontab 入口
 *
 * 作为 server.js 进程内定时器的补充：若未来用户量上来、需与主进程解耦时，
 * 可在 OS 层加一行 crontab（例如每日 03:17 跑一次）：
 *   17 3 * * * cd /opt/bazi-system && /usr/bin/node tools/scheduler-retention.mjs >> /var/log/chenlu-retention.log 2>&1
 *
 * 默认行为不变（server.js 仍由 setInterval 驱动）；本文件仅提供独立运行能力。
 * 复用 lib/retention.js 与 lib/db.js，单进程即跑即退，不常驻。
 */
import { runRetentionScan } from '../lib/retention.js';

runRetentionScan()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[retention] 调度器异常：', e && e.message);
    process.exit(1);
  });
