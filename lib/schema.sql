-- 辰箓 · 数据表结构（幂等，可重复执行）

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      VARCHAR(40) NOT NULL UNIQUE,
  password      VARCHAR(200) NOT NULL,
  nickname      VARCHAR(40),
  email         VARCHAR(120),
  gender        SMALLINT DEFAULT 0,          -- 0 未填, 1 男, 2 女
  birth_calendar SMALLINT DEFAULT 0,         -- 0 未填, 1 阳历, 2 农历
  birth_date    VARCHAR(20),                 -- 1996-10-11
  birth_time    VARCHAR(10),                 -- 09:30
  birth_location VARCHAR(60),
  day_master    VARCHAR(10),                 -- 命盘日主五行（用于首页今日运势）
  weather_city  VARCHAR(40) DEFAULT '北京',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       VARCHAR(64) PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS charts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(80),
  input       JSONB NOT NULL,                -- 排盘请求参数
  chart       JSONB,                        -- 命盘核心字段（pillars/dayMaster…）
  interpret   JSONB,                        -- 解盘结果
  fortune     JSONB,                        -- 大运/流年/流月
  report_html TEXT,                         -- 完整黑金报告
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charts_user ON charts(user_id, created_at DESC);

-- ── 游客免登录试用（5.1）──
-- charts 支持匿名归属：user_id 可空，anon_id 标记游客会话
ALTER TABLE charts ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE charts ADD COLUMN IF NOT EXISTS anon_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_charts_anon ON charts(anon_id) WHERE anon_id IS NOT NULL;

-- 匿名频次限制（防刷 LLM 额度）
CREATE TABLE IF NOT EXISTS anon_chart_rate (
  ip           TEXT PRIMARY KEY,
  cnt          INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS anon_chat_rate (
  anon_id TEXT PRIMARY KEY,
  rounds  INT NOT NULL DEFAULT 0
);

-- ── 对话历史持久化（5.2）──
-- 每次排盘对应一段独立对话；conversations.user_id 关联用户（删号级联物理删除），
-- anon_id 兼容游客匿名会话（注册后并入账号）。messages 级联删除，无软删。
CREATE TABLE IF NOT EXISTS conversations (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  anon_id     VARCHAR(64),
  chart_id    BIGINT REFERENCES charts(id) ON DELETE CASCADE,
  title       VARCHAR(120),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_user  ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_anon  ON conversations(anon_id) WHERE anon_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_chart ON conversations(chart_id);

CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             VARCHAR(20) NOT NULL,        -- 'user' | 'assistant'
  content          TEXT NOT NULL,
  tokens           INT,                          -- 估算 token 数（成本/上下文窗口用）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at ASC);

-- ── 今日运势真个性化（5.3）──
-- 四元引擎需要「日主天干 + 月令地支」。二者只由出生日期决定（与时辰无关），
-- 因此未填时辰、未排过盘的用户也可由 birth_date 现算并回填，不必强制先排盘。
ALTER TABLE users ADD COLUMN IF NOT EXISTS day_stem  VARCHAR(4);  -- 日主天干（甲…癸）
ALTER TABLE users ADD COLUMN IF NOT EXISTS month_zhi VARCHAR(4);  -- 月令地支（子…亥）

-- 「为什么」展开率埋点（驱动指标：运势卡片展开「为什么」的比例）
-- 游客无 user_id，故保留 anon_id；按天 + 动作聚合即可算出展开率。
CREATE TABLE IF NOT EXISTS fortune_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
  anon_id    VARCHAR(64),
  day        DATE NOT NULL DEFAULT (now()::date),
  action     VARCHAR(32) NOT NULL,             -- 'expand_why'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fortune_events_day ON fortune_events(day, action);

-- ── 密码重置通道（R0 · 认证修复后强制全量重置）──
-- 旧版伪同步哈希全部失效，用户需凭重置 token 设新密码。
-- token 由服务端随机生成；生产环境经邮件下发，自托管/无 SMTP 时由接口回传。
CREATE TABLE IF NOT EXISTS password_resets (
  token      VARCHAR(64) PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);

-- ── AI 输出留痕（R1† · V3 合规，留存 ≥6 月）──
-- 每次 AI 答疑的 input/output 摘要、命中禁区标记与用户标识，供合规审计与投诉核查。
CREATE TABLE IF NOT EXISTS ai_audit (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  anon_id    VARCHAR(64),
  conversation_id BIGINT,
  model      VARCHAR(60),
  input_snippet  TEXT,                 -- 用户输入摘要（截断）
  output_snippet TEXT,                -- AI 输出摘要（截断）
  blocked    BOOLEAN NOT NULL DEFAULT false,
  category   VARCHAR(8),              -- 命中 §6.1 类别 A–J（命中时）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aiaudit_created ON ai_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiaudit_user ON ai_audit(user_id) WHERE user_id IS NOT NULL;

-- ── 用户举报 / 投诉入口（R1-5）──
CREATE TABLE IF NOT EXISTS reports (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  anon_id    VARCHAR(64),
  target     VARCHAR(40) NOT NULL DEFAULT 'ai',  -- 'ai' | 'content' | 'user'
  detail     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- ── R2† 隐私数据权利闭环（V1 / V2）──
-- anon_chart_rate 增加匿名归属列，使「六表删除」能按匿名 ID 覆盖
ALTER TABLE anon_chart_rate ADD COLUMN IF NOT EXISTS anon_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_anon_chart_rate_anon ON anon_chart_rate(anon_id) WHERE anon_id IS NOT NULL;

-- 游客匿名 ID ↔ 注册用户映射（合并与一键删除双条件）
CREATE TABLE IF NOT EXISTS user_anon_link (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anon_id VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, anon_id)
);
CREATE INDEX IF NOT EXISTS idx_anonlink_anon ON user_anon_link(anon_id);

-- 同意记录（PIPL 第14条 明示同意，R2-5）
CREATE TABLE IF NOT EXISTS user_agreements (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(24) NOT NULL DEFAULT 'terms',  -- terms（用户协议） | privacy（隐私政策）
  version    VARCHAR(16) NOT NULL DEFAULT '6.3.0',
  agreed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_agreements_user ON user_agreements(user_id);

-- ── R3 · 业务埋点单表（G1 可观测 / 漏斗）。action 走白名单，payload 存任意扩展字段 ──
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  action     VARCHAR(48) NOT NULL,
  payload    JSONB,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  anon_id    VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_action_time ON events(action, created_at);
CREATE INDEX IF NOT EXISTS idx_events_anon ON events(anon_id) WHERE anon_id IS NOT NULL;

-- ── 孤儿数据 TTL 清理（V2 硬门槛：user_id IS NULL AND created_at < now()-30d）──
-- 生产由 cron 调用 tools/cleanup-orphans.mjs；此处仅保证 schema 支持。
-- charts / conversations / messages / fortune_events 已含 user_id 可空 + created_at。

