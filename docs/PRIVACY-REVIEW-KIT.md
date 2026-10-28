# 辰箓 · 隐私政策审校工具包（v1.0）

> 用途：把「现行政策全文 + 真实数据处理事实 + 已知缺陷」一次性交给 ChatGPT，产出**经得起专业审校的**隐私政策（中文 / 英文 / 葡语三版）。
> 生成日期：2026-10-28　适用代码版本：6.3.x（含 i18n、按地区定价）

---

## 0. 怎么用（3 步，约 10 分钟）

| 步骤 | 操作 |
|---|---|
| ① 复制提示词 | 打开第 **5.1** 节，整段复制「主提示词（中文）」 |
| ② 粘事实 | 在同一条消息里，接着粘贴第 **2** 节（事实清单）+ 第 **3** 节（现行全文）。**事实清单是唯一事实来源，不要让 AI 自行发挥** |
| ③ 收结果 | 让 ChatGPT 按第 **5.5** 节格式输出；拿到后按第 **6** 节回填到文件 |

> ⚠️ 关键提醒：ChatGPT 不知道你的系统实际做了什么。**它只会基于第 2 节写条款**。第 2 节写错，政策就写错。凡第 2 节标注「待确认」的，请先自己确认再发给 AI。

---

## 1. 审校前必须知道的 7 件事（我已先行自查）

按风险从高到低。这些是现行政策的**事实性错误或缺口**，不是文字润色问题。

### ① 跨境传输声明与事实不符 —— 高风险（事实错误）

现政策第四节写：「我们**不主动向境外**提供你的个人信息」。但代码实际行为是：

- 首页每次加载都会**直接调用 `https://ipwho.is/`**（境外服务）拿 IP 归属地 → 用户公网 IP 被第三方获取；
- 若用户授予浏览器定位权限，取 GPS 经纬度；
- 上述经纬度或城市名会送到服务端，服务端再转给 **Open-Meteo**（瑞士）与 **BigDataCloud**（境外）两个天气/反查地名接口。

→ 即：**位置数据与 IP 事实上出境了**。政策这句话必须改写，并补「单独同意 + 境外接收方清单」。

### ② 只写了 PIPL，没写 GDPR / LGPD —— 高风险（适用法律缺口）

已按地区定价（USD / EUR / GBP / BRL），等于**明确向欧盟、英国、巴西用户提供付费服务**：

- GDPR 第 3 条（域外适用）成立 → 需披露**处理合法性基础、数据主体权利、是否设立 EU/UK 代表（Art 27）**；
- 巴西 LGPD → 需披露**法律基础（Art 7）、DPO/Encarregado 联系方式、国际传输（Art 33）**。

现政策通篇只有《个人信息保护法》，欧盟用户看不到自己该有的权利条款。

### ③ 没有独立的《用户协议》—— 中风险（形式缺陷）

`login.html` / `studio.html` 的注册勾选处，两个链接**都指向 `/privacy.html`**：

```html
<a href="/privacy.html">《隐私政策》</a> 与 <a href="/privacy.html">《用户协议》</a>
```

→ 用户"同意"的《用户协议》并不存在。要么补一份 terms.html，要么把文案改为单一《隐私政策》。

### ④ 生成式 AI 备案 / 算法备案状态缺失 —— 中高风险（监管项）

平台向公众提供生成式 AI 对话。按《生成式人工智能服务管理暂行办法》第 17 条，**具有舆论属性或社会动员能力的**生成式 AI 服务应履行备案。政策里完全没有提备案号或"已使用已备案模型"的说明。此项需你先确认实际状态，再决定怎么写（很多同类产品会写"本服务所用模型已完成备案，备案号 XXX"）。

### ⑤ 注销删除范围 ≠ 政策承诺 —— 中风险（承诺过度）

政策表格写「注销后删除」，但 `POST /api/me/delete` 实际只删 10 张表；以下数据**保留**（外键 `ON DELETE SET NULL`，仅置空 user_id）：

- `ai_audit`：保留 `input_snippet` / `output_snippet`（用户原话摘要）—— 政策虽写"≥6 月"，但**没有说"注销后仍保留"**；
- `events`：埋点保留，政策写"注销或超期清理"，实际没有清理任务；
- `reports`：举报记录保留（合理，但需披露）。

同时 `POST /api/me/export` **不含** `ai_audit` 与 `events`，与 PIPL 第 45 条"查阅、复制"权有落差。

