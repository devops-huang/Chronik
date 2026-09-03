# 辰箓 Chronik v6.3.0 · 实施计划（Implementation Plan）

> 版本：v1.0｜ 日期：2026-09-03｜ 作者：PM 子代理（依据 Charter 终稿 + 需求说明书 + 现码核对）
> 当前代码版本：`lib/../package.json` = **6.2.0**；目标版本 **6.3.0**。
> 用法：本文件是**逐条可执行**的交付物。每个需求的「技术锚点」均为对 `/tmp/chronik-merge` 源码的**真实核对结果**；编码助手按「设计笔记 → DoD → commit 粒度」顺序执行即可。
> 约束：只读源码、只写 `docs/`。所有改动在特性分支进行，禁止直接改 `main`。

---

## 0. 总实施顺序（按紧急度）

**铁律：单人串行，严禁并行开工。** 每个门禁开工前先写 1 页 design note（已在本文给出，可直接用）。

```
[站外·即时]  R0  认证修复（P0，不计入版本人日）
        │   └─ 必须单独上线，任何公网可访问之前完成
        ▼
R10a ──→ R1† ──→ R2† ──→ R5a          [G1-min · 解除「不可推广」]
        │
        ▼
R4†（先空部署验证 线上==HEAD）──→ R3     [G1 · 可观测]
        │
        ▼
R6†                                   [G3 · 留存钩子]
```

| 顺序 | 需求 | 人日 | 门禁 | 性质 | 备注 |
|---|---|---|---|---|---|
| 0 | **R0** 认证修复（站外） | 0.3 | 紧急·站外 | P0 安全 | 不计入 9.0，须最先单独发布 |
| 1 | **R10a** 推广就绪安全修复 | 0.3 | G1-min | 安全/合规 | |
| 2 | **R1†** 免责声明→内容安全闭环 | 1.0 | G1-min | V3 | |
| 3 | **R2†** 隐私政策+数据权利闭环 | 2.5 | G1-min | V1+V2 | 含孤儿 TTL |
| 4 | **R5a** LLM 检索式降级兜底 | 1.0 | G1-min | 可用性 | |
| 5 | **R4†** 部署脚本+HTTPS+/api/health | 1.5 | G1 | V4 | 先空部署 |
| 6 | **R3** 埋点（审计0.5+漏斗0.5） | 1.0 | G1 | 可观测 | 漏斗为第一砍减项 |
| 7 | **R6†** 流年年历 | 1.0 | G3 | 用户价值 | |
| — | 机动 buffer | 0.4 | — | — | |
| | **串行合计** | **9.0** | | | 容量上限 12 |

**并行（零串行成本，不占排期）**：N9 / V5（全程）；N10 / N8（G1 后插入）。
**事件驱动**：R10b（备案通过 24h 内）。

---

## 1. 设计笔记（每张 ≤1 页）

### R0 · 认证修复（P0 紧急，站外发布，0.3 人日）

**目标**：消除「任意密码可登录任意账号」的认证绕过；修复后强制全量密码重置。

**范围（Non-goals）**：不重构 session/cookie 机制、不做 2FA、不迁移其他哈希算法。

**技术锚点（已核对现码）**：
- `lib/db.js:52` 导入了真 `scrypt`，但 `:58-65` 自己又定义了一个**伪同步** `scryptSync`：`const out = Buffer.alloc(len)` 后调用**异步** `scrypt(...)`，回调里 `d.copy(out)` 在 `return out` **之后**才执行 → 永远返回全零 Buffer。`hashPassword`(`:53-57`) 与 `verifyPassword`(`:66-73`) 都调用这个伪函数，导致**所有存储的 key 都是 64 字节全零**、任何输入密码派生也都是全零 → `timingSafeEqual` 恒真 → 认证被完全绕过。
- `server.js:312` `SELECT title FROM charts WHERE id=$1`（在 `resolveConversation` 内）**无 `user_id`/`anon_id` 归属校验**，可枚举他人四柱标题（叠加 R0 即批量泄露精确出生时间+出生地+性别）。R0 修完后此 IDOR 仍须排期补归属（可并入 R2† 或单独小改，**本计划标记为高优 follow-up**）。

