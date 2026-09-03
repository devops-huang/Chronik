# 辰箓 Chronik v6.3.0 · 部署影响评估与回滚预案

> 生成方：Deployment Engineer 子代理（仅做部署准备，未执行生产发布）
> 范围：从 `v6.2.0` (HEAD `c857bc7`) 到 `v6.3.0` 的本地工作树改动
> 状态：**待人工审批后发布** —— 需要可达 PG + 有效 SSH 凭证 + 用户明确授权

---

## 1. 改动文件按需求归类

### R0 · 账号安全修复（紧急）
- `lib/auth.js` — 接入真 scrypt 校验、新增 `requestPasswordReset` / `resetPassword` 流程
- `lib/db.js` — `hashPassword` / `verifyPassword`（timingSafeEqual）/ `isLegacyHash`
- `public/login.html` `public/login.js` — 重置密码入口与流程
- `tools/test-auth.mjs` — R0 单元/集成测试

### R10a · 站点安全与备案占位
- `server.js` — 安全响应头、隐藏内部错误；`public/index.html` 页脚 ICP 占位

### R1† · 内容安全与免责闭环
- `lib/content-policy.js`（新增）— 禁区词表与命中判定
- `lib/db.js` / `lib/schema.sql` — `ai_audit` 表（AI 输出留痕 ≥6 月）
- `lib/report.js` `server.js` `public/studio.*` `public/index.*` — L1/L2/L3 免责位、AI 生成标注、举报入口
- `tools/test-content-policy.mjs`（新增，本地 30/30 通过）

### R2† · 隐私政策与数据权利
- `lib/schema.sql` — `user_agreements`、`user_anon_link`、`anon_chart_rate.anon_id`、`reports`
- `server.js` `public/app.js` — 导出/删除 + 可验证回执、主动勾选同意
- `public/privacy.html`（新增）— 独立隐私政策页
- `tools/cleanup-orphans.mjs`（新增）— 游客孤儿数据 30 天 TTL
- `tools/test-gdpr.mjs`（新增）

### R5a · AI 答疑降级兜底
- `server.js` `public/studio.js` — 检索式兜底 + 重试按钮 + 免责

### R4† · 稳定部署与健康检查
- `server.js` — `/api/health` 返回 `{ ok, version:"6.3.0", commit }`
- `package.json` — version 6.3.0
- `tools/qa-gates.mjs`（新增）— 质量门禁
- `tools/deploy.mjs`（新增）— 本版部署脚本
- `infra/chronik.service`（新增）— systemd 单元

### R3 · 使用数据埋点
- `lib/schema.sql` — `events` 表
- `server.js` `public/index.js` `public/app.js` — action 白名单埋点
- `tools/funnel.mjs`（新增）— 漏斗分析

### R6† · 流年年历（留存钩子）
- `public/nianli.html` `public/nianli.js`（新增）
- `server.js` `lib/report.js` `public/studio.*` — 12 月运势 + 固定娱乐角标

---

## 2. ⚠ 破坏性变更（务必先周知）

**R0 认证修复是破坏性变更。** 旧版 `scryptSync` 为伪同步实现，返回全零派生值 → 任意密码均可登录（`isLegacyHash` 即检测「盐 + 128 个 0」）。v6.3.0 改用真 scrypt：

- **所有历史密码哈希立即失效**：任何用户都无法用旧密码登录。
- **必须全量强制重置密码**：上线后用户首次登录走 `/api/request-password-reset` → 凭 token 设新密码。
- **沟通窗口**：发布前须通过站内公告 / 邮件 / 页脚横幅告知用户「密码已失效，请重置」。
- **回滚不可逆性（见第 5 节）**：此数据状态是单向向前的 —— 回滚代码无法恢复旧密码，用户仍需重置。

---

## 3. 数据库迁移评估

`initSchema()` 在启动期幂等执行 `schema.sql`（`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`），新表随服务启动自动创建，无需手动 migration。核对 v6.3.0 新增对象是否齐备：

| 对象 | 类型 | 状态 |
|---|---|---|
| `password_resets` | 表 | ✅ schema.sql:105 |
| `ai_audit` | 表 | ✅ schema.sql:116 |
| `reports` | 表 | ✅ schema.sql:132 |
| `user_anon_link` | 表 | ✅ schema.sql:148 |
| `user_agreements` | 表 | ✅ schema.sql:157 |
| `events` | 表 | ✅ schema.sql:167 |
| `anon_chart_rate.anon_id` | 列 | ✅ schema.sql:144 |

