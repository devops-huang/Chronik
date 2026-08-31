// 生成中国城市经纬度数据集：合并地级市 + 直辖县级市，缺失的用 Nominatim 取经度。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXT_PATH = join(ROOT, 'data', 'cities-extended.json');

// 省直辖县级市 / 直辖县（不在地级市列表里，需单独补齐）
const COUNTY = [
  '济源市','仙桃市','潜江市','天门市','神农架林区',
  '义乌市','昆山市','江阴市','张家港市','常熟市','太仓市','慈溪市','余姚市','海宁市','桐乡市','诸暨市','瑞安市','乐清市','温岭市','玉环市','龙港市',
  '邳州市','新沂市','溧阳市','启东市','如皋市','海安市','东台市','高邮市','仪征市','丹阳市','扬中市','句容市','兴化市','靖江市','泰兴市','如东县',
  '滕州市','荣成市','胶州市','即墨区','莱州市','招远市','平度市','莱西市','青州市','寿光市',
  '安宁市','大理市','澄江市','弥勒市','芒市','瑞丽市',
  '共青城市','瑞金市','龙南市','丰城市','樟树市','高安市',
  '石狮市','晋江市','南安市','福清市','长乐区','龙海区','福安市','福鼎市',
  '琼海市','文昌市','万宁市','东方市','五指山市','儋州市',
  '岑溪市','桂平市','北流市','东兴市','凭祥市','合山市','靖西市','荔浦市','平果市',
  '沙河市','南宫市','辛集市','晋州市','新乐市','定州市','安国市','高碑店市','涿州市','泊头市','任丘市','黄骅市','河间市','霸州市','三河市','深州市','武安市','滦州市','迁安市','遵化市',
  '鲅鱼圈区','高港区','赣榆区','大丰区','江都区','通州区','海门区','通海县',
];

// 读取现有 extended（保留已验证坐标）
function loadExt() {
  if (!existsSync(EXT_PATH)) return {};
  try { return require(EXT_PATH).cities || {}; } catch { return {}; }
}

// 读取 province-city-china 地级市名
function loadPrefecture() {
  try {
    const c = require('/Users/edwardhuang/.workbuddy/binaries/node/workspace/node_modules/province-city-china/dist/city.json');
    return c.map((x) => x.name).filter(Boolean);
  } catch { return []; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geo(name) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1&accept-language=zh&countrycodes=cn`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'ChenLu-Bazi/1.0 (astro-tools)' } });
      if (r.status === 429) { await sleep(5000); continue; }
      if (!r.ok) { await sleep(1500); continue; }
      const j = await r.json();
      const hit = j[0];
      if (hit && hit.lon !== undefined) return parseFloat(hit.lon);
      return null;
    } catch {
      await sleep(2000);
    }
  }
  return null;
}

(async () => {
  const ext = loadExt();
  const pref = loadPrefecture();
  const names = Array.from(new Set([...pref, ...COUNTY, ...Object.keys(ext)]));
  let added = 0, skipped = 0;
  for (const name of names) {
    if (ext[name] !== undefined) { skipped++; continue; }
    const lng = await geo(name);
    if (lng !== null && Number.isFinite(lng)) {
      ext[name] = +lng.toFixed(2);
      added++;
      if (added % 20 === 0) console.log(`[progress] added=${added} name=${name} lng=${ext[name]}`);
    } else {
      console.log(`[miss] ${name}`);
    }
    await sleep(1100); // Nominatim 限速 ~1 req/s
  }
  writeFileSync(EXT_PATH, JSON.stringify({ cities: ext }, null, 2));
  console.log(`DONE added=${added} skipped=${skipped} total=${Object.keys(ext).length}`);
})();