**可观测验收 DoD**：
- [ ] 单元测试 `tools/test-auth.mjs`：正确密码 `true`、错误密码 `false`、空密码 `false`、乱码 `false`（4 条断言全绿，`node:assert` + `process.exit(1)` 失败）。
- [ ] 全量密码重置：所有 `users.password` 失效，登录分支提示「请重置密码」；`POST /api/reset-password` 通道可用（发 token，邮件/站内）。
- [ ] 回归：原伪 `scryptSync` 函数已删除，仅用 `node:crypto` 的 `scryptSync`。

**建议 commit 粒度**：
1. `fix(auth): 用 node:crypto.scryptSync 替换伪同步实现 + 加 test-auth.mjs`
2. `fix(auth): 全量密码失效 + 重置通道 + 登录提示`

---

### R10a · 推广就绪安全修复（G1-min，0.3 人日）

**目标**：摘除 `/api/config` 泄露的内部端点；加基础安全响应头；预留页脚 ICP 备案号位。

**范围**：不含 443/HTTPS/DNS 打通（属 R10b）。

**技术锚点（已核对现码）**：
- `server.js:570-577` `/api/config`（免登录）返回 `llmPreset`/`adminConfigured`/`baseUrl`/`model`/`appName`。**必须摘除 `baseUrl` 与 `adminConfigured`**（PRD 要求项；`model` 亦属内部信息，建议一并摘除或仅留是否配置标志）。
- 安全头无统一出口：所有响应经 `sendJson`(`server.js:46-49`)/`serveStatic`(`server.js:81`)，目前均无 `Strict-Transport-Security`/`Content-Security-Policy`/`X-Content-Type-Options`/`Referrer-Policy`。建议在 `server.js` 顶部加 `applySecurityHeaders(res)` 并在两处出口调用；静态资源也可在 `infra/nginx/chronik.conf` 加（注意该文件 `:38-39` 的 HSTS **当前注释**）。
- 前端页脚：需在 `public/index.html` 与 `public/studio.html` 增加 `<span id="icp-no">备案号待填</span>`，由 `/api/config` 返回的 `icpNo` 字段填充。

**可观测验收 DoD**：
- [ ] `GET /api/config`（未登录）响应体**不含** `baseUrl`、`adminConfigured`（建议亦不含 `model`）。
- [ ] 响应头含 `Strict-Transport-Security` / `Content-Security-Policy: default-src 'self'` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer`。
- [ ] 页脚 `#icp-no` 渲染占位文案，能从 `/api/config.icpNo` 填充。

**建议 commit 粒度**：
1. `fix(security): /api/config 摘敏 baseUrl/adminConfigured(+model)`
2. `fix(security): 统一注入安全响应头 + 页脚 ICP 占位`

---

### R1† · 免责声明→内容安全闭环（G1-min，1.0 人日，V3）

**目标**：L1–L4 四层免责 + 系统提示词禁区 + **AI 输出侧关键词过滤** + AI 生成标识 + 投诉入口 + 输出留痕≥6 月。

**范围**：不含 LLM 能力改造；过滤规则与提示词须版本化管理（同仓库）。

**技术锚点（已核对现码）**：
- 新建 `lib/content-policy.js`：导出 `DISCLAIMER_L1/L2/L3/L4`、`BLOCKLIST` 正则（含插空绕过变体）、`getRefusal(category)`。
- 系统提示词注入点：`server.js:324`（`buildChatMessages` 内 `sysPrompt = chartContext || '...'`）与 `lib/core.js:24-41` `chartContextText`（首条带 L3 表述）。
- SSE 输出流：`server.js:395` `res.writeHead(200,...)` 之后**只能用 SSE 事件**；`server.js:405-424` `flush()` 中 `:415` 取 `delta.content` → 过滤须在这里对每个 `delta` 跑 `BLOCKLIST`，命中即中止该轮、下发 SSE `error` 事件（`:435` 已有 error 事件写法可复用）。
- 报告模板：`lib/report.js` 的 `buildReportHtml`（由 `lib/core.js:19` 调用）加独立 DOM 区块放 L2 页眉页脚，AI 不可覆盖；并标注「AI 生成」。
- 前端：在 `public/studio.js` 会话首条展示 L3、流式结束后固定 append L3 尾注。

