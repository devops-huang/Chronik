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
