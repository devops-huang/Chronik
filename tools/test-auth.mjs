// tools/test-auth.mjs
// 测试对象：lib/db.js 的 hashPassword / verifyPassword（R0 认证修复）
// 运行：node tools/test-auth.mjs
// 依赖：主程修复 lib/db.js 的伪同步 scryptSync 后，4 条断言应全部通过。
// 失败策略：任意断言失败即 process.exit(1)。

import assert from 'node:assert';
import { hashPassword, verifyPassword } from '../lib/db.js';

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

try {
  const h = hashPassword('correct-horse');

  // 1) 正确密码 → true
  assert.strictEqual(verifyPassword('correct-horse', h), true, '正确密码应校验通过');
  console.log('✅ 正确密码 verifyPassword === true');

  // 2) 错误密码 → false
  assert.strictEqual(verifyPassword('wrong', h), false, '错误密码应被拒绝');
  console.log('✅ 错误密码 verifyPassword === false');

  // 3) 空密码 → false
  assert.strictEqual(verifyPassword('', h), false, '空密码应被拒绝');
  console.log('✅ 空密码 verifyPassword === false');

  // 4) 乱码/特殊字符密码 → false
  assert.strictEqual(verifyPassword('乱码@#$', h), false, '乱码密码应被拒绝');
  console.log('✅ 乱码密码 verifyPassword === false');

  console.log('\n🎉 test-auth 全部断言通过（4/4）。');
  process.exit(0);
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