**可观测验收 DoD**：
- [ ] L1（页脚+首页首屏下）、L2（报告页眉页脚）、L3（会话首条+流式尾注）、L4（命中 C/E/F/G/I/J 触发拒答）四层齐备。
- [ ] `tools/test-content-policy.mjs`：对 §6.1 每类构造 3 条，断言 100% 触发拒答（全绿）。
- [ ] 报告与 AI 回答显著位置「AI 生成」标识。
- [ ] 页脚举报入口可点击提交；AI 输出（input/output/时间/用户标识）落 `ai_audit` 表，保留≥6 月（定时删）。

**建议 commit 粒度**：
1. `feat(content): 新增 lib/content-policy.js（L1-L4/BLOCKLIST/拒答模板）`
2. `feat(content): SSE 输出侧过滤 + 系统提示词禁区 + L3 尾注`
3. `feat(content): 报告 L2 固定区块 + AI 生成标识 + 举报入口 + ai_audit 落库`

---

### R2† · 隐私政策+数据权利闭环（G1-min，2.5 人日，V1+V2）

**目标**：隐私政策（六类告知+每类保存期限+委托处理/出境/权利专章）+ 明示同意 + 同意记录 + 一键导出 + 一键删除返回可验证回执 + 孤儿数据 30 天 TTL（六表全覆盖）+ 双条件匹配 + 可复现验证脚本。

**范围**：含 `anon_chart_rate.ip` 明文脱敏/清理；含 cookie 7 天失联的游客 TTL；**不含 R7 profiles（延后）**。另须补 `server.js:312` 的 IDOR 归属校验（见 R0 follow-up）。

**技术锚点（已核对现码）**：
- 孤儿根源：`lib/schema.sql:43` `charts.user_id` 可空；`:48-52` `anon_chart_rate.ip` 明文、无 TTL、无 user 关联；`lib/auth.js:111` `ANON_TTL_DAYS=7`（仅 cookie 有效期，非数据 TTL）。
- 级联陷阱：`conversations.chart_id REFERENCES charts(id) ON DELETE CASCADE`(`schema.sql:65`) → 删除顺序错会级联丢数据，必须**先删子表再删父表**或依赖级联正确方向。
- 双条件删除：`user_id = $1 OR anon_id IN (SELECT anon_id FROM user_anon_link WHERE user_id=$1)`。须**新建 `user_anon_link` 表**留存「用户↔历史 anon_id」映射（注册合并时写入，注销时清理）。
- 六表：`charts`/`conversations`/`messages`/`fortune_events`/`anon_chart_rate`/`anon_chat_rate`。

**可观测验收 DoD（V2 硬门槛）**：
- [ ] `tools/test-gdpr.mjs`：① 游客 anon_id=A 排 N 条 → 登录合并 → 注销 → 断言六表 `user_id=X OR anon_id∈{A}` 计数=0；② 断言 `user_id IS NULL AND created_at<now()-30d` 计数=0；③ 回执与删除前计数一致。全绿才交付。
- [ ] 注销返回回执 `{charts,conversations,messages,fortune_events,anon_chart_rate,anon_chat_rate}` 且与删除前计数一致。
- [ ] 隐私政策页覆盖 PIPL 第17条全部告知项 + 每类保存期限；注册明示同意**非默认勾选**、不与用户协议合并；同意落 `user_agreements(user_id,version,agreed_at)`。
- [ ] `anon_chart_rate.ip` 哈希化或随 TTL 清理（隐私政策声明保留期）。
- [ ] `server.js:312` 标题查询加 `AND (user_id=$1 OR anon_id=$2)` 归属校验（并入本需求）。