### ⑥ 三类必备条款缺失 —— 中风险

- **未成年人**：PIPL 第 31 条（不满 14 周岁需监护人单独同意）未提；现产品无年龄门槛。
- **自动化决策**：AI 生成命理解读属于自动化输出，PIPL 第 24 条要求"保证决策透明度和结果公平公正，不得对个人在交易价格等交易条件上实行不合理的差别待遇"，并赋予用户**要求说明、拒绝仅经自动化决策**的权利。未提。
- **Cookie / 本地存储清单**：使用了 `cl_sid`（登录态）、匿名 ID Cookie、`cl_lang` / `cl_cc` / `chenlu_pos` 等 localStorage，均未披露。

### ⑦ 运营主体表述与 ICP 备案主体不一致 —— 低风险但会被挑

政策写「运营方：Edward，个人独立运营」；ICP 备案主体是**黄宁**（粤ICP备2026138936号-1）。
→ 建议统一为备案主体姓名（或"黄宁（个人开发者）"），并保留联系邮箱 `tonyandrewhn@outlook.com`。

---

## 2. 数据处理事实清单（作为 ChatGPT 的唯一事实来源）

> 以下均为**读代码确认**的实况，非推测。标「待确认」的需要你人工核实后再改。

### 2.1 处理者与基础设施

| 项 | 实况 |
|---|---|
| 处理者（运营方） | 黄宁，个人开发者，中国境内自然人；联系邮箱 tonyandrewhn@outlook.com |
| 网站 | chronik.cn / www.chronik.cn；ICP 备案 粤ICP备2026138936号-1（个人备案） |
| 服务器 | 百度智能云，中国北京（IPv4 106.13.11.227），Linux + nginx 反代 |
| 应用 | Node.js 单体服务（systemd 单元 `bazi-system`，监听 127.0.0.1:8787） |
| 数据库 | PostgreSQL，与 Web 服务**同机**部署（库名 chenlu），未使用云托管数据库 |
| 数据存储地 | 全部在中国境内（北京） |
| 是否设 EU/UK 代表 | 无 |
| 是否设 DPO / Encarregado | 无（由运营者兼任） |
| 是否做等保测评 | 待确认 |

### 2.2 收集的数据（逐表）

| 表 | 字段与内容 | 是否可识别到人 | 用途 |
|---|---|---|---|
| `users` | username、password（**scrypt 加盐哈希**，不可逆）、nickname、email（可选）、gender、birth_calendar、birth_date、birth_time、birth_location、day_master、day_stem、month_zhi、weather_city、notification_settings(JSONB)、created_at/updated_at | 是 | 账号、排盘、今日运势个性化 |
| `sessions` | token（64 位随机串）、user_id、expires_at | 是 | 登录态 |
| `charts` | 排盘入参、命盘结构、解读结果、报告 HTML、anon_id（游客） | 是（含出生信息） | 命盘保存与回看 |
| `conversations` / `messages` | 会话标题、逐条 role/content、token 估算 | 是 | AI 对话历史 |
| `anon_chart_rate` | **ip（明文 IP）**、cnt、window_start、anon_id | 是（IP 属个人信息） | 游客排盘防刷限流 |
| `anon_chat_rate` | anon_id、rounds、day_date | 伪匿名 | 游客对话限额 |
| `user_ai_quota` | user_id、rounds、day_date | 是 | 付费用户每日 30 轮配额 |
| `fortune_events` | user_id/anon_id、day、action（如 expand_why） | 伪匿名 | 功能埋点（展开率） |
| `events` | action、payload(JSONB)、user_id/anon_id、created_at | 伪匿名 | 业务漏斗埋点 |
| `ai_audit` | user_id/anon_id、conversation_id、model、**input_snippet / output_snippet（截断摘要）**、blocked、category、tokens、high_risk | 是 | 内容安全合规留痕（≥6 月） |
| `reports` | 举报 target/detail、user_id/anon_id | 伪匿名 | 违规内容受理 |
| `notifications` | type、title、body、payload(含 chart_summary) | 是 | 站内信（节气/流年/生日/续费提醒） |
| `redeem_codes` / `entitlement_grants` | 兑换码、plan、redeemed_by（用户 id 或 anon_id）、有效期 | 是 | 付费权益 |
| `user_agreements` | 同意类型（terms/privacy）、版本号、agreed_at | 是 | **同意记录（PIPL 第 14 条举证）** |
| `user_anon_link` | user_id ↔ anon_id 映射 | 是 | 游客数据并入账号、注销时双条件删除 |
| `password_resets` | token、expires_at、used_at | 是 | 密码重置 |

