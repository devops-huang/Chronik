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

## 环境要求

- **Node.js ≥ 22.6**（需原生运行 `.ts` 模块；建议 22 LTS。`npm start` 已带 `--experimental-strip-types`）
- **PostgreSQL ≥ 14**

## 本地运行

```bash
git clone <本仓库地址> && cd <仓库目录>
npm install
# 准备 PostgreSQL，建库建用户（详见下方部署）
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=chenlu PGPASSWORD=xxx PGDATABASE=chenlu
export LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=qwen3.7-plus
npm start
# 打开 http://127.0.0.1:8787
```

环境变量优先级：`/api/chart`、`/api/chat` 等由前端传入或回退到服务端 `LLM_*`；`LLM_*` 仅服务端使用，
**密钥不进前端、不落盘到前端**。完整变量清单见 `.env.example`。

## 部署

项目目录即服务目录（仓库根含 `server.js` / `lib/` / `public/`），前端为纯静态文件、无需构建。

### 1. 准备数据库（PostgreSQL）

```bash
createdb chenlu          # 或登录 psql 后执行 CREATE DATABASE chenlu;
# 可选：创建专用账号并授权
```

### 2. 配置环境变量

```bash
cp .env.example .env
vim .env                 # 填入 PG* 与 LLM_*（LLM_API_KEY 为服务端密钥，切勿提交）
```

### 3. 安装依赖并启动

```bash
npm install
npm start
```

> 数据库表在首次启动时由 `initSchema()` **自动创建**，无需手动建表。

### 4.（可选）生产守护 systemd

`/etc/systemd/system/chenlu.service`：

```
[Unit]
Description=ChenLu Bazi System
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/chenlu
ExecStart=/usr/bin/node --experimental-strip-types server.js
EnvironmentFile=/opt/chenlu/.env
Restart=always
User=chenlu

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now chenlu
```

> ⚠️ 云主机安全组需放行 `TCP 8787`（如阿里云 ECS 控制台 → 安全组 → 入方向）。

### 5. 生产 HTTPS 域名部署（chronik.cn 示例）

本项目已提供 Nginx 反代 + Let's Encrypt 免费证书的一键方案（`infra/` 目录）。

**① 域名解析（在域名注册商控制台，如百度智能云）**

给 `chronik.cn` 添加两条 A 记录指向服务器公网 IP：

| 主机记录 | 类型 | 记录值 | 说明 |
|---|---|---|---|
| `@` | A | `服务器公网IP` | 根域名 chronik.cn |
| `www` | A | `服务器公网IP` | 子域名 www.chronik.cn |

添加后等待 DNS 生效（TTL 通常 10 分钟内），用 `dig +short chronik.cn` 确认已返回服务器 IP。

**② 放行端口（在云服务器安全组，如阿里云 ECS）**

入方向需放行 `TCP 80`（证书校验）与 `TCP 443`（HTTPS）。`8787` 在套了 Nginx 后可不再对外暴露。

**③ 服务器上执行一键脚本**

```bash
# 以 root 在仓库目录内执行
bash infra/setup-https.sh
```

脚本会自动：安装 Nginx + certbot → 写入反代配置 → 申请证书 → 重载 Nginx → 验证。

**④ 验证**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://chronik.cn/login.html   # 期望 200
curl -sS -I http://chronik.cn/login.html | grep -i location               # 应 301 到 https
```

证书由 certbot 的 systemd timer 自动续期，无需人工干预。

> 备注：Nginx 配置见 `infra/nginx/chronik.conf`，已针对 SSE 流式 AI 对话关闭代理缓冲。

## 说明

命理仅供文化娱乐参考，不构成医疗 / 法律 / 财务 / 投资建议。
