# 辰箓 Chronik v6.3.0 · 验收清单（Quality Gates）

> 质量工程师（QE）交付物之一。本清单把 **Charter §5 门禁与 V1–V6**、**需求说明书「可观测验收」**、**Charter §8 前五风险**逐条映射为可勾选的检查项，并标注每项由哪种手段验证（`curl` / `SQL` / `UI` / 单元）以及对应的自动化检查（`tools/qa-gates.mjs` 的检查 ID）。
>
> 配套交付：`tools/qa-gates.mjs`（只读运行中的服务 + DB，不改源码）自动跑检查并输出 `PASS/FAIL/SKIP`。

---

## 0. 怎么用

```bash
# 默认连 http://127.0.0.1:8787，PG 用 .env 同款变量
cd /tmp/chronik-merge
BASE_URL=http://127.0.0.1:8787 \
  PGHOST=127.0.0.1 PGPORT=5432 PGUSER=chenlu PGPASSWORD=chenlu PGDATABASE=chenlu \
  node tools/qa-gates.mjs

# 需要进行「需登录/破坏性/重配置」类检查时补充环境变量：
QA_TEST_USER=xxx QA_TEST_PASS=yyy          # R0 / R6†(可选) 需要的真实账号
QA_DESTRUCTIVE=1                            # R2† 注销回执六表计数 0 的实战验证（会建+删临时账号）
QA_R5A_RECONFIGURE=1 QA_ADMIN_TOKEN=zzz    # R5a 临时把 LLM baseUrl 指向无效地址（测完还原）
QA_TEST_CHART=123                           # R6† 可选：用该 chart 验证 12 月数据
```

退出码：`0` = 无 `FAIL`（可含 `SKIP`）；`1` = 存在 `FAIL`。

**状态语义**
- `PASS`：检查已执行且达标。
- `FAIL`：检查已执行但不达标（门禁未过，必须修）。
- `SKIP`：前置条件未满足，无法评估（操作员按「前置条件」列补环境后重跑）。

> 注意：当前仓库为 v6.2.0 基线，多数 v6.3.0 能力（/api/health、content-policy、funnel.mjs、/api/config 摘敏、安全头、年历页等）尚未实现，跑脚本会得到预期内的 `FAIL`——这正是门禁的意义。脚本只**读**服务与 DB，不改动任何源码。

---

## 1. 门禁 / 合规红线 ↔ 需求 总映射

| 门禁 / 合规项 | 性质 | 覆盖需求 | 不达标后果 |
|---|---|---|---|
| **G1-min** 解除「不可推广」 | 发布前置 | R0 / R10a / R1† / R2† / R5a | 任一未绿不得对外投放 |
| **G1** 可观测 | 发布前置 | R4† / R3 / 六表删除脚本 | 线上≠HEAD 或看不见用户 = 不通过 |
| **G3** 留存钩子（红线 4.5 周） | 完整版 | R6† | 触及 9.0 人日时 R6† 可被降级剪裁 |
| **V1** 数据权利闭环 | 一票否决 | R2† | 合规否决 |
| **V2** 孤儿数据删除完整性 | 一票否决（硬门槛） | R2† | 六表任一非零即 DCP 不通过 |
| **V3** 免责 + 内容护栏 | 一票否决 | R1† / R5a / R6† | 合规否决 |
| **V4** HTTPS 生效 | 一票否决 | R10a / R4† | 合规否决 |
| **V5** 生成式 AI 备案评估 | **不阻塞发布** | 并行 N/V5 | 只决定 AI 答疑交付形态 |
| **V6** PIA + 委托协议 | 文档交付（非运行时门禁） | N9 | 合规否决（交付物审查） |

---

## 2. 逐项可观测验收（可勾选）

图例：验证方式 `C`=curl/HTTP `S`=SQL `U`=UI/人工 `T`=单元/单测。检查 ID 对应 `qa-gates.mjs` 内的 `R0 / R10a / R1† / R2† / R4† / R3 / R5a / R6†`。

### R0 · 认证修复（P0·站外，安全，不计入版本人日）
- [ ] **R0-1** 错误密码登录返回 400 / 错误，不能登录成功（任意密码不可登任意账号）　`C` · 检查 `R0` · 前置：`QA_TEST_USER`/`QA_TEST_PASS`
- [ ] **R0-2**（佐证）正确密码仍返回 200 + 用户对象，未误杀合法登录　`C` · 检查 `R0` · 前置：同上
- [ ] **R0-3**（单测，研发总监实测）`verifyPassword` 对正确/错误/空/乱码 四种密码 = true/false/false/false　`T` · `tools/test-auth.mjs`（非本脚本范围，人工跑）
- [ ] **R0-4** 全量密码重置通道可用，旧 hash 全部失效　`S`/`U` · 人工（SELECT 验证 `password` 已不可 `verify`）