**未收集**：手机号、身份证号、真实姓名、银行卡/信用卡号、人脸/指纹、通讯录、剪切板、IMEI/设备唯一标识。

### 2.3 三个特殊场景（政策必须单独写）

**A. 位置与天气（含出境）**

1. 首页加载时，前端**先尝试浏览器 GPS**（`navigator.geolocation`，需用户授权，精度约城市级）；
2. GPS 不可用时，前端**直接请求 `https://ipwho.is/`**（境外第三方）用公网 IP 反查大致位置 —— 此调用会把用户 IP 交给该服务；
3. 前端将经纬度或城市名发给本站 `/api/home`；
4. 服务端把经纬度转给 `api.bigdatacloud.net`（反查地名）与 `api.open-meteo.com`（取天气）；
5. 位置结果**缓存在浏览器 localStorage**（键 `chenlu_pos`，1 小时），**不写入数据库**；用户可手动设置常驻城市并存入 `users.weather_city`。

→ 该场景涉及：用户 IP、精确/近似经纬度、城市名。接收方含 3 家境外服务。

**B. AI 问答**

- 用户提问 + 命盘结构化上下文（干支、十神、大运等）拼成 prompt，发送至**阿里云百炼**（DashScope，OpenAI 兼容协议，模型 qwen 系列，境内节点）；
- 每次调用留存 input/output 摘要与命中禁区标记（`ai_audit`），法定留存 ≥6 个月；
- 是否用于模型训练：**待确认**（需与阿里云确认"百炼 API 调用数据不用于训练"条款），确认后在政策里明写。

**C. 支付与退款**

- **不接入在线支付网关，不收集、不存储任何支付卡信息**；
- 中国境内：微信个人收款码转账 → 用户凭备注联系运营 → 运营手工发放兑换码；
- 境外：邮件联系 → 发 PayPal / 卡片支付链接（在第三方页面完成）→ 发放兑换码；
- 兑换码核销记录（code、plan、有效期、redeemed_by）入库；
- 退款：7 天无理由，原路退回，按渠道 3–7 个工作日。

### 2.4 第三方清单（政策需列表披露）

| 第三方 | 所在国家/地区 | 接收的数据 | 目的 | 触发时机 |
|---|---|---|---|---|
| 阿里云百炼（DashScope） | 中国 | 提问内容 + 命盘摘要 | 模型推理 | 每次 AI 问答 |
| ipwho.is | 境外（待确认具体主体） | 用户公网 IP | IP 归属地反查 | 首页加载且 GPS 不可用 |
| Open-Meteo | 瑞士 | 经纬度或城市名 | 天气数据 | 首页加载 |
| BigDataCloud | 境外（待确认） | 经纬度 | 经纬度→地名 | 使用 GPS 定位时 |
| 百度智能云 | 中国 | 托管服务器与全部数据库 | 云主机 | 持续 |

> 未接入：Google Analytics、百度统计、友盟、广告 SDK、字体 CDN、客服 SDK。

### 2.5 Cookie 与浏览器本地存储

| 名称 | 类型 | 内容 | 期限 | 属性 | 性质 |
|---|---|---|---|---|---|
| `cl_sid` | Cookie | 会话 token | 随会话过期 | HttpOnly、SameSite=Lax、HTTPS 下 Secure | **必需**（登录态） |
| 匿名 ID Cookie | Cookie | 随机 anon_id | 长期 | HttpOnly、SameSite=Lax | **必需**（游客额度） |
| `cl_lang` | Cookie / localStorage | 语言偏好 en/pt/zh | 持久 | — | 功能性 |
| `cl_cc` | localStorage | 地区码（定价用） | 持久 | — | 功能性 |
| `chenlu_pos` | localStorage | 经纬度 + 时间戳 | 1 小时 | — | 功能性（定位缓存） |

→ 无广告/跨站追踪 Cookie，**当前不需要 Cookie 同意横幅**，但 GDPR 要求披露（第 2.5 节可直接成表）。

### 2.6 留存与删除（实况）

