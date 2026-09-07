# 辰箓 vNext Charter · 架构技术评审

- 评审人：高见远（架构师）
- 日期：2026-09-07
- 评审对象：`docs/prd-vnext-2026-09-07.md`（PM v1.0）+ `docs/current-state-v631-2026-09-07.md`
- 事实基线：`/tmp/chronik-merge` main（server.js 49k / lib 17 模块 / 无 Express / 依赖 pg + cantian-tymext）

---

## 一、Charter 结论

**有条件批准。**

方向正确（A→B→C 一条链、不做术数扩张、不强接支付网关），硬约束（单进程单体 + 零构建）与 PRD 自洽，**架构上无需否决项**。但 PRD 在"付费与配额"这一条主线上的技术描述偏乐观：现有代码里**注册用户完全没有任何配额限制**，且**没有任何 token 计量能力**，"AI 成本护栏"不是 P1 的可选项，而是 P0-6 上线的**前置条件**。故设 4 条批准条件（见 §五）。

---

## 二、关键判断

1. **服务端权威校验在单进程单体下完全可做，且不需要任何中间件框架。** 落点是"两个函数插入点 + 一次 DB 原子 UPSERT"：在 `server.js` 的 `handleChat`（现 L479-482）与 `handleChart`（现 L259-265）入口替换掉现有的 `checkChatGuest` / `checkChartRate`，改为统一的 `consumeQuota()`。前端 `/api/auth/me` 只回传 `remaining` 供展示，**任何写接口不接受客户端传入的 tier / quota 字段**。
2. **`anon_chat_rate` 不足以承担成本护栏——它是"终身 3 轮"而非"每日 3 轮"，且不记 token。** `lib/schema.sql:53` 该表只有 `(anon_id, rounds)`，**无 `window_start`**，`checkChatGuest()`（server.js L180）只做 `rounds >= 3` 判定，永不重置。同时 `handleChart` 的限流被包在 `if (ctx.isGuest)` 内——**注册用户当前排盘零限制**。
3. **配额计数的原子性必须交给 PostgreSQL 单行 UPSERT，不能放 Node 进程内存。** 单进程内存计数在重启/崩溃/未来多实例时全部失效，且优雅关闭（server.js L967 `shutdown()`）会静默丢计数。用 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 一行解决，零额外依赖。
4. **付费权利绝不能落进 `events` 表。** `events` 由 `POST /api/track`（server.js L776）任意客户端可写，把付费状态放进去等于把付费墙钥匙交给前端。`ai_audit` 同理（审计流水语义）。**必须新开 2 张表**，且必须同步纳入 `handleDelete`（L818）/ `handleExport`（L803）的 GDPR 清单，否则是合规回归。
5. **P0-4 分享卡片是"看起来 S、实际 M"的典型，且 P0-9 合规话术有"误杀主功能"的真实风险。** 二者都需要在设计阶段先定边界再动手（详见 §三 Q4后注 与 §六 风险登记）。

---

## 三、对 6 个必答问题的明确回答

### Q4：付费状态与配额校验放哪一层？

**明确不重构微服务。** 落点如下（全部为新增 lib 模块 + server.js 局部改，不改架构形态）：

| 层 | 落点 | 说明 |
|---|---|---|
| 权利存储 | `users` 增列 `tier SMALLINT DEFAULT 0`、`paid_until TIMESTAMPTZ`、`ai_bonus INT DEFAULT 0` | 冗余列，读权利零 JOIN |
| 权利来源 | **新表** `entitlement_grants` | 每次兑换/赠送/手动开通插一行，可审计可叠加可回滚 |
| 配额计数 | **新表** `usage_daily(subject TEXT, kind TEXT, day DATE, cnt INT, PRIMARY KEY(subject,kind,day))` | `subject` = `'u:'+user_id` 或 `'a:'+anon_id`；`kind` ∈ `chart` / `ai_round` / `ai_token` |
| 校验函数 | **新模块** `lib/quota.js`：`consumeQuota({subject, kind, limit})` | 单条 SQL 原子计数：`INSERT INTO usage_daily ... ON CONFLICT (subject,kind,day) DO UPDATE SET cnt=cnt+1 WHERE usage_daily.cnt < $limit RETURNING cnt`；无返回行即视为超限 |
| 权利解析 | **新模块** `lib/entitlement.js`：`resolveEntitlement(user)` | 读 `users.tier/paid_until/ai_bonus`，过期即降级为 free |
| **强制点 1** | `server.js` `handleChat`（L479-482） | **删除 `if (ctx.isGuest)` 判断**，注册用户同样走 `consumeQuota`；超限返回 `402 { needUpgrade:true }` 且**不调用 LLM**（沿用现有 L481 行为，零 token） |
| **强制点 2** | `server.js` `handleChart`（L259-265） | 同上，移除 `isGuest` 包裹 |
| 前端零信任 | `/api/auth/me` → `handleMe`（L724） | 只增返回 `quota: {chart:{used,limit}, ai:{used,limit}}` 与 `tier`，**纯展示** |
| 入参白名单 | `handleChat` / `handleChart` 的 `readBody` 结果 | 显式取字段，**忽略**任何 `tier`/`quota`/`remaining` 入参 |