**建议 commit 粒度**：
1. `feat(privacy): 隐私政策页 + 明示同意 + user_agreements 记录`
2. `feat(privacy): user_anon_link 表 + 导出/删除双条件 + 删除回执`
3. `feat(privacy): 孤儿数据 30 天 TTL 定时任务 + anon_chart_rate.ip 处理`
4. `test(privacy): tools/test-gdpr.mjs + 修 server.js:312 IDOR 归属校验`

---

### R5a · LLM 检索式降级兜底（G1-min，1.0 人日）

**目标**：LLM 额度耗尽/超时/报错时，AI 答疑 3s 内返回检索式兜底（带免责），不白屏不 500。

**范围**：**检索式兜底，非规则引擎兜底**。降级输出须带 L2 免责与「检索/规则生成」标识（V3 6.3.8）。

**技术锚点（已核对现码）**：
- 可用结构化数据：`charts.interpret` JSONB 已含 `domains`（分领域+points）、`liunian`、`allMonths`、`currentDayun`（写入 `server.js:222`，返回 `server.js:283`）。
- 硬失败判断位置：**必须在 `server.js:352` 配置检查之后、`server.js:395` `writeHead(200)` 之前**。当前 `:352` 已判 `baseUrl/apiKey/model` 缺失；需在此处追加「额度标记/探测失败」判断 → 直接返回检索式兜底（不走 SSE 或走 SSE error 事件）。
- 上游 fetch：`server.js:370-379` 加 `signal: AbortSignal.timeout(30000)`；`server.js:405-432` flush 循环外统计 `chunkN`，为 0 → 下发 error 事件「模型返回空响应」（当前 `:405-424` 静默丢弃，需补）。
- 兜底内容复用 `lib/content-policy.js` 的 L2（来自 R1†，须先于或同批完成）。

**可观测验收 DoD**：
- [ ] 模拟额度耗尽（上游指向无效 endpoint）：AI 答疑 3s 内返回检索式卡片（命盘相关段落 + 重试按钮 + L2 免责），无白屏/无 500/无静默空白。
- [ ] 上游超时 30s 内中止（AbortSignal.timeout 生效）。

**建议 commit 粒度**：
1. `feat(chat): 配置/额度探测前置 + 检索式兜底分支（writeHead 前）`
2. `feat(chat): 上游 AbortSignal.timeout + 空响应 error 事件 + 前端兜底卡片`

---

### R4† · 部署脚本+HTTPS+/api/health（G1，1.5 人日，V4）

**目标**：一键部署且线上==HEAD；`/api/health` 暴露版本号+commit；HTTPS 强制；cookie `Secure`/`SameSite`；修 setup-https.sh 死循环。

**范围**：含 systemd unit、Node 版本校验、回滚软链；不含 443 证书申请（R10b 备案触发，但两阶段脚本在此做）。

**技术锚点（已核对现码）**：
- 死循环根因（已核）：`infra/setup-https.sh` 第 2 步 `cp infra/nginx/chronik.conf /etc/nginx/conf.d/chronik.conf`（`:36` 附近），该 conf 的 443 server 块 `:28-29` 引用**尚不存在**的证书路径；随后第 3 步 `nginx -t`（`:64` 附近）因证书缺失**校验失败** → 脚本 `set -euo pipefail` 退出 → 第 4 步 certbot **永不执行**。须拆三阶段（80→certbot→443）。
- Node 版本门槛：`package.json:8` `node --experimental-strip-types server.js` 需 **Node≥22.6**。
- 无 systemd unit；无回滚机制（应保留上一版本目录 + 软链切换）。
- cookie：`lib/auth.js:17` `sessionCookie` 与 `server.js:551` `cookieFor` 当前 `HttpOnly; SameSite=Lax`**无 Secure**；`lib/auth.js:117` `anonCookie` 同理。须加 `Secure`（HTTPS 下生效）。

