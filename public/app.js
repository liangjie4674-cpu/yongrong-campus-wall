'use strict';
/* 永荣校园墙 · 前端逻辑（全部用户内容用 textContent 渲染，防 XSS） */

const CATEGORIES = ['表白', '吐槽', '求助', '失物招领', '日常', '树洞'];
const AVATAR_COLORS = ['#E4572E', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#64748B', '#0EA5E9'];
const PAGE_SIZE = 15;

const state = {
  category: '', sort: 'new', q: '', currentPostId: null, composeCategory: '日常',
  offset: 0, hasMore: true, loading: false, view: 'wall', firstLoad: true
};

let composeImage = null;
let feedReq = 0;
let hotReq = 0;
let pullStart = null;

const $ = id => document.getElementById(id);
const feedEl = $('feed'), emptyEl = $('emptyState'), skeletonEl = $('skeleton');
const feedTailEl = $('feedTail'), feedSentinelEl = $('feedSentinel');
const hotStripEl = $('hotStrip'), hotScrollEl = $('hotScroll');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 30) return Math.floor(diff / 86400000) + ' 天前';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function hasSheetOpen() {
  return !$('composeSheet').hidden || !$('detailSheet').hidden || !$('authSheet').hidden;
}

/* ---------- 本地存储（隐私模式/微信内置浏览器可能抛错，统一兜底防白屏） ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不下就算了 */ } },
  getStr(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  setStr(key, value) { try { localStorage.setItem(key, value); } catch { /* 忽略 */ } }
};

/* ---------- 账号状态（登录后才能发帖/留言） ---------- */
const auth = {
  token: store.getStr('yr_token', ''),
  user: store.get('yr_user', null)
};

function persistAuth() {
  try {
    if (auth.token) localStorage.setItem('yr_token', auth.token); else localStorage.removeItem('yr_token');
    if (auth.user) localStorage.setItem('yr_user', JSON.stringify(auth.user)); else localStorage.removeItem('yr_user');
  } catch { /* 隐私模式下存不下，仅当次会话有效 */ }
}

function setAuth(token, user) {
  auth.token = token || '';
  auth.user = user || null;
  persistAuth();
  renderAccount();
}

function clearAuth() { setAuth('', null); }

function authHeaders(base) {
  const h = Object.assign({}, base || {});
  if (auth.token) h['Authorization'] = 'Bearer ' + auth.token;
  return h;
}

/* ---------- 点赞本地记录 ---------- */
const likedSet = new Set(store.get('yr_liked', []));
function markLiked(id) {
  likedSet.add(id);
  store.set('yr_liked', [...likedSet].slice(-500));
}

/* ---------- 点赞粒子 ---------- */
function spawnParticles(btn) {
  for (let i = 0; i < 6; i++) {
    const p = el('span', 'particle', '❤');
    const angle = (Math.PI * 2 * i) / 6 + Math.random() * 0.6;
    const dist = 24 + Math.random() * 24;
    p.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
    p.style.setProperty('--dy', (Math.sin(angle) * dist - 8).toFixed(1) + 'px');
    p.style.fontSize = (8 + Math.random() * 5).toFixed(1) + 'px';
    p.addEventListener('animationend', () => p.remove(), { once: true });
    setTimeout(() => p.remove(), 1000);
    btn.append(p);
  }
}