**为什么前端无法绕过**：唯一的配额扣减发生在 `consumeQuota()` 的一次 DB 写入里，前端能改的只有"显示几个剩余额度"，改不了 `usage_daily` 的行。这与是否用 Express、是否微服务无关。

### Q5：AI 成本上限

**`anon_chat_rate` 不够**（见关键判断 2）。且现状**无 token 计量**：`estTokens() = ceil(len/2)`（server.js L348）是字符估算，只写入 `messages.tokens`，**不含 system prompt + 命盘上下文 + 历史消息——而输入侧才是成本大头**；`ai_audit` **无 token 列**。即：今天根本答不出"昨天花了多少 token"。

**最小改动方案**：
1. `ai_audit` 增列 `prompt_tokens INT`、`completion_tokens INT`、`degraded BOOLEAN DEFAULT false`。上游 SSE 结束若带 `usage` 取真值，否则回退 `estTokens` 并标记估算。
2. `usage_daily` 增 `kind='ai_token'` 聚合行，日切按 `day` 自然分桶（无需定时任务）。
3. **阈值由谁设定**：由 Edward（唯一出资人）在 `/api/admin/llm` 同 `ADMIN_TOKEN` 后台页设定，落 `data/ai-budget.json`（复用 `lib/llmConfig.js` 的加密/落盘模式）。技术侧只给默认值与硬熔断保护。建议默认 `AI_DAILY_TOKEN_CAP = 200_000`（约 ¥10–20/日量级），先跑 7 天真实数据再校准——**首周不要设死**。

**超限降级策略（按序，严格分级）**：

| 触发 | 动作 | token 成本 |
|---|---|---|
| 单用户超日轮次（免费 3 / 付费 30） | `402 {needUpgrade:true}`，**不进 LLM** | 0 |
| 全局达 80% | `console.warn` + `events` 记 `budget_warn`（加入 `TRACK_ACTIONS` 白名单 L764） | 正常 |
| 全局达 100% | **复用现成的 `buildRetrievalFallback()`**（server.js L483/528/541 已实现，检索式兜底，不白屏不 500） | **0** |
| 全局达 120%（硬熔断） | 付费用户也走兜底；`/api/health` 暴露 `budget:{used,cap,degraded:true}` | 0 |

**明确否决两个备选**：① **降级到小模型**——`lib/llmConfig.js` 当前只有单套 `baseUrl/apiKey/model`，加一套要改 admin 页、配置结构、加解密落盘格式，成本与收益不匹配；② **排队**——单进程无队列中间件，SSE 长连接已占用，`req.on('close')`（L536）语义下排队等于连接悬挂，风险高于收益。**降级到检索式兜底是唯一"零新增依赖 + 代码已存在"的路径**，这也是我推荐它的首要理由。

### Q6：兑换码与订单表

**不可复用 `ai_audit` / `events`**（理由见关键判断 4）。**建议新开 2 张表、不建 orders 表**：

```
redeem_codes (
  code VARCHAR(24) PRIMARY KEY,   -- randomBytes 生成，人工批量导出
  batch VARCHAR(24),              -- 批次号：人工收款对账用
  plan VARCHAR(16),               -- 'single' | 'month' | 'year'
  days INT, ai_rounds INT DEFAULT 30,
  status VARCHAR(10) DEFAULT 'unused',   -- unused | redeemed | revoked
  expires_at TIMESTAMPTZ,
  redeemed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
)

entitlement_grants (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source VARCHAR(16),   -- 'redeem' | 'manual' | 'invite'（P1-4 复用）
  code VARCHAR(24), plan VARCHAR(16),
  ai_rounds INT, effective_from TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  granted_at TIMESTAMPTZ DEFAULT now()
)
```