### R10a · 推广就绪安全修复（G1-min，V4）
- [ ] **R10a-1** `GET /api/config`（未登录）响应体**不含** `baseUrl`、`adminConfigured`　`C` · 检查 `R10a`
- [ ] **R10a-2** 响应头含 `Strict-Transport-Security` / `Content-Security-Policy` / `X-Content-Type-Options: nosniff` / `Referrer-Policy`　`C` · 检查 `R10a`
- [ ] **R10a-3**（UI）前端页脚含备案号占位 `<span id="icp-no">` 并由 /api/config 的 `icpNo` 填充　`U` · 人工

### R1† · 免责声明 → 内容安全闭环（G1-min，V3）
- [ ] **R1-1**（单元）`lib/content-policy.js` 导出 `BLOCKLIST` 与 `getRefusal`，且能拦截违规样本　`T` · 检查 `R1†`（动态 import 模块）
- [ ] **R1-2**（HTTP）用 BLOCKLIST 样本打 `/api/chat` 被拦截（拒答/错误事件，非正常回答）　`C` · 检查 `R1†` · 前置：LLM 已配置（否则该检查 SKIP）
- [ ] **R1-3**（UI）L1 页脚+首页首屏下 / L2 报告页眉页脚 / L3 会话首条+流式尾注 / L4 命中触发拒答 四层齐备　`U` · 人工
- [ ] **R1-4**（UI）报告与 AI 回答显著位置「AI 生成」标识　`U` · 人工
- [ ] **R1-5**（UI+SQL）页脚举报入口可提交；`ai_audit` 落库（input/output/时间/用户标识）≥6 月　`U`/`S` · 人工 + `SELECT count FROM ai_audit`

### R2† · 隐私政策 + 数据权利闭环（G1-min，V1+V2）
- [ ] **R2-1（V2 硬门槛）** 孤儿 TTL：`charts/conversations/messages/fortune_events/anon_chart_rate` 中 `user_id IS NULL AND created_at < now()-30d` 计数全 0（`anon_chat_rate` 当前无时间字段，列为 INFO）　`S` · 检查 `R2†`（孤儿 TTL 子项，常开/只读）
- [ ] **R2-2（V2 硬门槛）** 注销后六表计数全 0：游客排盘→登录合并→注销后 `user_id=X OR anon_id∈{A}` 相关计数 = 0　`S` · 检查 `R2†`（注销回执子项，`QA_DESTRUCTIVE=1` 实战）
- [ ] **R2-3** `POST /api/me/delete` 返回回执 `{charts,conversations,messages,fortune_events,anon_chart_rate,anon_chat_rate}` 且与删除前计数一致　`C`/`S` · 检查 `R2†`
- [ ] **R2-4**（UI）隐私政策页覆盖 PIPL 第17条六类告知项 + 每类保存期限 + 委托处理/出境/权利专章　`U` · 检查 `R2†`（隐私页存在性子项）
- [ ] **R2-5**（UI）注册明示同意非默认勾选、不与用户协议合并；同意落 `user_agreements`　`U`/`S` · 人工
- [ ] **R2-6**（UI/C）`POST /api/me/export` 返回 JSON 五表联表序列化　`C` · 人工

### R5a · LLM 降级兜底（检索式）（G1-min，V3）
- [ ] **R5a-1** 把 LLM `baseUrl` 指向无效地址后，`/api/chat` 在 **3s 内**返回检索式降级卡片（命盘相关段落 + 重试 + **L2 免责「娱乐参考」**），非 500 / 白屏 / 静默空白　`C` · 检查 `R5a` · 前置：baseUrl 已无效（或 `QA_R5A_RECONFIGURE=1`+`QA_ADMIN_TOKEN`）
- [ ] **R5a-2**（人工）上游超时 `AbortSignal.timeout(30000)` 内中止　`C` · 人工

### R4† · 部署脚本 + HTTPS + /api/health（G1，V4）
- [ ] **R4-1** `GET /api/health` 返回 `{ok:true, version, commit}` 且 `commit == git rev-parse --short HEAD`　`C`+`T` · 检查 `R4†`
- [ ] **R4-2**（infra）443 证书有效、HTTP→HTTPS 301；`cl_sid` cookie 带 `Secure`+`SameSite`　`C` · 人工（`curl -I https://...`）
- [ ] **R4-3** `tools/deploy.mjs` 已用于 ≥3 次真实上线，`deploy-log.json` 留存 ≥3 条且 health 版本=HEAD　`U`/`S` · 人工
- [ ] **R4-4** `/api/config` 无 `baseUrl`/`adminConfigured`（同 R10a）　`C` · 检查 `R10a`