/* ---------- 信息流卡片 ---------- */
function buildCard(post, index, opts = {}) {
  const card = el('article', 'post-card');
  card.style.animationDelay = Math.min(index * 45, 400) + 'ms';

  const head = el('div', 'post-head');
  const av = el('div', 'avatar', post.anonymous ? '匿' : (post.author || '匿').slice(0, 1));
  av.style.background = post.anonymous ? '#94A3B8' : avatarColor(post.author || '');
  const meta = el('div', 'post-meta');
  meta.append(el('div', 'post-author', post.author), el('div', 'post-time', timeAgo(post.createdAt)));
  head.append(av, meta);
  if (post.pinned) head.append(el('span', 'pin-badge', '📌 置顶'));
  head.append(el('span', 'cat-tag cat-' + post.category, post.category));

  const content = el('div', 'post-content', post.content);

  const stats = el('div', 'post-stats');
  const viewStat = el('span', 'stat');
  viewStat.append(el('span', '', '👁'), el('span', 'num', String(post.views)));

  const likeBtn = el('button', 'stat like-btn' + (likedSet.has(post.id) ? ' liked' : ''));
  const heart = el('span', 'heart', likedSet.has(post.id) ? '❤️' : '🤍');
  const likeNum = el('span', 'num', String(post.likes));
  likeBtn.append(heart, likeNum);
  likeBtn.addEventListener('click', async ev => {
    ev.stopPropagation();
    if (likedSet.has(post.id)) { toast('已经赞过啦'); return; }
    markLiked(post.id);
    likeBtn.classList.add('liked', 'pop');
    heart.textContent = '❤️';
    likeNum.textContent = String(post.likes + 1);
    spawnParticles(likeBtn);
    const plus = el('span', 'float-plus', '+1');
    likeBtn.append(plus);
    setTimeout(() => plus.remove(), 850);
    try {
      const r = await fetch('/api/posts/' + post.id + '/like', { method: 'POST' });
      if (r.ok) { const d = await r.json(); likeNum.textContent = String(d.likes); }
    } catch { /* 网络异常时保留本地显示 */ }
  });

  const commentStat = el('span', 'stat');
  commentStat.append(el('span', '', '💬'), el('span', 'num', String(post.commentCount)));

  stats.append(viewStat, likeBtn, commentStat);
  card.append(head, content);
  if (post.image) {
    const img = el('img', 'post-img');
    img.loading = 'lazy';
    img.alt = '帖子配图';
    img.src = post.image;
    card.append(img);
  }
  card.append(stats);
  if (opts.clickable !== false) card.addEventListener('click', () => openDetail(post.id));
  return card;
}

/* ---------- 热门榜条 ---------- */
function hotVisible() {
  return state.view === 'wall' && !state.category && !state.q;
}