**三个必须点**：
1. **核销必须乐观锁**：`UPDATE redeem_codes SET status='redeemed', redeemed_by=$2, redeemed_at=now() WHERE code=$1 AND status='unused' AND (expires_at IS NULL OR expires_at > now()) RETURNING *`——`rowCount===0` 即已用过/已过期，杜绝并发重复兑换。
2. **不建 orders 表**：阶段 0 是人工收款，无在线订单流水；`entitlement_grants` + `events.redeem_success` 已够对账与审计。等阶段 3 真接支付网关时再建 `orders`，那时才有 `order_no / channel / 回调` 的真实需求。这是"最小改动"的核心取舍。
3. **必须同步改 GDPR 两端**：`handleExport`（L803）加导出 `entitlement_grants`；`handleDelete`（L818）加删除 `entitlement_grants`、`redeem_codes` 只置 `redeemed_by=NULL`（平台资产不删）。**漏改即是合规回归，列为验收硬项。**

### P0-2 / P0-3：现有表能否承载？

**能承载，且匿名归并方案现成可用。** 逐项：

| 项 | 现状 | 结论 |
|---|---|---|
| 注册用户排盘入库 | `handleChart` L299 已 INSERT `charts` | ✅ 已满足 |
| 匿名盘保存 | `handleChart` L289 `user_id=NULL, anon_id=$1` | ✅ 已满足 |
| 匿名→注册归并 | `mergeAnonCharts`（auth.js L191）+ `mergeAnonConversations`（auth.js L206），**register 处已调用**（L860-862） | ✅ 现成可用 |
| 对话历史持久化 | `conversations`/`messages` 已落库，`handleConversationsList` 按 `updated_at DESC LIMIT 30` 返回 | ✅ 已满足；"恢复最近 1 条"是前端取 `[0]`，**服务端零改动** |
| 删除单条对话 | **无任何 DELETE 端点** | ❌ **唯一真缺口**：需新增 `DELETE /api/conversations/:id`（`messages` 已 `ON DELETE CASCADE`，服务端改动 ~15 行） |

**需要的 3 个改动点**：
1. **新增 `DELETE /api/conversations/:id`**（P0-3 验收标准明确要求，当前不存在）。
2. **`charts` 去重**：`handleChart` 每次调用无脑 INSERT，同一人反复排同一盘会把"我的命盘"列表刷满。加 `md5(input::text)` 列 + `(user_id, input_hash)` 部分唯一索引，命中则 UPDATE `created_at` 而非 INSERT。
3. **注册额度的语义决策**：`anon_chat_rate` 未纳入 merge，注册后匿名已用的 3 轮不会继承到新账号。建议**明确"注册即重置额度"**（这是注册激励），但需写进设计——不是 bug 是决策。

另注：`handleChartsList`（L327）对游客硬返回 `[]`，即匿名盘在注册前不可见。这是**故意设计**，与 P0-2 验收标准不冲突，但 P1-1"注册后原匿名盘自动归属"依赖 register 处的 merge 调用——**已存在，P1-1 该子项实为已完成**。

### P0-4：分享卡片最省事的实现路径

**推荐：前端原生 Canvas 生成长图 + 页面内 `<img>` 长按保存；OG 图用服务端纯字符串拼 SVG。明确否决任何图形库。**

| 方案 | 判断 | 理由 |
|---|---|---|
| **A. 前端原生 Canvas（推荐·主）** | ✅ 采纳 | 零依赖、零构建、零服务端成本、零内存风险。CSP 现状 `img-src 'self' data:`（server.js L95）**已允许 data URL，无需改安全头** |
| **B. 服务端 SVG→PNG（resvg/sharp/puppeteer）** | ❌ **否决** | 需原生二进制或 Chromium，单人项目编译/运维成本高；puppeteer 在单进程内共享内存，一次 OOM 全站挂——**与"单进程单体"硬约束直接冲突** |
| **C. 服务端纯 Node 拼 SVG 直返 `image/svg+xml`（推荐·OG 用）** | ✅ 采纳 | 真·零依赖（字符串模板即可，命盘四柱/三句话都是文本）。缺憾：微博/小红书/微信对 SVG 的 `og:image` 支持不一，不支持时卡片退化为纯文字链接——**可接受**，因为主分享路径是 A 的长图而非 OG 抓取 |