| 数据 | 期限 | 清理机制 |
|---|---|---|
| 账号、出生信息、命盘、对话、站内信、配额、权益 | 账号存续期；注销**即时物理删除** | 注销接口同步删除 |
| 游客孤儿数据（无 user_id 且无 anon_id） | **30 天** | cron 跑 `tools/cleanup-orphans.mjs` |
| `ai_audit` | **≥6 个月**（法定）；代码无自动清理任务 → 实际永久保留 | 待补 TTL 任务 |
| `events` / `reports` | 保留，注销后置空 user_id（去标识化） | 无自动清理 |
| 会话 token | 到期失效；注销级联删除 | — |
| nginx 访问日志（含 IP、UA、访问路径） | 待确认（默认长期） | 建议 30 天轮转 |
| 数据库备份 | 待确认 | 建议 ≤30 天 |

### 2.7 用户权利的实现方式（已上线接口）

| 权利 | 落地方式 |
|---|---|
| 查阅 / 更正 | 登录后在设置页查看、修改出生信息与昵称 |
| 复制 / 导出 | `POST /api/me/export` → 返回 JSON（含 users、charts、conversations、messages、fortune_events、anon 限流记录、兑换码、权益；**不含 ai_audit / events**） |
| 删除 / 注销 | `POST /api/me/delete` → 按「账号 id + 关联 anon_id」双条件删除 10 张表，返回各表删除条数回执 |
| 撤回同意 | 注销即撤回；撤回前处理不受影响 |
| 投诉举报 | 页面「⚠ 内容举报 / 反馈」→ 写 `reports` 表；隐私事宜走邮箱 |

### 2.8 已实施的安全措施

- 口令 **scrypt 加盐哈希**，服务端不存明文；重置 token 单次有效、带过期。
- 会话 Cookie **HttpOnly + SameSite=Lax + HTTPS 下 Secure**，token 为 64 位随机串。
- 数据库与 Web 同机、仅监听本地回环（127.0.0.1），不对公网开放 5432。
- 游客排盘按 IP 限频、游客问答按自然日限 3 轮，防额度滥用。
- 内容侧：四层免责（L1–L4）+ 关键词禁区（医疗/法律/投资/政治等 A–J 类）+ 输出二次审计 + `ai_audit` 留痕。
- 全站 HTTPS（含 HSTS，待确认）。

### 2.9 待你确认的 5 项（确认后再写进政策）

1. 阿里云百炼是否将 API 输入/输出用于模型训练？数据是否 100% 境内处理？
2. 生成式 AI 服务是否已完成备案/登记？备案号是多少？
3. nginx 访问日志与数据库备份的实际保留周期？
4. 是否已办理**公安联网备案**（ICP 备案后 30 日内）？
5. 是否对未成年人设年龄门槛（建议：注册页加"已满 18 周岁"或"已满 14 周岁且获监护人同意"勾选）？

---

## 3. 现行隐私政策全文（v6.3.0，2026-09-04）

> 以下为 `public/privacy.html` 正文（去 HTML 标签后的纯文本），供 AI 做逐条比对。

