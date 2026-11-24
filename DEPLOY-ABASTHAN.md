# 部署到 Abasthan（PaaS）

> Abasthan 是 **PaaS（容器）**，不是 VPS：代码从 Git 仓库拉，平台自动构建、启动、发域名、配 HTTPS。
> 你之前打开的 `dashboard.abasthan.com/account/ssh` 是「账号 SSH 公钥」页面，不是服务器页面。

## 关键前提：一定要配数据库

PaaS 的容器文件系统是**临时的**：重新部署、重启、扩缩容都会重置容器，写进容器里的文件会一起消失。

所以本项目做了双后端（见 `lib/store.js`），由环境变量 `DATABASE_URL` 决定：

| 模式 | 触发条件 | 数据存哪 | 重新部署会丢吗 |
| --- | --- | --- | --- |
| PostgreSQL | 配了 `DATABASE_URL` | 库表 `wall_doc`（帖子/账号/留言/设置）+ `wall_file`（图片） | ❌ 不会 |
| 本地文件 | 没配 | 容器内 `data/db.json` + `data/uploads/` | ✅ 会丢 |

**上线必须走 PostgreSQL 模式**，否则每次重新部署，全校的帖子和注册账号都会清零。

表结构由程序启动时自动创建（`CREATE TABLE IF NOT EXISTS`），不需要手动导 SQL。

---

## 部署步骤

### 1. 创建 PostgreSQL 实例

Dashboard → `+ Create App` → **Data Store Services → PostgreSQL**。

建好后在它的连接信息里拿到连接串，长这样：

```
postgres://用户名:密码@主机:5432/库名
```

> 如果平台给的是分开的 host / port / user / password / database 五项，自己拼成上面这一整串。
> 如果连接串带 `?sslmode=require`，留意下一步的 `PGSSL`。

### 2. 创建 Web Service

Dashboard → `+ Create App` → **App Services → Web Service** → 选 GitHub 仓库
`liangjie4674-cpu/yongrong-campus-wall`，分支 `main`。

| 配置项 | 填什么 |
| --- | --- |
| App Language & Version | `Node.js`（20 或 22 都行，本项目要求 ≥ 18） |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Root Directory | 留空（仓库根就是项目根） |
| Instance Type | `Free`（演示）／`Starter`（正式用） |

### 3. 环境变量（三个都要）

| Key | Value | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 你自己的强密码 | **必须改**。不填就是默认 `yongrong-admin`，谁都能进后台 |
| `DATABASE_URL` | 上一步拿到的 `postgres://…` 整串 | 不填就退回本地文件模式，重新部署会丢数据 |
| `TRUST_PROXY` | `1` | 平台前面有反代，不开的话限流会把所有人当成同一个 IP |
| `PGSSL` | `1`（可选） | 数据库要求 SSL 时加。连接串里已带 `sslmode=require` 也可以加 |

`PORT` 不用填，平台会注入，代码读 `process.env.PORT`。

### 4. 点 Deploy，看构建日志

启动日志里应该出现这两行：

```
[存储] PostgreSQL 模式：帖子、账号、图片都在数据库里，重新部署不会丢
永荣校园墙已启动：http://localhost:xxxx
```

如果看到 `[存储] 本地文件模式` 或 `连接数据库失败，降级为本地文件模式`，说明 `DATABASE_URL` 没生效或连不上 —— **别忽略这条，先去修**。

### 5. 验收清单

- 首页能打开，顶部有橙色「📣 麻烦大家多多宣传此校园墙…永久公益、不收费」提示条
- 右上角 👤 注册（账号 + 密码 + 昵称）→ 发帖 → 进 `/admin` 用 `ADMIN_PASSWORD` 审核 → 前台能看到
- 发一条带图的帖子，审核通过后图片能正常显示
- **最关键一步**：在 Abasthan 点一次「重新部署」，等它起来后刷新页面 —— 刚才发的帖子和注册的账号**还在**，说明数据库接通了
- 手机浏览器「添加到主屏幕」，图标应该是校徽

---

## 常见问题

**构建成功但访问 502 / 无法连接**
容器没监听平台要求的端口。确认 Start Command 是 `npm start`，且没有自己写死 `PORT`。

**启动日志是「本地文件模式」**
`DATABASE_URL` 没配上，或格式不是 `postgres://` 开头（`postgresql://` 也认）。

**「连接数据库失败」+ 一串报错**
常见三种：连接串里的密码有特殊字符没转义；数据库只允许同项目内网访问而两个服务不在一个 project；数据库要求 SSL 但没开 `PGSSL=1`。

**进容器看日志 / 调试**

```bash
ssh -p 22021 <24位应用ID>@connect.abasthan.com
# 进去是容器 shell，工作目录 /home/abasthan/app，没有 root
```

> 这个 shell 只用于调试，**不能用来部署**。部署永远靠 Git 推送后重新构建。

**免费档够用吗**
512MB 内存、0.1 核，几十个人同时刷会卡。给全校用建议至少 `Starter`。

**境外 PaaS 的两个现实问题**
面向中国大陆学生访问速度可能不稳；另外按规定，境内提供服务的网站需要 ICP 备案，境外托管不免除这个义务 —— 建议先问学校。

---

## 备份

图片也存进数据库了，所以**一个 `pg_dump` 就能全带走**：

```bash
pg_dump "postgres://用户名:密码@主机:5432/库名" > yongrong-backup-$(date +%F).sql
```

恢复：`psql "连接串" < yongrong-backup-2026-11-24.sql`

---

## 想换成 VPS 时

代码不用改，VPS 上可以直接用本地文件模式（磁盘是持久的）：

```bash
cd /var/www && git clone https://github.com/liangjie4674-cpu/yongrong-campus-wall.git
cd yongrong-campus-wall && npm install
ADMIN_PASSWORD=你的强密码 PORT=3000 node server.js

# 建议 pm2 守护
npm i -g pm2
ADMIN_PASSWORD=你的强密码 pm2 start server.js --name yongrong-wall
pm2 save && pm2 startup
```

VPS 上如果也想用数据库，照样配 `DATABASE_URL` 即可，两种模式随时切换。