**可观测验收 DoD（V4）**：
- [ ] `tools/deploy.mjs` 已用于 ≥3 次真实上线；每次 `/api/health` 返 `{ok:true, version:"6.3.0", commit:"<hash>"}`，hash 与 `git rev-parse --short HEAD` 一致（留存 ≥3 条 `deploy-log.json`）。
- [ ] 443 证书有效、HTTP→HTTPS 301；cookie `Secure`+`SameSite`；`/api/config` 无 `baseUrl`/`adminConfigured`。
- [ ] **G1-min 达成前先跑一次「空部署」验证 线上==main**，再灌后续需求。

**建议 commit 粒度**：
1. `feat(deploy): tools/deploy.mjs（Node 校验+软链回滚+health 校验+deploy-log）`
2. `feat(deploy): GET /api/health（版本号+commit 注入） + package.json 版本 6.3.0`
3. `fix(deploy): 拆三阶段 setup-https.sh + 前置校验 + --staging`
4. `fix(security): cookie 加 Secure（auth.js:17/117 + server.js:551）`

---

### R3 · 埋点（审计0.5 + 漏斗0.5）（G1，1.0 人日）

**目标**：合规审计日志（同意/删除/AI 留痕）+ 业务漏斗（访问→排盘→报告→首问→注册 五段核心转化）。

**范围**：单端点 `/api/track` + action 白名单 + 限流 + 单表 `events`；不做 6 个独立 handler。

**技术锚点（已核对现码）**：
- 现状是「一事件一 handler 一路由分支」：`server.js:178-187` `handleFortuneExpand` + `:593` 路由 + `schema.sql:92-100` `fortune_events`（且 `:185` 无限流）。须改为单端点。
- 新端点 `POST /api/track`，body `{action, payload}`，action 走白名单；落单表 `events(action, payload jsonb, user_id, anon_id, created_at)`，索引 `(action, created_at)`。
- 审计三类（合规必需，即使业务埋点关闭也要留）：同意记录（`user_agreements`，R2† 建）、删除审计（R2† 删除时写）、AI 留痕（`ai_audit`，R1† 写）。
- 路由插入点：新路由必须插在 `server.js:601` 静态兜底**之前**；改动后跑冒烟确认可达。

**可观测验收 DoD**：
- [ ] 审计：同意/删除/AI 留痕入库可查。
- [ ] `tools/funnel.mjs` 30s 内输出五段漏斗（访问→排盘→报告→首问→注册）+ 报告→注册转化率。
- [ ] 版本期间累计真实排盘事件 ≥100 次（证明链路在真实流量下通）。

**建议 commit 粒度**：
1. `feat(track): 单端点 /api/track + events 表 + 白名单 + 限流`
2. `feat(track): 前端关键节点埋点 + tools/funnel.mjs`

---

### R6† · 流年年历（G3，1.0 人日）

**目标**：12 个月吉凶年历，复用内容安全过滤链，每格带固定「娱乐参考」角标；首页常驻本月流月卡片。

**范围**：数据已在库（`lib/interpreter.js:708` `allMonths` 已返回 48 月）；仅前端年历 UI + 按流年干支过滤 + 窗口外年份兜底 + 老数据缺 `allMonths` 容错。**须复用 R1† 内容过滤链，不得裸奔。**

**技术锚点（已核对现码）**：
- 数据窗口：`lib/core.js:9` `defaultWindow()` 返回 4 年窗口（y-1 ~ y+2）；`lib/interpreter.js:708` `const allMonths = interpretLiuyue(...)` 算 48 月；`:710` `upcoming = allMonths.filter(...).slice(0,6)`；`:721` `return { ..., allMonths }` 已入库/返回（`server.js:222,283`）。
- ⚠️ 语义同步陷阱：`lib/core.js:38` `chartContextText` 写死「流月（未来6段）」—— 若 R6 改 `months` 语义须同步改此处，否则喂 LLM 的 context 与前端对不上。
- 流年干支：单月 `liunian` 字段在 `lib/interpreter.js:510` 返回；年历按 `liunian` 过滤切换年份。
- 合规角标：年历页顶部常驻 L1 + 每格固定图标角标（ⓘ）+ 底部图例，不可 CSS 隐藏/折叠（法务 §10.1）；年历格文本须过 `lib/content-policy.js` 的 `BLOCKLIST`（R1†）。