```
辰箓 · 隐私政策
生效版本：v6.3.0　最后更新：2026-09-04　依据：《个人信息保护法》第17条

辰箓（运营方：Edward，个人独立运营）是一款传统命理文化的展示与研究工具。我们仅收集提供产品功能所必需的信息，并严格遵循「告知—同意」原则。本页说明我们收集什么、为何收集、保存多久，以及你拥有的权利。

一、我们收集的信息
- 账号信息：用户名、密码（经 scrypt 加盐哈希，服务端不存明文）、昵称、邮箱（可选）。
- 出生信息：出生日期、时辰、历法、性别、出生地（用于排盘，仅由出生日期推算日主/月令）。
- 命盘与对话：你生成的命盘、与 AI 的问答内容（含模型输出）。
- 匿名试用数据：未登录时的游客 ID、匿名排盘/问答、频率限制计数。
- 埋点与留痕：功能使用统计（如运势卡「为什么」展开）、AI 输出留痕（input/output 摘要、是否命中内容禁区），用于合规审计与产品优化。

二、收集目的与法律依据
目的：提供排盘与 AI 文化解读、保障账号安全、履行合规审计（内容安全留痕 ≥6 月）、改进产品。法律依据：履行合同所必需、与你另行取得的单独同意（AI 问答、埋点）。

三、信息使用方式
仅用于本产品功能与合规审计；命理内容由 AI 基于公开命理学说生成，不构成任何专业建议。

四、委托处理与跨境
AI 答疑的模型推理委托阿里云百炼作为受托处理方完成，我们与其约定处理目的、期限、方式、信息种类与安全保护措施。我们不主动向境外提供你的个人信息；如未来涉及跨境传输，将单独告知并依规取得你的同意。

五、保存期限
| 信息类别 | 保存位置 | 保存期限 |
| 账号与密码哈希 | users | 账号存续期；注销后立即删除 |
| 出生信息 / 命盘 | users / charts | 账号存续期；注销后删除 |
| 问答内容 | conversations / messages | 账号存续期；注销后删除 |
| 匿名试用数据 | charts(anon)/conversations(anon) 等 | 无归属且超过 30 天自动清理 |
| AI 输出留痕 | ai_audit | ≥ 6 个月（合规审计） |
| 功能埋点 | events / fortune_events | 匿名为主；注销或超期清理 |

六、你的权利
- 查阅 / 复制 / 更正：登录后可在设置查看与修改出生信息；
- 导出：POST /api/me/export 返回你的数据副本（JSON）；
- 删除 / 注销：POST /api/me/delete 按「账号 + 关联匿名 ID」双条件删除六表数据并出具回执；
- 撤回同意：注销即视为撤回基于同意的处理；撤回前已进行的处理不受影响。

七、内容安全与举报
我们对 AI 输出施行四层免责与关键词禁区（医疗/法律/投资/政治等 §6.1 A–J 类）；如你发现违规内容，可通过页面「⚠ 内容举报 / 反馈」提交，我们将核查处理。

八、联系我们
隐私事宜请联系：tonyandrewhn@outlook.com。如你认为处理违反个人信息保护相关规定，可向网信部门投诉举报。
```

---

## 4. 三语交付要求

同一份政策，三种语言**不是互译关系，是"同等保护水平"关系**：

| 版本 | 适用对象 | 必须额外覆盖 | 文风 |
|---|---|---|---|
| 中文 zh | 中国大陆用户 | PIPL、生成式 AI 办法、ICP 备案号 | 简明、条款化，避免法条堆砌 |
| 英文 en | 全球默认 / 欧盟 / 英国 / 北美 | **GDPR**（Art 6 合法性基础、Art 13/14 告知、Art 15–22 权利、Art 27 代表、Art 44–49 跨境）、UK GDPR、CCPA/CPRA（如涉加州） | plain English，短句，避免 "hereinafter" |
| 葡语 pt | 巴西 / 葡萄牙 | **LGPD**（Art 7 基础、Art 18 权利、Art 33 国际传输、Encarregado 联系方式）、GDPR（葡萄牙用户） | pt-BR 为主（巴西是主要市场），避免葡葡差异词 |

**翻译红线**（与站内术语表一致，务必在提示词里重申）：

- 保留中文原词 + 括注：BaZi (八字)、Four Pillars、Day Master、Ten Gods、Luck Pillar、Annual Pillar、Ben Ming Nian、Tai Sui、Kau Cim (Oracle Slip)；
- 葡语用 **Caules Celestiais e Ramos Terrestres**、**Mestre do Dia**、**Dez Deuses**；
- 不出现 "fortune telling"「算命」「占卜师」这类易触发平台/支付风控的词，统一用 **traditional Chinese metaphysics / cultural entertainment**；
- 所有免责声明必须明写 **not medical, legal, financial, or psychological advice**。

---

## 5. 提示词（直接复制）

### 5.1 主提示词（中文 · 首选）

