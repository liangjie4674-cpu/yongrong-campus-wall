'use strict';
/**
 * 永荣校园墙 · 后端（零依赖，Node.js >= 18）
 * 运行：node server.js
 * 环境变量：
 *   PORT（默认 3000）
 *   ADMIN_PASSWORD（管理员密码；未设置时用默认 yongrong-admin 并在启动日志告警，上线务必修改）
 *   TRUST_PROXY=1 时才信任 X-Forwarded-For（部署在可信反代之后再开；默认只用真实连接 IP，防限流绕过）
 *   DATABASE_URL=postgres://…（配了就把帖子和图片都存数据库，容器重建不丢；不配则用本地文件）
 *   PGSSL=1（数据库要求 SSL 时开启）
 * 数据：DATABASE_URL 优先，否则 data/db.json（原子写入）；上传图片同上
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'yongrong-admin';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const CATEGORIES = ['表白', '吐槽', '求助', '失物招领', '日常', '树洞'];
const MAX_CONTENT = 500;
const MAX_COMMENT = 200;
const MAX_NAME = 16;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 单张图片上限 5MB

// 简单敏感词（命中仅在管理端标黄提示，不自动拒绝；审核由管理员决定）
const SENSITIVE_WORDS = ['加微信', '加qq', '代考', '出售答案', '赌博', '博彩', '贷款'];
// 保留昵称：不允许普通用户冒充官方
const RESERVED_NAMES = ['墙墙管理员', '管理员', '官方', '永荣校园墙', 'admin', '站长'];

process.on('unhandledRejection', err => console.error('未处理的 Promise 异常（已兜底）:', err && err.message));
process.on('uncaughtException', err => console.error('未捕获异常（已兜底）:', err && err.message));

/* ---------------- 数据层 ---------------- */
let db = { posts: [], users: [], settings: { announcement: '' } };

function seed() {
  const now = Date.now();
  const mk = (content, author, category, daysAgo, likes, views) => ({
    id: crypto.randomUUID(),
    content, author, anonymous: false, category,
    status: 'approved', flagged: false, pinned: false, image: null,
    likes, views,
    createdAt: now - daysAgo * 86400000,
    comments: []
  });
  db.posts = [
    mk('欢迎来到永荣校园墙！这里崇尚自由言论：对学校有不满可以提，想表白可以说，心里话不必藏着。匿名、实名都可以，畅所欲言——所有帖子都会先经过管理员审核再展示，记得文明发言。', '墙墙管理员', '日常', 2, 66, 520),
    mk('失物招领：昨天下午在食堂二楼捡到一串钥匙，挂着蓝色小熊挂件，失主留言认领。', '墙墙管理员', '失物招领', 1, 23, 301),
    mk('新学期新气象，祝大家这学期都顺顺利利，考的都会，蒙的都对！', '墙墙管理员', '日常', 0, 41, 268)
  ];
  saveNow();
}

/** 启动时加载数据：先定存储后端，再把文档读进内存 */
async function initData() {
  const mode = await store.init({ dataDir: DATA_DIR, dbFile: DB_FILE, uploadDir: UPLOAD_DIR });
  console.log(mode === 'postgres'
    ? '[存储] PostgreSQL 模式：帖子、账号、图片都在数据库里，重新部署不会丢'
    : '[存储] 本地文件模式：data/db.json —— 容器重建/重新部署会丢数据');

  let parsed = null;
  try {
    parsed = await store.readDoc();
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      // 读取失败（文件损坏 / 权限 / 数据库异常）：本地文件先备份，绝不静默覆盖
      console.error('数据读取失败:', err.message);
      if (mode === 'file') {
        try {
          if (fs.existsSync(DB_FILE)) fs.renameSync(DB_FILE, DB_FILE + '.bad-' + Date.now());
        } catch { /* 备份失败也不阻断启动 */ }
      }
    }
  }

  if (!parsed) {
    db = { posts: [], users: [], settings: { announcement: '' } };
    seed();
    return;
  }
  if (!Array.isArray(parsed.posts)) {
    console.error('数据格式不正确（posts 不是数组），已重建为空库');
    db = { posts: [], users: [], settings: { announcement: '' } };
    seed();
    return;
  }

  db = parsed;
  if (!db.settings) db.settings = { announcement: '' };
  if (!Array.isArray(db.users)) db.users = [];
  // 兼容旧数据：补齐新字段
  for (const p of db.posts) {
    if (p.pinned === undefined) p.pinned = false;
    if (p.image === undefined) p.image = null;
    if (!Array.isArray(p.comments)) p.comments = [];
    if (p.userId === undefined) p.userId = null;
  }
}