**可观测验收 DoD**：
- [ ] 12 月年历渲染，吉凶色阶；按流年干支切换；窗口外年份兜底；老数据缺 `allMonths` 不报错。
- [ ] 每格娱乐参考角标（图标+顶部 L1+底部图例）常驻不可隐藏；内容经 R1† 过滤链。
- [ ] `/index.html` 常驻「本月流月吉凶」卡片，点击进年历。

**建议 commit 粒度**：
1. `feat(calendar): 年历视图（allMonths 取未来12月 + 流年过滤 + 兜底/容错）`
2. `feat(calendar): L1/角标/图例 + 内容过滤链复用 + 首页常驻卡片`
3. `chore: 若改 months 语义同步 lib/core.js:38 chartContextText`

---

## 2. 延后项清单（v6.4.0）

| 需求 | 人日 | 延后理由 | 备注 |
|---|---|---|---|
| **R5b** 额度监控面板 | 1.0 | 订阅制 C3 边际成本≈0，风险是「额度耗尽服务不可用」非「钱烧穿」；需真实流量才显价值（本版 P0）。V5 评估可并行确认 usage 是否可信。 | 优先于 R7/R8 排入 v6.4.0 |
| **R7** 命主档案 | 3.0–4.5 | 研发总监重估 7.0（原估 4.0 低估 75%）；**唯一「做一半即负资产」**（数据结构不可逆）；完整价值需 R9（明确不做）才释放；容量吃紧。 | 若 v6.4.0 做：采用法务方案②(+0.5) + `profiles.user_id NOT NULL` + 游客不开放家人档案；删除单档案 `ON DELETE SET NULL` 保留命盘，注销全删。决策由 v6.3.0 埋点数据决定（多档案率<15% 则 PM 自撤 R9 计划）。 |
| **R8** 报告分享（长图优先） | 1.5–3.0 | 增长件在备案期（C1 禁推广）无流量承接；链接分享会托管含他人信息的页面（PIPL 风险）；长图引前端依赖或 puppeteer（违背 2 依赖原则）。 | v6.4.0 **第一增长项**；赞助人异议已记录 |
| **R9** 合盘·姻缘 | 6–10 | 依赖 R7，内容敏感，**明确不做** | — |

**本版本明确不做（prior 决议）**：支付/付费解锁、紫微斗数、命理社区 UGC、真人咨询、邮件微信订阅推送、多语言海外版、等保/算法推荐/网络实名认证（L1–L4 低风险，MAU≈0 不触发）。

---

## 3. 并行项清单（零串行成本，不占排期）

| 编号 | 需求 | 人日 | 性质 | 触发/插入点 |
|---|---|---|---|---|
| **N9** | PIA 报告 + 委托处理协议（阿里云百炼） | 0.5 | V6 | 全程并行 |
| **V5** | 生成式 AI 服务备案评估与申报启动 | 0.3 | V5（**不阻塞发布**） | 全程并行；验收三选一：无需备案 / 已受理回执 / 走 BYOK 降级 |
| **N10** | 境内天气源替换（消除数据出境义务类别） | 0.5 | M1（可选·推荐） | G1 后插入 |
| **N8** | 未成年人保护最小集（未满 14 不服务） | 0.3 | M3（可选） | G1 后插入 |
| **R10b** | 443/HTTPS/DNS 打通 + 外部拨测 | 0.2 | 事件驱动 | **备案通过 24h 内**触发（DNS 复核：`chronik.cn`→`106.13.11.227` 生效，不再返回 `198.18.0.58`） |

