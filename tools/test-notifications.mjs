// tools/test-notifications.mjs
// I2 站内信/留存功能回归用例（交付工程师回归脚本，非业务源码）。
// 设计为健壮、fail-open：每项独立 try/catch，单点失败不中断整轮；结果明确统计 PASS/FAIL。
// 运行：cd /opt/bazi-system && set -a && . ./.env && set +a && node tools/test-notifications.mjs
import { query } from '../lib/db.js';

const BASE = process.env.BASE_URL || 'http://localhost:8787';
let pass = 0;
let fail = 0;

/**
 * 记录单条断言结果。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} detail 附加信息
 */
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ' :: ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

/**
 * 发送 HTTP 请求并返回状态码（网络错误返回字符串标记）。
 * @param {string} method
 * @param {string} path
 * @param {object|null} body
 * @returns {Promise<string|number>}
 */
async function httpStatus(method, path, body = null) {
  try {
    const opts = { method, headers: {} };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    return res.status;
  } catch (e) {
    return 'ERR:' + (e && e.message ? e.message : String(e));
  }
}

async function main() {
  // ① notifications 表存在（幂等 DDL 由 initSchema 自动建立）
  try {
    const r = await query("SELECT to_regclass('public.notifications') AS t");
    const exists = !!(r.rows[0] && r.rows[0].t);
    check('① notifications 表已建立', exists, JSON.stringify(r.rows[0] || null));
  } catch (e) {
    check('① notifications 表已建立', false, String((e && e.message) || e));
  }

  // ② 未授权访问 /api/notifications 必须被拦截（期望 401）
  const code401 = await httpStatus('GET', '/api/notifications');
  check('② 未授权 GET /api/notifications 返 401', code401 === 401, 'got=' + code401);

  // ③ TRACK_ACTIONS 须接受新增的 recall_open（期望 200，验证召回埋点已落地）
  const codeTrack = await httpStatus('POST', '/api/track', {
    action: 'recall_open',
    payload: { ref: 'test' },
  });
  check('③ POST /api/track recall_open 返 200', codeTrack === 200, 'got=' + codeTrack);

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