function buildHotCard(post, index) {
  const card = el('article', 'hot-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', '热门榜第 ' + (index + 1) + ' 名');
  const rank = el('span', 'hot-rank' + (index < 3 ? ' top' : ''), String(index + 1));
  const content = el('div', 'hot-content', post.content || '（图片帖子）');
  const meta = el('div', 'hot-meta', '❤️ ' + post.likes + ' · 👁 ' + post.views);
  card.append(rank, content, meta);
  const open = () => openDetail(post.id);
  card.addEventListener('click', open);
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

async function loadHotStrip() {
  const req = ++hotReq;
  try {
    const r = await fetch('/api/posts?sort=hot&limit=5');
    if (!r.ok) throw new Error('请求失败');
    const data = await r.json();
    if (req !== hotReq) return;
    const posts = (data.posts || []).slice(0, 5);
    if (!posts.length) { hotStripEl.hidden = true; return; }
    const frag = document.createDocumentFragment();
    posts.forEach((p, i) => frag.append(buildHotCard(p, i)));
    hotScrollEl.replaceChildren(frag);
    hotStripEl.hidden = false;
  } catch {
    if (req === hotReq) hotStripEl.hidden = true;
  }
}

function syncHotStrip() {
  if (!hotVisible()) {
    hotReq++;
    hotStripEl.hidden = true;
    hotScrollEl.replaceChildren();
    return;
  }
  hotStripEl.hidden = false;
  loadHotStrip();
}

/* ---------- 分页加载 ---------- */
function buildParams(offset) {
  const params = new URLSearchParams({
    sort: state.sort,
    offset: String(offset),
    limit: String(PAGE_SIZE)
  });
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  return params;
}

function setTail(show, text) {
  feedTailEl.textContent = text || '加载中…';
  feedTailEl.hidden = !show;
}

let autoFillTimer = null;
function scheduleAutoFill() {
  clearTimeout(autoFillTimer);
  autoFillTimer = setTimeout(() => {
    if (state.view !== 'wall' || state.loading || !state.hasMore) return;
    const rect = feedSentinelEl.getBoundingClientRect();
    if (rect.top < window.innerHeight + 200) loadMore();
  }, 120);
}

async function loadFeed() {
  const req = ++feedReq;
  const useSkeleton = state.firstLoad;
  state.firstLoad = false;
  state.offset = 0;
  state.hasMore = true;
  state.loading = true;
  feedEl.replaceChildren();
  emptyEl.hidden = true;
  setTail(false);
  skeletonEl.style.display = useSkeleton ? '' : 'none';
  if (!useSkeleton) setTail(true);
  syncHotStrip();

  try {
    const r = await fetch('/api/posts?' + buildParams(0).toString());
    if (req !== feedReq) return false;
    if (!r.ok) throw new Error('请求失败');
    const data = await r.json();
    if (req !== feedReq) return false;
    skeletonEl.style.display = 'none';
    setTail(false);
    state.hasMore = !!data.hasMore;
    state.offset = data.posts.length;
    $('wallCount').textContent = data.total ? '共 ' + data.total + ' 条' : '';
    if (!data.posts.length) {
      emptyEl.hidden = false;
      state.loading = false;
      scheduleAutoFill();
      return true;
    }
    const frag = document.createDocumentFragment();
    data.posts.forEach((p, i) => frag.append(buildCard(p, i)));
    feedEl.append(frag);
    state.loading = false;
    scheduleAutoFill();
    return true;
  } catch {
    if (req !== feedReq) return false;
    skeletonEl.style.display = 'none';
    setTail(false);
    state.loading = false;
    toast('网络开小差了，稍后再试');
    return false;
  }
}

async function loadMore() {
  if (state.loading || !state.hasMore || state.view !== 'wall') return;
  const req = feedReq;
  state.loading = true;
  setTail(true);
  try {
    const r = await fetch('/api/posts?' + buildParams(state.offset).toString());
    if (req !== feedReq) return;
    if (!r.ok) throw new Error('请求失败');
    const data = await r.json();
    if (req !== feedReq) return;
    state.hasMore = !!data.hasMore;
    if (data.posts.length) {
      const start = state.offset;
      const frag = document.createDocumentFragment();
      data.posts.forEach((p, i) => frag.append(buildCard(p, start + i)));
      feedEl.append(frag);
      state.offset += data.posts.length;
    } else {
      state.hasMore = false;
    }
    setTail(false);
    state.loading = false;
    scheduleAutoFill();
  } catch {
    if (req !== feedReq) return;
    setTail(false);
    state.loading = false;
    toast('加载更多失败，稍后再试');
  }
}

function initInfiniteScroll() {
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(e => e.isIntersecting)) return;
    if (state.view === 'wall' && !state.loading && state.hasMore) loadMore();
  }, { rootMargin: '240px 0px' });
  observer.observe(feedSentinelEl);
}

/* ---------- 下拉刷新 ---------- */
function initPullToRefresh() {
  document.addEventListener('touchstart', e => {
    if (!e.touches || e.touches.length !== 1 || window.scrollY > 0) { pullStart = null; return; }
    if (e.target && e.target.closest && e.target.closest('input, textarea')) { pullStart = null; return; }
    pullStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });

  document.addEventListener('touchend', async e => {
    if (!pullStart) return;
    const start = pullStart;
    pullStart = null;
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const dy = touch.clientY - start.y;
    const dx = Math.abs(touch.clientX - start.x);
    if (dy <= 70 || dy <= dx) return;
    if (window.scrollY > 0 || hasSheetOpen() || state.view !== 'wall' || state.loading) return;
    const ok = await loadFeed();
    if (ok) toast('已刷新');
  }, { passive: true });
}

