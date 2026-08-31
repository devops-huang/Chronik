# 辰箓 · Chen Lu Destiny

面向 **To C 用户**的国风命理平台：八字排盘 + 命理答疑 + 个人命盘档案。用户输入阳历 / 农历的
出生年月日时、出生地、性别，系统做**真太阳时校正**并排出完整命盘，生成黑金风格报告；登录后
所有命盘推演数据存入 **PostgreSQL**，并在首页呈现万年历、今日运势、天气、阴阳建议等动态看板。

## 页面

- `/login.html` — 登录 / 注册（动态太极八卦背景）
- `/index.html` — 天机阁首页（需登录）：旋转八卦太极动画、万年历、今日运势、天气（ECharts 24h 温度线）、阴阳建议、最近命盘
- `/studio.html` — 排盘工作室（需登录）：左侧表单、中间大模型答疑（Markdown 渲染）、右侧命盘报告预览（可全屏 / 导出 / 打印）

## 功能

- **双历法输入** + **真太阳时校正**（按出生地经度回拨，跨时辰提示时柱变化）
- **完整命盘报告**：四柱、五行、格局用神、大运、流年、流月、分领域解读、三句话总结
- **账号体系**：注册 / 登录，session 存库（httpOnly cookie），密码 scrypt 哈希
- **数据持久化**：用户资料 + 每次排盘（输入 / 命盘 / 解盘 / 报告 HTML）存入 PostgreSQL
- **首页动态看板**：万年历（农历 + 日干支）、今日运势（结合用户命盘五行）、Open-Meteo 天气（免 Key）、阴阳建议
- **大模型答疑**：OpenAI 兼容接口，服务端预置阿里云百炼 `qwen3.7-plus`，流式输出，回答经 marked + DOMPurify 渲染为 Markdown

## 架构

```
public/          前端（login / index / studio + style.css）
lib/db.js        pg 连接池 + 幂等建表（schema.sql）
lib/auth.js      注册 / 登录 / 会话 / 资料
lib/home.js      万年历 / 今日运势 / 天气 / 阴阳建议
lib/chart.js     排盘（cantian-tymext 封装）
lib/core.js      编排：排盘 → 查运 → 拆盘 → 解盘 → 报告
lib/interpreter.js  命理规则引擎
lib/report.js    黑金 HTML 报告
server.js        HTTP 路由（零内置依赖 + pg）
```

## 本地运行

```bash
cd bazi-system
npm install
# 准备 PostgreSQL，建库建用户，写入环境变量（见 .env.example）
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=chenlu PGPASSWORD=xxx PGDATABASE=chenlu
export LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=qwen3.7-plus
npm start
```

环境变量优先级：`/api/chart`、`/api/chat` 等由前端传入或回退到服务端 `LLM_*`；`LLM_*` 已写入
服务端 `.env`，**密钥不进前端、不落盘到前端**。

## 部署（云主机）

`../deploy/deploy.mjs` 自动：安装 Node22 + PostgreSQL 16（官方源）、上传项目、npm install、
写 `.env`、注册 systemd 服务（开机自启、崩溃重启）。数据库表在首次启动时由 `initSchema()` 自动创建。

> 注意：阿里云 ECS 安全组默认拦截 8787，需在**控制台 → 安全组 → 入方向**放行 `TCP 8787` 后方可外网访问。

## 说明

命理仅供文化娱乐参考，不构成医疗 / 法律 / 财务 / 投资建议。