let saveTimer = null;
let writeChain = Promise.resolve();
let lastWrite = null; // 最近一次写入结果，便于需要时等待

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeDb(); }, 120);
}
function writeDb() {
  // 串行化：保证先发起的写不会后落地
  writeChain = writeChain
    .then(() => store.writeDoc(db))
    .catch(err => console.error('保存数据失败:', err.message));
  lastWrite = writeChain;
  return writeChain;
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return writeDb();
}
/** 退出前等写入落盘，避免最后一次改动丢失 */
async function flushWrites() {
  try { await (lastWrite || writeChain); } catch { /* 已在 writeDb 内记录 */ }
}

/* ---------------- 工具 ---------------- */
function normalizeForScan(s) {
  // 去零宽字符/空白/常见分隔符后再匹配，防“加 微 信”这类绕过
  return String(s).toLowerCase().replace(/[\s​-‍﻿·.。,，、|_-]+/g, '');
}
function isFlagged(text) {
  const t = normalizeForScan(text);
  return SENSITIVE_WORDS.some(w => t.includes(normalizeForScan(w)));
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function cleanName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** 保留昵称不允许普通用户占用，防冒充官方 */
function isReservedName(name) {
  const lower = String(name || '').toLowerCase();
  return RESERVED_NAMES.some(r => lower === r.toLowerCase());
}

function publicPost(p, { withComments = false } = {}) {
  const approvedComments = p.comments.filter(c => c.status === 'approved');
  const out = {
    id: p.id,
    content: p.content,
    author: p.anonymous ? '匿名同学' : (p.author || '匿名同学'),
    anonymous: !!p.anonymous,
    category: p.category,
    pinned: !!p.pinned,
    image: p.image || null,
    likes: p.likes,
    views: p.views,
    createdAt: p.createdAt,
    commentCount: approvedComments.length
  };
  if (withComments) {
    out.comments = approvedComments.map(c => ({
      id: c.id,
      content: c.content,
      author: c.anonymous ? '匿名同学' : (c.author || '匿名同学'),
      anonymous: !!c.anonymous,
      createdAt: c.createdAt
    }));
  }
  return out;
}

function hotScore(p) {
  return p.likes * 3 + p.views + p.comments.filter(c => c.status === 'approved').length * 5;
}

/* ---------------- 限流（键为真实连接 IP；TRUST_PROXY=1 时才采信 XFF） ---------------- */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const rateBuckets = new Map();
const MAX_BUCKETS = 5000;
function rateLimit(req, limit, windowMs) {
  const ip = clientIp(req);
  const now = Date.now();
  let arr = rateBuckets.get(ip);
  if (!arr) {
    if (rateBuckets.size >= MAX_BUCKETS) {
      // 桶数上限：清掉最旧的一批，防止伪造键撑爆内存
      let n = 0;
      for (const k of rateBuckets.keys()) { rateBuckets.delete(k); if (++n >= 1000) break; }
    }
    arr = [];
    rateBuckets.set(ip, arr);
  }
  while (arr.length && now - arr[0] >= windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateBuckets) {
    while (arr.length && now - arr[0] >= 3600000) arr.shift();
    if (!arr.length) rateBuckets.delete(k);
  }
}, 600000).unref();