/* ---------- 分类与排序 ---------- */
function buildChips() {
  const wrap = $('chips');
  const all = el('button', 'chip active', '全部');
  all.dataset.cat = '';
  all.addEventListener('click', () => selectCategory('', all));
  wrap.append(all);
  for (const c of CATEGORIES) {
    const b = el('button', 'chip', c);
    b.dataset.cat = c;
    b.addEventListener('click', () => selectCategory(c, b));
    wrap.append(b);
  }
}
function selectCategory(cat, btn) {
  state.category = cat;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === btn));
  loadFeed();
}
document.querySelectorAll('.sort-btn').forEach(b => {
  b.addEventListener('click', () => {
    state.sort = b.dataset.sort;
    document.querySelectorAll('.sort-btn').forEach(x => x.classList.toggle('active', x === b));
    loadFeed();
  });
});

/* ---------- 搜索 ---------- */
$('searchToggle').addEventListener('click', () => {
  const row = $('searchRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('searchInput').focus();
  else { state.q = ''; $('searchInput').value = ''; loadFeed(); }
});
let searchTimer = null;
$('searchInput').addEventListener('input', e => {
  state.q = e.target.value.trim();
  if (!hotVisible()) {
    hotReq++;
    hotStripEl.hidden = true;
    hotScrollEl.replaceChildren();
  }
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadFeed(), 350);
});

/* ---------- 抽屉通用 ---------- */
function openSheet(maskId, sheetId) { $(maskId).hidden = false; $(sheetId).hidden = false; document.body.style.overflow = 'hidden'; }
function closeSheet(maskId, sheetId) { $(maskId).hidden = true; $(sheetId).hidden = true; document.body.style.overflow = ''; }
$('composeMask').addEventListener('click', () => closeSheet('composeMask', 'composeSheet'));
$('detailMask').addEventListener('click', () => closeSheet('detailMask', 'detailSheet'));

/* ---------- 图片选择与压缩 ---------- */
function setComposeImage(dataUrl) {
  composeImage = dataUrl || null;
  const preview = $('imgPreview');
  const thumb = $('imgPreviewThumb');
  const addBtn = $('imgAddBtn');
  if (composeImage) {
    thumb.src = composeImage;
    preview.hidden = false;
    addBtn.hidden = true;
  } else {
    thumb.removeAttribute('src');
    preview.hidden = true;
    addBtn.hidden = false;
    $('imgInput').value = '';
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const maxSide = 1280;
        const sourceWidth = img.naturalWidth || img.width;
        const sourceHeight = img.naturalHeight || img.height;
        if (!sourceWidth || !sourceHeight) throw new Error('图片尺寸无效');
        const ratio = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * ratio));
        const height = Math.max(1, Math.round(sourceHeight * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas unavailable');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('图片读取失败')); };
    img.src = objectUrl;
  });
}

$('imgAddBtn').addEventListener('click', () => $('imgInput').click());
$('imgInput').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const btn = $('imgAddBtn');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const dataUrl = await compressImage(file);
    setComposeImage(dataUrl);
    $('imgInput').value = '';
  } catch {
    $('imgInput').value = '';
    toast('图片处理失败，换一张试试');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});
$('imgRemove').addEventListener('click', () => setComposeImage(null));