**A 方案的隐藏复杂度（务必在设计时先定，否则必返工）**：
- **微信内置浏览器禁止 `<a download>` 下载 data URL**。必须把生成的 data URL 塞进页面 `<img>`，提示"长按图片保存"。这是 P0-4 验收"微信可直接分享"的真正卡点。
- **中文字体**：自托管 Ma Shan Zheng 等在 canvas 中必须先 `await document.fonts.ready` 再绘制，否则静默回退系统字体，品牌感尽失。
- **高分屏**：需按 `window.devicePixelRatio` 放大 canvas 再 CSS 缩回，否则截图模糊。长图高度需按内容自适应；短链/二维码绘制依赖 P0-5 的 `ref` 参数。

### 技术风险最高 / 隐藏复杂度最高

- **技术风险最高：P0-6 免费/付费分层与配额体系。** 它是 P0 里唯一横跨「认证 → 数据模型 → 权利状态 → 限流原子性 → 前端展示 → GDPR 六表删除」六个面的需求，任一处漏改都会造成"付费墙可绕过"或"合规回归"。且它把当前注册用户的"零限制"收紧为"有限额"，有口碑/SEO 反噬风险（与赞助人 Q1 强耦合，**需 Edward 先拍免费额度底线**）。
- **看起来简单实际会爆：P0-4 分享卡片**（爆点见上）与 **P0-9 合规话术固化**。P0-9 尤其危险：`content-policy.js` 若按字面加"禁止预测性断言 / 禁止绝对化措辞"的**输出侧**硬拦截规则，会把"你明年适合换工作吗"这类**正常命理问答全部误杀**，主功能直接变拒答机器。**架构裁决：P0-9 只能做「输入侧硬拦截（沿用现有 `isBlocked` 于 `handleChat` L500 前后）+ 输出侧软处理（追加 `DISCLAIMER_L2/L3`，或在 `ai_audit.blocked` 标记后人工复盘）」，禁止对 AI 输出做预测性断言的自动硬拦截。** 且 `content-policy.js` 同时被服务端与前端（`/content-policy.js` 路由 L910）共用，改一处即双端生效，需一次改对。

---

## 四、P0 十项技术复杂度复核

| 需求 | PM 估 | 我的复核 | 差异说明 |
|---|---|---|---|
| P0-1 紫微文案纠错 | S | **S** | 一致。纯文本改动，无技术风险 |
| P0-2 命盘云端保存 + 列表 | M | **S** | **下调**。表与 merge 已存在且已调用，实际只有"去重 + 列表页"两处增量；GDPR 删除已覆盖 |
| P0-3 对话历史持久化 | M | **S** | **下调**。落库/归并/清理全部现成，唯一缺口是新增 `DELETE /api/conversations/:id`（~15 行） |
| P0-4 分享卡片 | S-M | **M** | **上调**。微信下载限制 + 字体就绪 + DPR 三个坑，且需与 P0-5 合并实施 |
| P0-5 带参回流与归因 | S | **S** | 一致。`TRACK_ACTIONS`（L764）加 2 个字符串 + `events.payload` 存 `ref` + funnel 加分段 |
| P0-6 免费/付费分层与配额 | M | **M-L** | **上调**。六面横跨；`anon_chat_rate` 需从"终身"改"按日"；注册用户从零限制到限额；另需绑定 Q5 成本护栏（否则 P1-7 前置不成立） |
| P0-7 兑换码 MVP | S-M | **S** | **下调**。`ADMIN_TOKEN` 鉴权现成（`handleAdminLlm` L650）可直接复用；2 张表 + 1 个乐观锁核销端点 |
| P0-8 定价页 | S | **S** | 一致。纯静态页 + 静态文案 |
| P0-9 合规话术固化 | S | **M** | **上调**。误杀风险高，需"输入硬拦截 + 输出软改写"的架构裁决在前，规则调优在后；且双端共用同一模块 |
| P0-10 付费漏斗埋点 | S | **S** | 一致。同 P0-5，白名单加 3 个 action |