/* 浏览/点赞去重：同一 IP 对同一帖，TTL 内只计一次 */
const dedupMap = new Map();
function dedupHit(kind, ip, postId, ttlMs) {
  const key = kind + ':' + ip + ':' + postId;
  const now = Date.now();
  const last = dedupMap.get(key);
  if (last && now - last < ttlMs) return true;
  dedupMap.set(key, now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of dedupMap) if (now - t >= 86400000) dedupMap.delete(k);
}, 3600000).unref();

/* ---------------- 管理员会话 ---------------- */
const adminTokens = new Map(); // token -> { createdAt, ua }
const TOKEN_TTL = 12 * 3600000;
function adminAuth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const rec = adminTokens.get(m[1]);
  if (!rec) return false;
  if (Date.now() - rec.createdAt > TOKEN_TTL) { adminTokens.delete(m[1]); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, rec] of adminTokens) if (now - rec.createdAt > TOKEN_TTL) adminTokens.delete(t);
}, 3600000).unref();

function passwordOk(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len); a.copy(pa);
  const pb = Buffer.alloc(len); b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

/* ---------------- 普通用户账号（注册即可发帖，无邮箱/短信验证） ---------------- */
const userTokens = new Map(); // token -> { userId, createdAt }
const USER_TOKEN_TTL = 30 * 86400000; // 30 天免登录
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 64;
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/;

/** scrypt 加盐哈希，零依赖；参数固定以便长期可校验 */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function createUser(username, password, name) {
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(),
    username,
    name,
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now()
  };
  db.users.push(user);
  return user;
}

function verifyUser(username, password) {
  const target = String(username || '').trim().toLowerCase();
  const user = db.users.find(u => u.username.toLowerCase() === target);
  if (!user) return null;
  const a = Buffer.from(hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? user : null;
}

function bearerToken(req) {
  const m = /^Bearer ([0-9a-f]{48})$/.exec(req.headers['authorization'] || '');
  return m ? m[1] : null;
}

function issueUserToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  userTokens.set(token, { userId: user.id, createdAt: Date.now() });
  return token;
}

function userAuth(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const rec = userTokens.get(token);
  if (!rec) return null;
  if (Date.now() - rec.createdAt > USER_TOKEN_TTL) { userTokens.delete(token); return null; }
  const user = db.users.find(u => u.id === rec.userId);
  if (!user) { userTokens.delete(token); return null; }
  return user;
}

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, createdAt: u.createdAt };
}

/** 管理端展示用：这条内容来自哪个账号（昵称 + @账号） */
function accountLabel(item) {
  if (!item || !item.userId) return '';
  const u = db.users.find(x => x.id === item.userId);
  return u ? (u.name + ' @' + u.username) : '';
}

/** 昵称校验：非空、不超长、不占用官方保留名 */
function validateNickname(raw) {
  const name = cleanName(raw);
  if (!name) return { error: '请填写昵称' };
  if (isReservedName(name)) return { error: '这个昵称是官方保留的，换一个吧' };
  return { name };
}

setInterval(() => {
  const now = Date.now();
  for (const [t, rec] of userTokens) if (now - rec.createdAt > USER_TOKEN_TTL) userTokens.delete(t);
}, 3600000).unref();

/* ---------------- HTTP 基础 ---------------- */
function sendJson(res, code, obj) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) { reject(Object.assign(new Error('请求体过大'), { code: 413 })); return; }
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON 格式不正确'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJson(res, 404, { error: '文件不存在' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; connect-src 'self'";
      headers['Cache-Control'] = 'no-cache';
    } else if (['.css', '.js', '.woff2', '.woff', '.ttf', '.png', '.svg', '.ico'].includes(ext)) {
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.join(PUBLIC_DIR, '.' + rel);
  const base = path.resolve(PUBLIC_DIR);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  serveFile(res, resolved);
}