/* ---------- 发布 ---------- */
function buildCatSelect() {
  const wrap = $('catSelect');
  for (const c of CATEGORIES) {
    const b = el('button', 'chip' + (c === state.composeCategory ? ' active' : ''), c);
    b.dataset.cat = c;
    b.addEventListener('click', () => {
      state.composeCategory = c;
      wrap.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    });
    wrap.append(b);
  }
}
$('composeContent').addEventListener('input', e => { $('charNow').textContent = String(e.target.value.length); });
$('composeFab').addEventListener('click', () => {
  if (!auth.user) {
    toast('先注册或登录，才能发帖');
    openAuth('register');
    return;
  }
  renderIdentity();
  openSheet('composeMask', 'composeSheet');
  setTimeout(() => $('composeContent').focus(), 380);
});
$('composeSubmit').addEventListener('click', async () => {
  if (!auth.user) { toast('先注册或登录，才能发帖'); openAuth('register'); return; }
  const content = $('composeContent').value.trim();
  if (!content && !composeImage) { toast('写点什么，或者加一张图片吧'); return; }
  const btn = $('composeSubmit');
  btn.disabled = true; btn.textContent = '提交中…';
  try {
    const payload = {
      content, anonymous: $('composeAnon').checked, category: state.composeCategory
    };
    if (composeImage) payload.image = composeImage;
    const r = await fetch('/api/posts', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (r.status === 401) { clearAuth(); throw new Error('登录已过期，请重新登录'); }
    if (!r.ok) throw new Error(data.error || '提交失败');
    $('composeContent').value = ''; $('charNow').textContent = '0';
    setComposeImage(null);
    closeSheet('composeMask', 'composeSheet');
    toast('已提交！管理员审核通过后就会上墙');
  } catch (err) {
    toast(err.message || '提交失败，再试一次');
  } finally {
    btn.disabled = false; btn.textContent = '提交审核';
  }
});

/* ---------- 详情与留言 ---------- */
async function openDetail(id) {
  state.currentPostId = id;
  openSheet('detailMask', 'detailSheet');
  $('detailSheet').scrollTop = 0;
  const body = $('detailBody');
  body.replaceChildren(el('div', 'no-comments', '加载中…'));
  $('commentList').replaceChildren();
  $('commentCount').textContent = '';
  try {
    const r = await fetch('/api/posts/' + id);
    if (!r.ok) throw new Error('帖子不存在');
    const { post } = await r.json();
    body.replaceChildren();
    const fakeCard = buildCard({ ...post }, 0, { clickable: false });
    fakeCard.style.animation = 'none';
    fakeCard.style.boxShadow = 'none';
    fakeCard.style.border = 'none';
    fakeCard.style.padding = '0';
    fakeCard.style.cursor = 'default';
    body.append(fakeCard);
    $('commentCount').textContent = '（' + post.comments.length + '）';
    renderComments(post.comments);
  } catch {
    body.replaceChildren(el('div', 'no-comments', '没找到这条帖子，可能还没通过审核'));
  }
}
function renderComments(comments) {
  const list = $('commentList');
  list.replaceChildren();
  if (!comments.length) { list.append(el('div', 'no-comments', '还没有留言，来抢沙发')); return; }
  for (const c of comments) {
    const item = el('div', 'comment-item');
    const head = el('div', 'comment-head');
    head.append(el('span', 'comment-author', c.author), el('span', 'comment-time', timeAgo(c.createdAt)));
    item.append(head, el('div', 'comment-content', c.content));
    list.append(item);
  }
}
$('commentSubmit').addEventListener('click', async () => {
  if (!auth.user) { toast('先注册或登录，才能留言'); openAuth('register'); return; }
  const content = $('commentContent').value.trim();
  if (!content) { toast('先写点什么吧'); return; }
  if (!state.currentPostId) return;
  const btn = $('commentSubmit');
  btn.disabled = true;
  try {
    const r = await fetch('/api/posts/' + state.currentPostId + '/comments', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content, anonymous: $('commentAnon').checked })
    });
    const data = await r.json();
    if (r.status === 401) { clearAuth(); throw new Error('登录已过期，请重新登录'); }
    if (!r.ok) throw new Error(data.error || '留言失败');
    $('commentContent').value = '';
    toast('留言已提交，审核通过后展示');
  } catch (err) {
    toast(err.message || '留言失败，再试一次');
  } finally { btn.disabled = false; }
});