> 注：`fortune_events`（5.3 已存在）与 `anon_chart_rate`/`conversations`/`messages` 上的匿名删除支持一并满足 R2†「六表删除」。

**确认命令（需可达 PG，本沙箱无法执行）：**
```bash
PGHOST=... psql -f lib/schema.sql   # initSchema 已在启动期等价执行
```

---

## 4. 环境与配置前置

**必须存在于生产 `.env`（已 git-ignore，确认见下）：**
- `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`
- `PORT`（默认 8787）
- `ICP_NO`（页脚备案号，备案核发后填）
- LLM 预设（`LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_CFG_SECRET`）经 admin 设置

**git-ignore 核对：** `.gitignore` 已含 `node_modules/` 与 `.env`（及 `.env.*.local`）。✅ 密钥不会被提交。
**Node 版本：** 需 ≥ 22.6（`package.json` 使用 `--experimental-strip-types`）。当前本地 `v22.22.2` 满足。

---

## 5. 质量门禁（qa-gates）就绪度

| 门禁 | 是否需活 PG+运行服务 | 就绪度 |
|---|---|---|
| R10a 安全头 / ICP 占位 | 否（静态可扫） | ✅ 文件可扫 |
| R6† 免责角标 | 否（静态字符串） | ✅ 文件可扫 |
| L1 / L2 / L3 免责文案 | 否（静态） | ✅ 文件可扫 |
| R4† `/api/health` 形状 | 部分（需运行服务校验响应体） | ✅ 形状可静态核对 |
| R1† 内容策略 | 否（本地逻辑，`test-content-policy.mjs` 30/30 通过） | ✅ 本地已绿 |
| R0 认证流 | **是**（需活 PG + `/api/login`） | ⏳ `tools/test-auth.mjs` 待活环境 |
| R2† GDPR 导出/删除 | **是**（需活 PG） | ⏳ `tools/test-gdpr.mjs` 待活环境 |
| R5a 兜底 / R3 埋点 | **是**（需运行服务） | ⏳ 待活环境 |

> 本沙箱无可达 PG，故仅 R1† 单元层（30/30）与本影响评估可本地验证。

---

## 6. 回滚预案（Rollback）

1. **代码回滚（可逆）：**
   ```bash
   ssh <prod> 'cd /opt/chronik && sudo systemctl stop chronik'
   # 在部署机：DEPLOY_EXEC=1 部署上一已知好版本，或直接
   ssh <prod> 'cd /opt/chronik && git fetch && git checkout v6.2.0'
   ssh <prod> 'sudo systemctl restart chronik'
   ```
2. **数据库：无需回滚 schema。** v6.3.0 新增表/列均为 `IF NOT EXISTS` 追加，v6.2.0 代码忽略它们，兼容。
3. **⚠ 单向数据状态：** 强制密码重置后的新哈希会写入 `users.password`。回滚到 v6.2.0 **不会恢复旧密码**，且 v6.2.0 的伪同步漏洞会重新暴露 —— 因此回滚是临时止血，必须尽快重新发布修复版，并再次通知用户重置。
4. **回滚验证：** `curl -fsS https://chronik.cn/api/health` 应返回 `version:"6.2.0"`。

---

## 7. BEFORE PROD PUSH —— 人工审批清单

- [ ] 用户已明确授权生产变更
- [ ] 生产 SSH 凭证有效（当前沙箱凭证被拒，须更换/确认）
- [ ] 生产 PostgreSQL 可达
- [ ] `.env` 在 `/opt/chronik/.env` 就位且含全部必需变量
- [ ] 已发布「密码将失效、请重置」的用户公告

**人工执行的真实发布命令（本子代理不执行）：**
```bash
# 1) 本地打 tag 已做：v6.3.0
# 2) 真实部署（需先满足上面 4 项）：
DEPLOY_EXEC=1 ENV_SYNC=1 node tools/deploy.mjs
# 3) 健康检查：
curl -fsS https://chronik.cn/api/health   # 期望 { ok:true, version:"6.3.0", commit:"<sha>" }
```