### R3 · 埋点（审计 + 漏斗）（G1）
- [ ] **R3-1** `tools/funnel.mjs` 可运行并 30s 内输出五段漏斗（访问→排盘→报告→首问→注册）+ 报告→注册转化率　`C`/`S` · 检查 `R3`
- [ ] **R3-2**（SQL）审计三类入库：同意记录 `user_agreements`、删除审计、`ai_audit`　`S` · 检查 `R2†`/`R1†` 关联
- [ ] **R3-3**（SQL）版本期间累计真实排盘事件 ≥100（链路在真实流量下通）　`S` · 人工（`SELECT count FROM fortune_events`）

### R6† · 流年年历（G3，V3）
- [ ] **R6-1**（前端）年历页/视图存在且含「娱乐参考」角标（图标 + 顶部 L1 + 底部图例，不可 CSS 隐藏）　`U` · 检查 `R6†`（文件扫描子项）
- [ ] **R6-2**（API）`/api/charts/:id` 的 `interpret.allMonths` 返回 ≥12 月数据　`C` · 检查 `R6†`（可选 `QA_TEST_CHART`）
- [ ] **R6-3**（UI）12 月渲染 + 吉凶色阶 + 流年干支切换 + 窗口外兜底 + 老数据缺 allMonths 不报错　`U` · 人工
- [ ] **R6-4**（UI）`/index.html` 常驻「本月流月吉凶」卡片，点击进年历　`U` · 人工

---

## 3. V5 / V6（不阻塞发布 / 文档交付）

| 项 | 验收口径 | 验证方式 | 是否阻塞 |
|---|---|---|---|
| **V5** 生成式 AI 备案评估 | 三选一：① 属地口径「无需备案」→ 自由提供；② 已提交申报并取得受理回执 → 受限访问发布；③ 均无 → 走降级（BYOK / 默认规则引擎） | 文档/回执审查 | **不阻塞** |
| **V6** PIA + 委托处理协议（N9） | PIA 报告（目的/合法性基础/信息种类/流程图/影响/风险/措施，留存 3 年，PIPL 55/56）+ 与阿里云百炼确认委托处理条款覆盖目的/期限/方式/种类/措施/权责 | 文档交付审查 | 一票否决（交付物） |

> 这两项为**文档/流程交付**，非运行时门禁，`qa-gates.mjs` 不自动验证，仅在清单中留痕供合规审查。

---

## 4. Charter §8 前五风险 ↔ 缓解需求映射

| # | 风险 | 对应需求 / 缓解 | 关联检查 |
|---|---|---|---|
| 1 | 备案早于 G1-min 通过 → 推广裸奔窗口 | R10a（摘敏+安全头）、R5a（前置防 AI 全挂）、R10b（备案触发 24h，人工） | `R10a` / `R5a` |
| 2 | 孤儿数据未清 → PIPL 第47/69 条 | R2† +0.5–1.0 专项；六表删除验证脚本；删除回执 | `R2†`（V2 硬门槛） |
| 3 | AI 输出失控（一次输出毁产品） | R1† 输出过滤与留痕同时上线 | `R1†` |
| 4 | 合规件做了没上线（线上跑旧代码） | R4† 排第一；`/api/health` 版本号 = HEAD | `R4†` |
| 5 | 单人兼职重启开销被低估 | 严格串行门禁；每门禁开工前 design note；R4 让发布成本趋零 | 流程（本清单） |

---

## 5. 脚本检查项 ↔ 本文档检查项 速查

| qa-gates.mjs 检查 ID | 涵盖文档项 | 默认是否只读 | 前置条件 |
|---|---|---|---|
| `R0` | R0-1, R0-2 | 是（仅登录尝试） | `QA_TEST_USER`/`QA_TEST_PASS` |
| `R10a` | R10a-1, R10a-2 | 是 | 服务可达 |
| `R1†` | R1-1, R1-2 | 是 | LLM 已配置（HTTP 子项）；模块存在（单元子项） |
| `R2†` | R2-1, R2-2, R2-3, R2-4 | 孤儿 TTL 只读；注销回执需 `QA_DESTRUCTIVE=1` | PG 连接；`QA_DESTRUCTIVE` 可选 |
| `R4†` | R4-1 | 是 | 服务可达 + git 仓库 |
| `R3` | R3-1 | 是（运行 funnel.mjs 读 DB） | `tools/funnel.mjs` 存在 + PG |
| `R5a` | R5a-1 | 是（检测降级态）；重配置需 `QA_R5A_RECONFIGURE` | baseUrl 已无效 或 `QA_ADMIN_TOKEN` |
| `R6†` | R6-1, R6-2 | 是（文件扫描 + 可选 API） | `QA_TEST_CHART` 可选 |

---

*—— QE 验收清单 v1.0 ｜ 配套 `tools/qa-gates.mjs`。所有检查只读运行中的服务与 DB，不修改任何源码。*