/* ---------- 我的投稿 ---------- */
async function loadMine() {
  const list = $('mineList');
  list.replaceChildren();
  if (!auth.user) {
    $('mineEmpty').hidden = true;
    const box = el('div', 'mine-card');
    box.append(el('div', 'post-content', '登录后就能在这里看到自己投过稿的审核状态。'));
    const loginBtn = el('button', 'primary-btn', '登录 / 注册');
    loginBtn.addEventListener('click', () => openAuth('login'));
    box.append(loginBtn);
    list.append(box);
    return;
  }
  try {
    const r = await fetch('/api/posts/mine', { headers: authHeaders() });
    if (r.status === 401) { clearAuth(); loadMine(); return; }
    if (!r.ok) throw new Error('请求失败');
    const data = await r.json();
    $('mineEmpty').hidden = data.posts.length > 0;
    const label = { pending: '审核中', approved: '已上墙', rejected: '未通过', missing: '已删除' };
    for (const p of data.posts) {
      const card = el('div', 'mine-card');
      const head = el('div', 'post-head');
      const tag = el('span', 'cat-tag cat-' + (p.category || '日常'), p.category || '日常');
      const pill = el('span', 'status-pill status-' + p.status, label[p.status] || p.status);
      const time = el('span', 'post-time', timeAgo(p.createdAt || Date.now()));
      head.append(tag, pill, time);
      card.append(head);
      if (p.content) card.append(el('div', 'post-content', p.content));
      if (p.status === 'approved') {
        const stats = el('div', 'post-stats');
        stats.append(el('span', 'stat', '👁 ' + p.views), el('span', 'stat', '❤️ ' + p.likes), el('span', 'stat', '💬 ' + p.commentCount));
        card.append(stats);
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => openDetail(p.id));
      }
      list.append(card);
    }
  } catch { toast('网络开小差了'); }
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    const mine = tab.dataset.view === 'mine';
    state.view = mine ? 'mine' : 'wall';
    $('mineView').hidden = !mine;
    feedEl.style.display = mine ? 'none' : '';
    $('chips').style.display = mine ? 'none' : '';
    document.querySelector('.sort-row').style.display = mine ? 'none' : '';
    if (mine) {
      // 让仍在路上的信息流请求失效，避免回来时串数据
      feedReq++;
      state.loading = false;
      skeletonEl.style.display = 'none';
      setTail(false);
      syncHotStrip();
      loadMine();
    } else {
      loadFeed();
    }
  });
});

/* ---------- 公告条 ---------- */
fetch('/api/site').then(r => r.json()).then(d => {
  if (d.announcement) {
    $('announceText').textContent = d.announcement;
    $('announceBar').hidden = false;
  }
}).catch(() => {});

/* ---------- 宣言横幅 ---------- */
if (store.get('yr_manifesto_closed', false)) $('manifesto').hidden = true;
$('manifestoClose').addEventListener('click', () => {
  $('manifesto').hidden = true;
  store.set('yr_manifesto_closed', true);
});

/* ---------- 账号：注册 / 登录 / 改昵称 ---------- */
let authMode = 'login';

function renderAccount() {
  const btn = $('accountBtn');
  if (auth.user) {
    btn.textContent = (auth.user.name || '我').slice(0, 1);
    btn.classList.add('acct');
    btn.setAttribute('aria-label', '我的账号：' + auth.user.name);
  } else {
    btn.textContent = '👤';
    btn.classList.remove('acct');
    btn.setAttribute('aria-label', '登录或注册');
  }
  renderIdentity();
  renderAuthBody();
}

function identityNode(prefix) {
  const frag = document.createDocumentFragment();
  frag.append(document.createTextNode(prefix));
  frag.append(el('b', '', auth.user.name));
  return frag;
}

