# 辰箓 v6.3.1 现状盘点（Charter 评审附件）

> 编制：齐活林（交付总监） · 2026-09-07
> 用途：vNext 场景规划与 Charter 评审的事实基线
> 源码：/tmp/chronik-merge（main） · 生产：http://106.13.11.227:8787

---

## 1. 产品定位

| 项 | 内容 |
|---|---|
| 品牌 | 辰箓（Chronik） |
| 内部代号 | bazi-system |
| 版本 | v6.3.1 |
| 定位 | 八字命理排盘 + AI 命理答疑平台 |
| 运营 | Edward **个人独立运营**（与任何企业无关，对外不得提及第三方企业） |
| 域名 | 备案中，暂以 IP 访问 |
| 联系 | tonyandrewhn@outlook.com |

---

## 2. 技术现状

| 层 | 现状 |
|---|---|
| 运行时 | Node.js v22（`--experimental-strip-types`），原生 `http` 模块，**非 Express** |
| 数据库 | PostgreSQL（pg.Pool，已配连接/语句/空闲事务超时） |
| 架构形态 | **单进程单体**，nginx :80 → :8787 代理 |
| 前端 | **零构建纯静态**（原生 HTML/CSS/JS） |
| 依赖 | 仅 2 个：`pg`、`cantian-tymext`（历法 / 真太阳时） |
| 前端 vendor | marked、DOMPurify、echarts（均已本地自托管） |
| 字体 | 全部自托管（Cinzel / Cormorant / Ma Shan Zheng 子集），**零外网字体依赖** |
| 外网依赖 | 仅 Open-Meteo 天气 API（首页天气卡） |

**已落地的工程能力**：node 层 gzip（SSE 除外）、优雅关闭、CSP（含 report-uri）、Cache-Control（vendor immutable / HTML no-cache）、GDPR 导出与删除、AI 审计日志、内容策略过滤。

---

## 3. 功能清单（v6.3.1）

### 3.1 页面

| 页面 | 路径 | 说明 |
|---|---|---|
| 天机阁（首页） | `index.html` | 今日运势 / 天气 / 万年历 / 阴阳建议 / 十二时辰 / 灵签 / CTA / 最近记录 |
| 推演阁 | `studio.html` | AI 多轮命理答疑，绑定命盘上下文 |
| 万年历 | `nianli.html` | 独立月视图 |
| 登录/注册 | `login.html` | 含密码重置 |
| 模型管理后台 | `admin.html` | LLM 配置管理 |
| 隐私政策 | `privacy.html` | 合规声明 |

### 3.2 排盘能力（**仅八字**）

报告章节：四柱 → 五行分布 → 格局与用神 → 大运 → 流年 → 近期流月 → 分领域解读 → 三句话总结

### 3.3 API 全景

| 域 | 端点 |
|---|---|
| 健康/配置 | `/api/health`、`/api/config`、`/api/cities` |
| 认证 | `/api/auth/register`、`login`、`logout`、`me`、`reset`、`reset/confirm` |
| 排盘 | `/api/chart`、`/api/report`、`/api/fortune/expand` |
| 首页 | `/api/home` |
| 万年历 | `/api/calendar` |
| AI | `/api/chat`、`/api/conversations`、`/api/charts`、`/api/admin/llm` |
| 合规 | `/api/me/export`、`/api/me/delete` |
| 运营/安全 | `/api/track`、`/api/csp-report` |

### 3.4 数据表

`users` · `sessions` · `charts` · `anon_chart_rate` · `anon_chat_rate` · `conversations` · `messages` · `fortune_events` · `password_resets` · `ai_audit` · `reports` · `user_anon_link` · `user_agreements` · `events`

### 3.5 已有增长/运营机制

- **匿名先用后注册**：`anon_chart_rate` / `anon_chat_rate` 限流表 + `user_anon_link`（游客数据归并到注册用户）
- **埋点**：`events` 表
- **漏斗工具**：`tools/funnel.mjs`，口径为 `page_view → chart_done → report_viewed → ai_first_q → anon_to_signup`（另有 `calendar_viewed`）

---

## 4. 已确认缺口

| 缺口 | 说明 |
|---|---|
| **变现** | 无任何付费 / 订阅 / 订单能力，完全空白 |
| **增长** | 无分享 / 邀请 / 裂变能力，完全空白 |
| **术数广度** | 仅八字，无紫微斗数 / 六爻 / 塔罗 / 奇门等 |

---

## 5. 待处置的既有问题

### 5.1 文案与实现不符（建议 PM 在 PRD 中给出结论）

`public/studio.js:320` 宣称「· 不限轮次**紫微斗数** AI 答疑」，但代码库中**不存在任何紫微斗数实现**。

- 风险：用户预期落空 + 对外宣传与实际能力不符
- 处置建议：由 PM 在 PRD 中定夺（删改文案 / 排期实现 / 改述为规划中）

---

## 6. 硬约束（任何方案不得突破）

1. **合规红线**：命理内容属敏感领域。所有输出必须定位为「文化研究与娱乐参考」，不得宣称预测准确性，不得涉及医疗 / 法律 / 投资建议。已有 `content-policy.js` 与免责声明体系。
2. **资源现实**：Edward 个人独立运营，**单人开发为主，无团队、无预算**。方案必须个人可维护、成本极低（服务器为既有资源）。
3. **技术现实**：单进程单体 + 零构建静态前端。**不规划需重构成微服务的方案**。