**整体**：PM 的估算总体可信，两处低估（P0-4、P0-9）、一处高需警惕（P0-6）、两处高估（P0-2、P0-3）。**总盘子与 PM 判断基本一致，无需重排优先级。**

---

## 五、批准条件（4 条，全部满足方可开工 P0-6/P0-7）

1. **P1-7「AI 成本护栏」从 P1 提前到 P0，作为 P0-6 的同一交付项。** 理由：无 token 计量时上线付费分层，等于在看不见成本的情况下放开付费用户 30 轮/日。两件事的代码落点高度重合（`usage_daily` + `ai_audit` 增列），合并做成本更低。
2. **Edward 先书面确认免费额度底线**（对应赞助人 Q1：每日免费排盘 N 次 + AI 3 轮的 N 取多少），并在 `lib/quota.js` 中以**常量**固化，不接受运行时由前端传入。
3. **P0-4 与 P0-5 合并实施**（分享卡 + `ref` 归因一次做完），避免同一区域两趟改动。
4. **P0-9 按"输入侧硬拦截 + 输出侧软改写"实施**，禁止对 AI 输出做预测性断言的自动硬拦截。此条为架构裁决，不因合规侧意见而反转；若合规坚持硬拦截，需先出误杀率评估报告。

---

## 六、风险登记

| # | 技术风险 | 级别 | 缓解建议 |
|---|---|---|---|
| R1 | **配额可绕过**：注册免费用户当前零限制；`anon_chat_rate` 为终身计数 | **高** | 统一走 `lib/quota.js` 的 DB 原子 UPSERT；移除 `handleChat`/`handleChart` 的 `isGuest` 分支；入参白名单 |
| R2 | **AI 成本失控**：无 token 计量，`ai_audit` 无 token 列；付费层 30 轮/日放大风险 | **高** | Q5 三档降级（80% 告警 / 100% 走现成 `buildRetrievalFallback()` / 120% 硬熔断）；`AI_DAILY_TOKEN_CAP` 由 Edward 设定，首周只观测不熔断 |
| R3 | **合规回归**：新增 `redeem_codes`/`entitlement_grants` 未纳入 GDPR 导出/删除 | **中高** | 改 `handleExport`(L803) + `handleDelete`(L818)；列为验收硬项，`tools/test-gdpr.mjs` 增用例 |
| R4 | **P0-9 误杀主功能**：输出侧硬拦"预测性断言"导致正常命理问答变拒答 | **中高** | 输入侧硬拦 + 输出侧追加 `DISCLAIMER_L2/L3`；灰度期打印 `ai_audit.blocked` 命中率，超阈值即回滚规则 |
| R5 | **P0-4 微信分享不通**：内置浏览器禁 data URL 下载；字体未就绪致回退 | **中** | 页面内 `<img>` + 长按保存；`await document.fonts.ready`；按 DPR 放大；真机（iOS/Android 微信）实测后再发布 |
| R6 | **单点风险**：单进程 + 单 PG，无备份/无监控；兑换码数据仅存 PG | **中** | `redeem_codes` 批量生成后导出 CSV 离线留存（人工收款对账必需）；`tools/deploy.mjs` 部署前加 PG 逻辑备份步骤 |
| R7 | **`users` 增列 + `usage_daily` 上线无回滚路径** | 低中 | schema 全部用 `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`（现有 `lib/schema.sql` 已幂等）；`tier` 默认 0 = free，新代码上线即对全体现有用户无感 |

---

## 七、Anything UNCLEAR（需回 PRD 澄清）

1. **P1-1「注册后原匿名盘自动归属」实为已完成**（register 处已调用 merge），PM 需确认是否指别的场景，否则该项应从 P1 移除或改写验收标准。
2. **P0-6 的"排盘 N 次/日"中 N 未给值**，需 Edward 拍板（见批准条件 2）。
3. **`events` 的 `ref` 归因依赖客户端上报**，`/api/track` 可被伪造——分享归因数据只能用于趋势观察，**不可作为任何结算/奖励依据**（影响 P1-4 邀请奖励的防刷设计）。
4. **未确认 `ADMIN_TOKEN` 在生产是否已设置**；若未设置，`/api/admin/llm` 返回 403，兑换码后台同样无法启用——P0-7 开工前需先验证。