function renderIdentity() {
  const bar = $('composeIdentity');
  const mini = $('commentIdentity');
  bar.replaceChildren();
  mini.replaceChildren();
  if (auth.user) {
    bar.append(identityNode('以 '), document.createTextNode(' 的身份发布 · 账号 @' + auth.user.username));
    mini.append(identityNode('以 '), document.createTextNode(' 的身份留言'));
  } else {
    bar.textContent = '登录后才能发布，先注册一个账号吧';
    mini.textContent = '登录后才能留言';
  }
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === authMode));
  $('authNameWrap').hidden = authMode !== 'register';
  $('authPassword2Wrap').hidden = authMode !== 'register';
  $('authSubmit').textContent = authMode === 'register' ? '注册并登录' : '登录';
  $('authTitle').textContent = authMode === 'register' ? '注册账号' : '登录';
  $('authNote').textContent = authMode === 'register'
    ? '注册不需要邮箱或手机验证，填账号、密码、昵称就能用'
    : '还没有账号？点上面的“注册”，几秒就能建好';
  $('authPassword').setAttribute('autocomplete', authMode === 'register' ? 'new-password' : 'current-password');
}

function renderAuthBody() {
  const loggedIn = !!auth.user;
  $('authForms').hidden = loggedIn;
  $('authProfile').hidden = !loggedIn;
  if (loggedIn) {
    $('authTitle').textContent = '我的账号';
    $('accountAvatar').textContent = (auth.user.name || '荣').slice(0, 1);
    $('accountAvatar').style.background = avatarColor(auth.user.name || '');
    $('accountName').textContent = auth.user.name;
    $('accountUsername').textContent = '@' + auth.user.username;
    $('profileName').value = auth.user.name;
  } else {
    setAuthMode(authMode);
  }
}

function openAuth(mode) {
  if (mode) setAuthMode(mode);
  renderAuthBody();
  openSheet('authMask', 'authSheet');
}

$('accountBtn').addEventListener('click', () => openAuth());
$('authMask').addEventListener('click', () => closeSheet('authMask', 'authSheet'));
document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));

$('authSubmit').addEventListener('click', async () => {
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  const name = $('authName').value.trim();
  if (!username) { toast('请填写账号'); return; }
  if (authMode === 'register') {
    if (!name) { toast('请填写昵称'); return; }
    if (password.length < 6) { toast('密码至少 6 位'); return; }
    if (password !== $('authPassword2').value) { toast('两次输入的密码不一致'); return; }
  } else if (!password) { toast('请填写密码'); return; }

  const btn = $('authSubmit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = authMode === 'register' ? '注册中…' : '登录中…';
  try {
    const isRegister = authMode === 'register';
    const r = await fetch('/api/auth/' + (isRegister ? 'register' : 'login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isRegister ? { username, password, name } : { username, password })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '操作失败');
    setAuth(data.token, data.user);
    $('authPassword').value = ''; $('authPassword2').value = '';
    closeSheet('authMask', 'authSheet');
    toast(isRegister ? '注册成功，欢迎你，' + data.user.name : '登录成功，欢迎回来');
    if (state.view === 'mine') loadMine();
  } catch (err) {
    toast(err.message || '网络开小差了');
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
});

$('profileSave').addEventListener('click', async () => {
  const name = $('profileName').value.trim();
  if (!name) { toast('昵称不能为空'); return; }
  const btn = $('profileSave');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/profile', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '保存失败');
    setAuth(auth.token, data.user);
    toast('昵称已更新');
  } catch (err) {
    toast(err.message || '保存失败');
  } finally { btn.disabled = false; }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() }); } catch { /* 忽略 */ }
  clearAuth();
  closeSheet('authMask', 'authSheet');
  toast('已退出登录');
  if (state.view === 'mine') loadMine();
});

/* ---------- 启动 ---------- */
buildChips();
buildCatSelect();
initInfiniteScroll();
initPullToRefresh();
renderAccount();
if (auth.token) {
  // 用服务端校验一次登录态（昵称可能改过、token 可能过期）
  fetch('/api/auth/me', { headers: authHeaders() }).then(async r => {
    if (r.status === 401) { clearAuth(); return; }
    if (!r.ok) return;
    const d = await r.json();
    if (d.user) setAuth(auth.token, d.user);
  }).catch(() => { /* 离线时保留本地登录态 */ });
}
loadFeed();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