```
你是资深数据合规顾问，同时具备中国《个人信息保护法》、欧盟 GDPR、巴西 LGPD 的实务经验。请帮我重写一份隐私政策。

【背景】
我运营一个面向全球的个人开发者网站「辰箓」（chronik.cn），提供传统八字命理排盘与 AI 文化解读，已按地区定价向中国大陆、欧盟/英国、巴西等地用户收费。我手上的现行政策是中国大陆口径的 v6.3.0，写了 8 节，但存在事实错误与适用法缺口。

【我将提供两份材料】
材料 A：数据处理事实清单（这是唯一事实来源，请勿添加、推测或美化任何事实）
材料 B：现行政策全文

【你的任务，按顺序做】
1. 差异审计：逐条比对「事实清单」与「现行政策」，列出所有 (a) 事实错误 (b) 应披露但缺失 (c) 表述含糊可能被监管挑刺 的地方。用表格输出：现行条款 | 问题类型 | 依据（PIPL/GDPR/LGPD 具体条文） | 严重度（高/中/低） | 修改建议。不要跳过任何一条。
2. 重写中文版：面向中国大陆用户，结构建议 12 节以内，必须包含：
   处理者身份与联系方式、收集的信息（表格化）、处理目的与合法性基础（逐项对应）、Cookie 与本地存储清单、委托处理与第三方共享（表格：接收方/所在地/数据类别/目的/传输机制）、跨境传输（明确说明哪类数据会出境、接收方、依据与用户如何拒绝）、保存期限（表格）、安全措施、你的权利与行使方式（含接口路径）、未成年人保护、自动化决策说明、政策更新与投诉渠道。
   语言要求：短句、条款化、不用「我们致力于」「秉持」这类空话；每个承诺都必须能在事实清单里找到依据。
3. 重写英文版：不是直译，而是面向欧盟/英国用户的 GDPR 合规版本。必须写清 Art 6 合法性基础（对每类处理分别标注 contract / consent / legitimate interest / legal obligation）、Art 13/14 告知项、Art 15–22 权利、Art 27 代表情况（我未设代表，请如实写明并给出合规建议）、Art 44–49 跨境传输机制。Plain English，Flesch 易读性尽量 ≥50。
4. 重写葡语版（pt-BR）：面向巴西用户，覆盖 LGPD Art 7（法律基础）、Art 18（权利）、Art 33（国际传输）、Encarregado 联系方式。
5. 风险清单：单独列一节，告诉我「按目前的产品设计，哪 3 件事最容易在欧盟/巴西被投诉」，以及最小成本的整改动作（不要建议我雇律师或买合规软件，我是个人开发者）。

【硬性约束】
- 不得虚构任何事实。事实清单里没有的，一律写「待补充」，并在末尾汇总成待补清单。
- 不得承诺我做不到的事（例如「数据全部境内存储」——我的天气接口会把经纬度发给境外服务，这一点必须如实披露）。
- 三语版本的保护水平必须一致；如某条只在某语言版本出现，请标注原因。
- 术语统一：BaZi / Four Pillars / Day Master / Ten Gods / Luck Pillar / Annual Pillar / Ben Ming Nian / Tai Sui；葡语用 Caules Celestiais e Ramos Terrestres / Mestre do Dia / Dez Deuses。避免 fortune telling、占卜、算命等词，统一 traditional Chinese metaphysics。
- 所有版本都必须含免责句：本服务内容由 AI 生成，仅供文化研究与娱乐，不构成医疗、法律、财务或心理建议。

【材料 A：数据处理事实清单】
<<< 在此粘贴本文档第 2 节全文 >>>

【材料 B：现行政策全文】
<<< 在此粘贴本文档第 3 节全文 >>>
```

### 5.2 Main prompt (English · 用于英文/欧盟版条款起草)