async function serveUpload(req, res, name) {
  // name 只允许服务端生成的文件名格式，杜绝穿越
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/.test(name)) return sendJson(res, 404, { error: '文件不存在' });
  // 图片随帖子一起审核：只有已通过帖子的图片可公开访问；待审/未通过的图片仅管理员（带 token）可看
  const ref = '/uploads/' + name;
  const isPublic = db.posts.some(p => p.image === ref && p.status === 'approved');
  if (!isPublic && !adminAuth(req)) return sendJson(res, 404, { error: '文件不存在' });

  let file = null;
  try {
    file = await store.getFile(name);
  } catch (err) {
    console.error('读取图片失败:', err.message);
  }
  if (!file) return sendJson(res, 404, { error: '文件不存在' });

  res.writeHead(200, {
    'Content-Type': file.mime,
    'Content-Length': file.bytes.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(file.bytes);
}

/* ---------------- 路由 ---------------- */
async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: '请求地址不正确' });
  }
  const pathname = url.pathname;
  const method = req.method;
  const ip = clientIp(req);

  /* ---- 公开接口 ---- */
  if (pathname === '/api/site' && method === 'GET') {
    return sendJson(res, 200, { announcement: (db.settings && db.settings.announcement) || '' });
  }

  /* ---- 账号：注册即可用，不做邮箱/短信验证 ---- */
  if (pathname === '/api/auth/register' && method === 'POST') {
    if (!rateLimit(req, 8, 600000)) return sendJson(res, 429, { error: '注册太频繁，请 10 分钟后再试' });
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: '账号需为 3-20 位字母、数字、下划线或中文' });
    const password = String(body.password || '');
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return sendJson(res, 400, { error: '密码需为 ' + MIN_PASSWORD + '-' + MAX_PASSWORD + ' 位' });
    }
    const nick = validateNickname(body.name);
    if (nick.error) return sendJson(res, 400, { error: nick.error });
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { error: '这个账号已经被注册了，换一个或直接登录' });
    }
    if (db.users.length >= 20000) return sendJson(res, 400, { error: '注册人数已达上限' });
    const user = createUser(username, password, nick.name);
    save();
    return sendJson(res, 201, { token: issueUserToken(user), user: publicUser(user) });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (!rateLimit(req, 15, 600000)) return sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });
    const body = await readBody(req);
    const user = verifyUser(body.username, body.password);
    if (!user) return sendJson(res, 401, { error: '账号或密码不正确' });
    return sendJson(res, 200, { token: issueUserToken(user), user: publicUser(user) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = bearerToken(req);
    if (token) userTokens.delete(token);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = userAuth(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/auth/profile' && method === 'POST') {
    const user = userAuth(req);
    if (!user) return sendJson(res, 401, { error: '请先登录' });
    if (!rateLimit(req, 20, 600000)) return sendJson(res, 429, { error: '改得太频繁，稍后再试' });
    const body = await readBody(req);
    const nick = validateNickname(body.name);
    if (nick.error) return sendJson(res, 400, { error: nick.error });
    user.name = nick.name;
    save();
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/posts' && method === 'GET') {
    const category = url.searchParams.get('category') || '';
    const sort = url.searchParams.get('sort') === 'hot' ? 'hot' : 'new';
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
    let list = db.posts.filter(p => p.status === 'approved');
    if (category && CATEGORIES.includes(category)) list = list.filter(p => p.category === category);
    if (q) list = list.filter(p => p.content.toLowerCase().includes(q));
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return sort === 'hot' ? hotScore(b) - hotScore(a) : b.createdAt - a.createdAt;
    });
    const total = list.length;
    return sendJson(res, 200, { posts: list.slice(offset, offset + limit).map(p => publicPost(p)), total, hasMore: offset + limit < total });
  }

  const detailMatch = pathname.match(/^\/api\/posts\/([0-9a-f-]{36})$/);
  if (detailMatch && method === 'GET') {
    const post = db.posts.find(p => p.id === detailMatch[1] && p.status === 'approved');
    if (!post) return sendJson(res, 404, { error: '帖子不存在或未通过审核' });
    // 同一 IP 半小时内重复打开不重复计数，防刷量与写盘放大
    if (!dedupHit('view', ip, post.id, 30 * 60000)) { post.views += 1; save(); }
    return sendJson(res, 200, { post: publicPost(post, { withComments: true }) });
  }

  if (pathname === '/api/posts' && method === 'POST') {
    const user = userAuth(req);
    if (!user) return sendJson(res, 401, { error: '请先注册或登录再发帖' });
    if (!rateLimit(req, 6, 600000)) return sendJson(res, 429, { error: '发得太快啦，过几分钟再试' });
    const body = await readBody(req, 8388608); // 含 base64 图片时放宽到 8MB（图片本体仍限制 5MB）
    const content = cleanText(body.content, MAX_CONTENT);
    const category = CATEGORIES.includes(body.category) ? body.category : '日常';
    // 昵称来自账号；勾选匿名则对外显示“匿名同学”
    const anonymous = !!body.anonymous;
    const author = anonymous ? '' : user.name;
    let image = null;
    if (body.image) {
      image = await saveImage(body.image);
      if (!image) return sendJson(res, 400, { error: '图片不合法或超过 5MB' });
    }
    if (!content && !image) return sendJson(res, 400, { error: '正文不能为空' });
    const post = {
      id: crypto.randomUUID(),
      content, author, anonymous, category, userId: user.id,
      status: 'pending', flagged: isFlagged(content) || isFlagged(author),
      pinned: false, image,
      likes: 0, views: 0, createdAt: Date.now(), comments: []
    };
    db.posts.push(post);
    save();
    return sendJson(res, 201, { id: post.id, status: 'pending', message: '已提交，管理员审核通过后就会出现在墙上' });
  }

  const likeMatch = pathname.match(/^\/api\/posts\/([0-9a-f-]{36})\/like$/);
  if (likeMatch && method === 'POST') {
    if (!rateLimit(req, 60, 60000)) return sendJson(res, 429, { error: '点得太快啦' });
    const post = db.posts.find(p => p.id === likeMatch[1] && p.status === 'approved');
    if (!post) return sendJson(res, 404, { error: '帖子不存在' });
    if (!dedupHit('like', ip, post.id, 86400000)) { post.likes += 1; save(); }
    return sendJson(res, 200, { likes: post.likes });
  }

  const commentMatch = pathname.match(/^\/api\/posts\/([0-9a-f-]{36})\/comments$/);
  if (commentMatch && method === 'POST') {
    const user = userAuth(req);
    if (!user) return sendJson(res, 401, { error: '请先注册或登录再留言' });
    if (!rateLimit(req, 10, 600000)) return sendJson(res, 429, { error: '留言太频繁啦，过几分钟再试' });
    const post = db.posts.find(p => p.id === commentMatch[1] && p.status === 'approved');
    if (!post) return sendJson(res, 404, { error: '帖子不存在' });
    const body = await readBody(req);
    const content = cleanText(body.content, MAX_COMMENT);
    if (!content) return sendJson(res, 400, { error: '留言不能为空' });
    const anonymous = !!body.anonymous;
    const author = anonymous ? '' : user.name;
    const comment = {
      id: crypto.randomUUID(), content, author, anonymous, userId: user.id,
      status: 'pending', flagged: isFlagged(content) || isFlagged(author),
      createdAt: Date.now()
    };
    post.comments.push(comment);
    save();
    return sendJson(res, 201, { id: comment.id, status: 'pending', message: '留言已提交，审核通过后展示' });
  }

  if (pathname === '/api/posts/mine' && method === 'GET') {
    if (!rateLimit(req, 60, 60000)) return sendJson(res, 429, { error: '请求太频繁' });
    const user = userAuth(req);
    if (!user) return sendJson(res, 401, { error: '请先登录查看自己的投稿' });
    const mine = db.posts
      .filter(p => p.userId === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map(p => {
        if (p.status === 'rejected') {
          // 未通过的帖子只回状态，不回正文，减少信息暴露
          return { id: p.id, status: 'rejected', category: p.category, createdAt: p.createdAt };
        }
        return {
          id: p.id, status: p.status, content: p.content, category: p.category, createdAt: p.createdAt,
          likes: p.likes, views: p.views,
          commentCount: p.comments.filter(c => c.status === 'approved').length
        };
      });
    return sendJson(res, 200, { posts: mine });
  }

  /* ---- 管理员 ---- */
  if (pathname === '/api/admin/login' && method === 'POST') {
    if (!rateLimit(req, 10, 600000)) return sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });
    const body = await readBody(req);
    if (!passwordOk(body.password)) return sendJson(res, 401, { error: '密码不正确' });
    if (adminTokens.size > 200) adminTokens.clear();
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.set(token, { createdAt: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    return sendJson(res, 200, { token });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
    if (m) adminTokens.delete(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!adminAuth(req)) return sendJson(res, 401, { error: '未登录或登录已过期' });

    if (pathname === '/api/admin/announcement' && method === 'POST') {
      const body = await readBody(req);
      if (!db.settings) db.settings = { announcement: '' };
      db.settings.announcement = cleanText(body.text, 200);
      save();
      return sendJson(res, 200, { ok: true, announcement: db.settings.announcement });
    }

    if (pathname === '/api/admin/overview' && method === 'GET') {
      const approved = db.posts.filter(p => p.status === 'approved');
      const pendingComments = [];
      for (const p of db.posts) {
        if (p.status !== 'approved') continue;
        for (const c of p.comments) {
          if (c.status === 'pending') pendingComments.push({ postId: p.id, postContent: p.content, comment: { ...c, account: accountLabel(c) } });
        }
      }
      // 已上墙列表：支持关键词过滤与分页（无参数时保持旧行为：最近 100 条）
      const aq = (url.searchParams.get('aq') || '').toLowerCase().trim();
      const aoffset = Math.max(0, parseInt(url.searchParams.get('aoffset') || '0', 10) || 0);
      const alimit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('alimit') || '100', 10) || 100));
      let approvedList = approved.sort((a, b) => b.createdAt - a.createdAt);
      if (aq) approvedList = approvedList.filter(p => p.content.toLowerCase().includes(aq));
      const approvedTotal = approvedList.length;
      // 近 7 日发帖量（含今天，全部状态）
      const daily = [];
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      for (let i = 6; i >= 0; i--) {
        const start = dayStart.getTime() - i * 86400000;
        const end = start + 86400000;
        const d = new Date(start);
        daily.push({
          date: (d.getMonth() + 1) + '-' + d.getDate(),
          count: db.posts.filter(p => p.createdAt >= start && p.createdAt < end).length
        });
      }
      return sendJson(res, 200, {
        stats: {
          total: db.posts.length,
          approved: approved.length,
          pendingPosts: db.posts.filter(p => p.status === 'pending').length,
          pendingComments: pendingComments.length,
          users: db.users.length,
          totalViews: db.posts.reduce((s, p) => s + p.views, 0),
          totalLikes: db.posts.reduce((s, p) => s + p.likes, 0),
          daily
        },
        pendingPosts: db.posts.filter(p => p.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
          .map(p => ({ ...p, account: accountLabel(p) })),
        pendingComments: pendingComments.sort((a, b) => a.comment.createdAt - b.comment.createdAt),
        approvedPosts: approvedList.slice(aoffset, aoffset + alimit)
          .map(p => ({ ...p, account: accountLabel(p), commentCount: p.comments.filter(c => c.status === 'approved').length })),
        approvedTotal
      });
    }

    const reviewMatch = pathname.match(/^\/api\/admin\/review\/(post|comment)\/([0-9a-f-]{36})$/);
    if (reviewMatch && method === 'POST') {
      const [, kind, id] = reviewMatch;
      const body = await readBody(req);
      const action = body.action;
      if (!['approve', 'reject', 'delete', 'pin', 'unpin'].includes(action)) {
        return sendJson(res, 400, { error: '操作不合法' });
      }
      if (kind === 'post') {
        const idx = db.posts.findIndex(p => p.id === id);
        if (idx < 0) return sendJson(res, 404, { error: '帖子不存在' });
        if (action === 'delete') { const [gone] = db.posts.splice(idx, 1); deleteImage(gone && gone.image); }
        else if (action === 'approve') db.posts[idx].status = 'approved';
        else if (action === 'reject') db.posts[idx].status = 'rejected';
        else if (action === 'pin') db.posts[idx].pinned = true;
        else if (action === 'unpin') db.posts[idx].pinned = false;
        save();
        return sendJson(res, 200, { ok: true });
      }
      // comment
      for (const p of db.posts) {
        const cIdx = p.comments.findIndex(c => c.id === id);
        if (cIdx < 0) continue;
        if (action === 'delete' || action === 'reject') p.comments.splice(cIdx, 1);
        else if (action === 'approve') p.comments[cIdx].status = 'approved';
        else return sendJson(res, 400, { error: '留言不支持该操作' });
        save();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: '留言不存在' });
    }
    return sendJson(res, 404, { error: '接口不存在' });
  }

  /* ---- 静态与上传 ---- */
  if (method === 'GET' && pathname === '/admin') return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
  const uploadMatch = pathname.match(/^\/uploads\/(.+)$/);
  if (method === 'GET' && uploadMatch) return serveUpload(req, res, uploadMatch[1]);
  if (method === 'GET') return serveStatic(req, res, pathname);
  return sendJson(res, 405, { error: '方法不允许' });
}