---

## 4. 风险与门禁对照表

### 4.1 门禁通过标准（可独立发布/可对外使用状态）

| 门禁 | 含义 | 累计人日 | 含开销 | 核心达成条件（全绿） |
|---|---|---|---|---|
| **G1-min** | 解除「不可推广」 | 5.1 | ~2.7 周 | R0 已上线（断言+重置通道）· R10a 摘敏+安全头+备案占位 · R1† L1–L4+过滤 100% 拦截+AI 标识+举报 · R2† 隐私政策六类+明示同意+导出+删除回执+孤儿 TTL 定时任务 · R5a 额度耗尽 3s 内检索兜底不白屏 |
| **G1** | 可观测 | 7.6 | ~3.8 周 | R4† `tools/deploy.mjs` ≥3 次真实上线且 `/api/health` 版本==git hash（≥3 条记录）· R3 审计入库 + `tools/funnel.mjs` 30s 出漏斗 · **六表删除验证脚本**断言注销后计数全 0 + 游客 30 天 TTL 后计数 0（V2 硬门槛，任一非零即 DCP 不通过） |
| **G3** | 留存钩子（红线） | 8.6–9.0 | ~4.3 周 | R6† 12 月年历+复用过滤链+娱乐角标常驻+首页卡片 · 节奏 G1-min≤2.0 / G1≤3.0 / G3≤4.5 周 |

### 4.2 合规 V1–V6 一票否决（全程下限）

| 编号 | 含义 | 对应需求 | 未达后果 |
|---|---|---|---|
| V1 | 数据权利闭环 | R2† | 否决 |
| V2 | 孤儿数据删除完整性 | R2†（六表 TTL+验证脚本） | 否决 |
| V3 | 免责+内容护栏 | R1† / R5a / R6† | 否决 |
| V4 | HTTPS 生效 | R4† / R10b | 否决 |
| V5 | 生成式 AI 备案评估（不阻塞发布） | V5 并行 | 不阻塞，但决定 AI 交付形态 |
| V6 | PIA+委托协议 | N9 并行 | 否决 |

### 4.3 前五风险与缓解（对照 Charter §8）

| # | 风险 | 缓解（对应需求/动作） |
|---|---|---|
| 1 | 备案早于 G1-min 通过 → 推广裸奔窗口 | G1-min 前禁外部投放（仅≤50 人自测）；R5a 前置防 AI 全挂；R10b 备案触发 24h |
| 2 | 孤儿数据未清 → PIPL 第47/69条（可低成本取证） | R2† +0.5–1.0 专项；六表删除验证脚本；删除回执 |
| 3 | AI 输出失控（一次输出毁产品） | R1† 输出过滤与留痕**同时**上线，不先留痕后过滤 |
| 4 | 合规件做了没上线（线上跑旧代码） | R4† 排第一；`/api/health` 版本号==HEAD |
| 5 | 单人兼职重启开销被低估 | 严格串行门禁；每门禁开工前 1 页 design note（即本文）；R4 让发布成本趋零 |

### 4.4 超期处置（触及 9.0 红线）

按 **R3 漏斗(0.5) → R6†降级(省~0.5) → 顺序剪裁**。**R0/R10a/R1†/R2†/R5a/R4† 不参与剪裁。**

---

## 5. 待用户输入（阻塞项外，需 team-lead 提供，见 Charter §9）

1. **备案主办单位性质**（个人/企业）—— 影响备案通过率。
2. **DNS 现状**：确认 `chronik.cn` → `106.13.11.227` 的 A 记录生效（R10b 前置）。
3. **阿里云百炼条款确认**：是否用于模型训练 / 留存期限 / 是否 100% 境内（V5 5.2）。
4. **Open-Meteo 传输内容**：城市级经纬度 / 精确 GPS / 是否含用户 IP（决定数据出境风险等级，N10 优先级）。
