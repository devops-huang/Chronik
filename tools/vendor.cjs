/**
 * 将技能里的 CLI 脚本 queryFortuneRange.ts 改造为可复用的库模块。
 * 原始脚本从 process.argv 读取参数并输出 Markdown；这里把主流程包进
 * 导出函数 queryFortuneRange()，改为返回结构化对象，供 Web 服务直接消费。
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'lib', '_raw_fortune.ts');
const out = path.join(__dirname, '..', 'lib', 'fortune.ts');

const lines = fs.readFileSync(src, 'utf8').split('\n');

// 定位主流程起点与终点
const startIdx = lines.findIndex((l) => l.startsWith('const input = parseInput(process.argv);'));
if (startIdx === -1) throw new Error('未找到主流程入口，原始脚本结构可能已变化');

const outEndIdx = lines.findIndex((l) => l.startsWith('console.log(buildMarkdownReport(output));'));
if (outEndIdx === -1) throw new Error('未找到输出语句，原始脚本结构可能已变化');

const head = lines.slice(0, startIdx);
const body = lines.slice(startIdx, outEndIdx);
const tail = lines.slice(outEndIdx + 1);

const result = [
  ...head,
  '',
  '/**',
  ' * 查询大运与流年 / 流月 / 流日 / 流时，返回结构化结果。',
  ' * 与原始 CLI 脚本的区别：不读 process.argv，不输出 Markdown，改为返回对象。',
  ' */',
  'export function queryFortuneRange(input: QueryInput): any {',
  // 主流程前两行需要保留但去掉 parseInput 依赖
  // body[0] 是 process.argv 取参语句，直接丢弃；后续语句统一缩进后纳入函数体
  ...body.slice(1).map((l) => (l.length ? '  ' + l : l)),
  '',
  '  return output;',
  '}',
  '',
  ...tail,
].join('\n');

fs.writeFileSync(out, result, 'utf8');
console.log('已生成 lib/fortune.ts');