```
You are a senior data protection consultant with hands-on experience in the EU GDPR, UK GDPR, Brazil's LGPD and China's PIPL. Rewrite the privacy policy for my website.

CONTEXT
I am an individual developer running "Chen Lu" (chronik.cn), a site offering traditional Chinese BaZi (Four Pillars) chart calculation and AI-generated cultural commentary. I sell a yearly membership priced by region (CNY / USD / EUR / GBP / BRL), so I serve users in mainland China, the EU/UK, Brazil and North America.

INPUTS
Material A: a factual data-processing inventory (the ONLY source of truth — do not invent, embellish or infer any fact).
Material B: my current policy (China-only, v6.3.0).

TASKS, in order
1. GAP AUDIT — compare Material A against Material B. Table columns: existing clause | issue type (factual error / missing disclosure / vague wording) | legal basis (cite the specific PIPL / GDPR / LGPD article) | severity (high/medium/low) | recommended fix. Be exhaustive.
2. REWRITE IN ENGLISH (GDPR-first). Requirements:
   - Identify the controller clearly (individual developer, name, country, contact email).
   - For EVERY processing activity, state the Art. 6 lawful basis (contract / consent / legitimate interest / legal obligation) — no blanket statements.
   - Full Art. 13/14 transparency: purposes, categories, recipients, transfers, retention, rights, automated decision-making, statutory/contractual requirement to provide data.
   - Art. 15–22 rights with concrete how-to (the actual API endpoints I expose).
   - International transfers: name every recipient outside the EEA/UK, the data involved, and the transfer mechanism. If I have no Art. 27 representative and no SCCs in place, say so plainly and propose the cheapest proportionate fix.
   - Cookies & local storage table (name, type, purpose, duration, essential/functional).
   - Children: state the minimum age and what happens if I learn a minor registered.
   - Automated decision-making: my AI produces personalised readings — explain the logic at a high level and confirm there are no legal/significant effects, and that users can request human review.
   - Plain English, short sentences, active voice; aim for Flesch Reading Ease ≥ 50. Do not use "hereinafter", "forthwith", "endeavour".
3. Write a pt-BR version covering LGPD Art. 7, 18, 33 and the Encarregado contact. Same protection level as the English version — not a literal translation.
4. RISK LIST — the three concrete things most likely to generate a complaint in the EU or Brazil given my current design, each with a minimum-cost remediation I can do myself as a solo developer.

HARD CONSTRAINTS
- Never invent facts. If something is not in Material A, write "TO BE CONFIRMED" and collect these in a final list.
- Do not promise anything I cannot deliver. For example, do not claim "all data stays in China" — my weather feature sends coordinates to overseas APIs; disclose that honestly.
- Keep terminology consistent: BaZi / Four Pillars / Day Master / Ten Gods / Luck Pillar / Annual Pillar / Ben Ming Nian / Tai Sui. Avoid "fortune telling" and "divination"; use "traditional Chinese metaphysics" and "cultural entertainment".
- Every version must include: content is AI-generated, for cultural study and entertainment only, and is not medical, legal, financial or psychological advice.

MATERIAL A (data-processing inventory)
<<< paste Section 2 of this document >>>

MATERIAL B (current policy)
<<< paste Section 3 of this document >>>
```

### 5.3 Prompt para versão em português (pt-BR)

```
Você é consultor sênior de proteção de dados, com prática em LGPD (Brasil), GDPR (UE) e PIPL (China). Preciso reescrever a política de privacidade do meu site.

CONTEXTO
Sou desenvolvedor individual e opero o "Chen Lu" (chronik.cn), site de cálculo de mapas BaZi (Quatro Pilares) com interpretação cultural gerada por IA. Vendo assinatura anual com preço por região (CNY/USD/EUR/GBP/BRL), atendendo usuários no Brasil, na UE/Reino Unido, na China e na América do Norte.

ENTRADAS
Material A: inventário factual de tratamento de dados (ÚNICA fonte de verdade — não invente nem complete informações).
Material B: política atual (v6.3.0, feita apenas para a China).

TAREFAS
1. Auditoria de lacunas em tabela: cláusula atual | tipo de problema | fundamento legal (artigo específico da LGPD/GDPR/PIPL) | gravidade | correção sugerida. Seja exaustivo.
2. Reescrever em pt-BR, com estrutura de 12 seções no máximo, cobrindo obrigatoriamente: identificação do controlador e contato; dados coletados (em tabela); finalidades e bases legais do Art. 7 da LGPD, uma a uma; cookies e armazenamento local (tabela); operadores e terceiros (tabela: destinatário, país, categoria de dados, finalidade, mecanismo de transferência); transferência internacional (Art. 33) — diga com clareza quais dados saem do Brasil, para quem e com qual mecanismo; prazos de retenção (tabela); medidas de segurança; direitos do titular (Art. 18) e como exercê-los, incluindo os endpoints reais que ofereço; proteção de crianças e adolescentes (Art. 14); decisões automatizadas (Art. 20) e direito à revisão; encarregado (Encarregado/DPO) e canal de contato; atualizações da política e reclamações (ANPD).
3. Versão em inglês (GDPR) e versão em chinês (PIPL), com o MESMO nível de proteção — não traduções literais.
4. Lista de riscos: os 3 pontos com maior chance de gerar reclamação no Brasil ou na UE, com a correção de menor custo possível para um desenvolvedor individual.

RESTRIÇÕES
- Não invente fatos. O que não estiver no Material A deve ser marcado como "A CONFIRMAR" e listado ao final.
- Não prometa o que não posso cumprir (ex.: não afirme que todos os dados ficam na China — o recurso de clima envia coordenadas a serviços no exterior).
- Terminologia fixa: BaZi / Quatro Pilares / Mestre do Dia / Dez Deuses / Caules Celestiais e Ramos Terrestres / Pilar de Sorte / Pilar Anual / Ben Ming Nian / Tai Sui. Evite "adivinhação" e "cartomancia"; use "metafísica chinesa tradicional" e "entretenimento cultural".
- Inclua sempre: conteúdo gerado por IA, apenas para estudo cultural e entretenimento; não constitui aconselhamento médico, jurídico, financeiro ou psicológico.

MATERIAL A
<<< cole a Seção 2 deste documento >>>
MATERIAL B
<<< cole a Seção 3 deste documento >>>
```

