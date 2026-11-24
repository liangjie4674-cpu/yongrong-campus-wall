# 部署到 Abasthan（PaaS）

> 一句话：Abasthan 是 **PaaS（容器）**，不是 VPS。代码从 Git 仓库拉，平台自动构建、启动、配域名和 HTTPS。
> 你给的 `dashboard.abasthan.com/account/ssh` 是「账号 SSH 公钥」页面，不是服务器页面。

## 先看这个：这个项目在 PaaS 上的致命限制

本项目把**帖子、账号、图片**都存在本地文件里：

```
data/db.json     所有帖子 / 留言 / 用户账号
data/uploads/    上传的图片
```

而 PaaS 的容器文件系统是**临时的**：重新部署、重启、扩缩容都会重置容器，`data/` 里的东西会一起消失。

也就是说 —— 在 Abasthan 免费档上，**每次重新部署，全校的帖子和注册账号都会清零**。

所以：

| 用途 | 是否合适 |
| --- | --- |
| 给同学看一眼效果 / 演示 / 验收 | ✅ 可以 |
| 真的当校园墙长期用 | ❌ 不合适，数据会丢 |

真要长期用，两条路：

1. **换 VPS**（推荐）：阿里云 / 腾讯云轻量，1 核 1G 就够，本项目零依赖，`node server.js` 直接跑，数据落盘不丢。
2. **改造成数据库版**：把 `data/db.json` 换成 PostgreSQL / MongoDB（Abasthan 有，但数据库要付费档），改动量中等。

## 部署步骤（免费档，演示用）

### 1. 把代码推到 Git 仓库

平台只能从 Git 拉代码。仓库已经初始化好了（本地 `main` 分支，221 个文件，`data/` 已排除）：

```bash
cd yongrong-wall

# 方式 A：用 GitHub CLI（需要先 gh auth login）
gh repo create yongrong-wall --public --source=. --push

# 方式 B：先在 GitHub 网页上建一个空仓库，再
git remote add origin git@github.com:你的用户名/yongrong-wall.git
git push -u origin main
```

### 2. 加 SSH 公钥（可选，只用于进容器看日志）

在 <https://dashboard.abasthan.com/account/ssh> 点添加，粘贴：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL1/Bm/v8SBsAi+qHAU+Y2ANFYJvpWjGdnVcA+/nh+G1 yongrong-wall-deploy
```

之后连接：

```bash
ssh -p 22021 <24位应用ID>@connect.abasthan.com
# 进去是容器里的 shell，目录 /home/abasthan/app，没有 root
```

> 注意：这个 shell **不是用来部署的**，只是调试用。部署靠 Git。

### 3. 创建应用

Dashboard → 右上 `+ Create App` → **Web Service** → 选你的仓库和 `main` 分支。

配置项照这样填：

| 配置项 | 填什么 |
| --- | --- |
| App Language | `Node.js`（版本 20 或 22 都行） |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Root Directory | 留空（仓库根就是项目根） |
| Instance Type | `Free` |

### 4. 环境变量（必须填）

| Key | Value | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 你自己的强密码 | 不填就是默认 `yongrong-admin`，谁都能进后台 |
| `TRUST_PROXY` | `1` | 平台在前面有反代，不开的话限流会把所有人当成同一个 IP |

`PORT` 不用填，平台会注入，代码里已经读 `process.env.PORT`。

### 5. 点 Deploy，看构建日志

成功后会给你一个 `xxx.abasthan.app` 的域名，能直接访问，HTTPS 自带。

### 6. 验收

- 打开首页：能看到公益声明、3 条欢迎帖
- 右上角 👤 注册 → 发帖 → 进 `/admin` 用 `ADMIN_PASSWORD` 审核
- 手机浏览器「添加到主屏幕」，图标应该是校徽

## 上线后要盯的事

1. **别在后台随便点重新部署** —— 会清空数据。先想好数据怎么留。
2. 免费档只给 1 个应用、512MB 内存、0.1 核，人一多就卡。
3. 面向中国大陆的学生访问境外 PaaS，速度可能不稳；另外按规定，境内提供服务的网站需要 ICP 备案，境外托管不免除这个义务 —— 这点建议先问学校。
4. 定期备份：进容器 `tar czf /tmp/backup.tgz /home/abasthan/app/data` 再 SFTP 拉下来，能救急。

## 想换成 VPS 时

代码不用改，直接：

```bash
# 服务器上
cd /var/www && unzip 永荣校园墙-部署包.zip
cd yongrong-wall
ADMIN_PASSWORD=你的强密码 PORT=3000 node server.js

# 建议 pm2 守护（只跑一个实例，数据是单文件）
npm i -g pm2
ADMIN_PASSWORD=你的强密码 pm2 start server.js --name yongrong-wall
pm2 save && pm2 startup
```