/* ---------------- 图片存储（base64 进，存数据库或 data/uploads） ---------------- */
async function saveImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = crypto.randomUUID() + '.' + ext;
  try {
    await store.putFile(name, buf);
    return '/uploads/' + name;
  } catch (err) {
    console.error('保存图片失败:', err.message);
    return null;
  }
}
function deleteImage(imagePath) {
  if (!imagePath) return;
  const name = path.basename(imagePath);
  store.delFile(name).catch(err => console.error('删除图片失败:', err.message));
}

/* ---------------- 启动 ---------------- */
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const code = err && err.code === 413 ? 413 : err && err.code === 400 ? 400 : 500;
    if (code === 500) console.error('请求处理失败:', err);
    if (!res.destroyed && !res.writableEnded) sendJson(res, code, { error: code === 500 ? '服务器开小差了' : err.message });
  });
});

async function bootstrap() {
  await initData(); // 先把数据读进内存，再开始接请求
  server.listen(PORT, () => {
    console.log('永荣校园墙已启动：http://localhost:' + PORT);
    console.log('管理后台：http://localhost:' + PORT + '/admin');
    if (!process.env.ADMIN_PASSWORD) console.warn('⚠️ 正在使用默认管理员密码 yongrong-admin，上线前务必设置 ADMIN_PASSWORD 环境变量！');
    if (!process.env.DATABASE_URL) console.warn('⚠️ 未设置 DATABASE_URL，正在用本地文件存数据，容器重建会丢帖子和账号！');
    if (!TRUST_PROXY) console.log('限流按真实连接 IP 计算（TRUST_PROXY 未开启）');
  });
}

bootstrap().catch(err => {
  console.error('启动失败:', err && err.message);
  process.exit(1);
});

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log('收到 ' + sig + '，正在保存数据…');
  await flushWrites();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