### 5.4 二轮校验提示词（拿到初稿后必跑）

```
现在做一次"反方审校"，假设你是监管方或被投诉用户的代理律师，专门找漏洞。

请针对你刚写的三版政策，逐项检查并给出结论（通过 / 不通过 + 理由）：
1. 有没有任何一句承诺，在「数据处理事实清单」里找不到对应事实？（包括"我们不会…""仅用于…""全部…"这类绝对化表述）
2. 有没有哪类数据被处理了，但政策里根本没提？（请对着事实清单的表格逐行点名）
3. 跨境传输部分：用户读完能不能明确知道"我的哪个数据、被谁、传到了哪个国家、依据是什么、我能不能拒绝"？如果读完仍有疑问，指出是哪一句。
4. 权利部分：用户想导出/删除数据，读完能不能自己操作成功？接口路径、前置条件（是否需登录）、预期耗时是否写清？
5. GDPR 第 13/14 条要求告知的 11 项，逐项打勾核对，缺哪项直接指出。
6. LGPD 第 9 条与第 18 条要求告知的项，逐项打勾核对。
7. 三语版本之间，有没有某条权利/义务只在一种语言里出现？列表指出。
8. 最后给一个"最快会被告的三个点"排序，并写明每个点的举证风险。
```

### 5.5 输出格式约定（贴在主提示词末尾可提高可用性）

```
输出格式：
- 审计与风险部分用 Markdown 表格。
- 政策正文用编号章节（一、二、三…），中文版可直接读；英文/葡语版用 1. 2. 3.。
- 政策正文中不要出现「[公司名称]」这类占位符；我的主体是「黄宁（个人开发者）」。
- 三版分别用 ``` 代码块包裹，方便我整段复制。
- 最后附「待补充清单」与「建议的生效日期/版本号」。
```

---

## 6. 回填指引（拿到定稿后改这些文件）

| 文件 | 改什么 |
|---|---|
| `public/privacy.html` | 整页正文替换；补齐 en/pt 文案需同步改成 `data-i18n` 标注 + 词库键（见 `I18N.md`） |
| `public/locales/{zh,en,pt}.json` | 新增 `privacy.*` 键段（建议按节拆分：`privacy.s1.title`、`privacy.s1.body`…） |
| `public/login.html`、`public/studio.html` | 勾选文案：若无独立用户协议，把两个链接合并为「《隐私政策》与《服务条款》」并指向各自页面；如暂不写服务条款，改为单一《隐私政策》 |
| `lib/schema.sql` → `user_agreements.version` | 政策改版后，同意记录的 `version` 默认值需同步升级（当前 `6.3.0`） |
| `server.js` | 若新增「拒绝自动化决策」「撤回埋点同意」入口，需加接口 |
| `README.md` / `docs/COMPLIANCE-WORDING.md` | 同步合规口径，避免文档漂移 |

**建议的落地顺序**：
1. 先补 3 个硬缺口（跨境披露、注销保留范围、用户协议链接）—— 这三项是"说到做不到/说错"，风险最高、改动最小；
2. 再做 GDPR/LGPD 三语版；
3. 最后补工程侧：`ai_audit` TTL 任务、`/api/me/export` 加 `ai_audit`/`events`、nginx 日志轮转、未成年年龄门槛。

---

## 7. 边界说明

- 本文档是**工程事实整理**，不是法律意见。第 1 节的风险判断基于条文常识，涉及行政处罚风险的具体结论需执业律师确认。
- 第 2 节标「待确认」的 5 项会影响政策表述，请先核实。
- ChatGPT 产出为初稿，**发布前建议至少人工通读一遍**：重点看"绝对化承诺"（全部/绝不/永久/从不）是否与事实清单一致。
