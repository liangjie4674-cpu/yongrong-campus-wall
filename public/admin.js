'use strict';
/* 永荣校园墙 · 管理后台逻辑（用户内容一律 textContent 渲染） */

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('yr_admin_token') || '';
let pendingPostIds = [];

const APPROVED_PAGE_SIZE = 20;
let approvedQuery = '';
let approvedOffset = 0;
let approvedTotal = 0;
let approvedLoading = false;
let approvedVersion = 0;
let refreshSeq = 0;
let searchTimer = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 2400);
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function timeStr(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
async function api(pathname, opts = {}) {
  const r = await fetch(pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) }
  });
  if (r.status === 401) { logout(); throw new Error('登录已过期，请重新登录'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

function authorLine(item) {
  let who = item.anonymous ? '匿名同学' : (item.author || '匿名同学');
  if (item.account) who += '（' + item.account + '）';
  return who + ' · ' + timeStr(item.createdAt);
}
/** 待审内容已等待时长（渲染时计算一次） */
function waitText(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return minutes + ' 分钟';
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return hours + ' 小时';
  return Math.floor(diff / 86400000) + ' 天';
}

function reviewCard(item, kind, extra) {
  const card = el('div', 'review-card' + (item.flagged ? ' flagged' : ''));
  if (extra && extra.parentContent) {
    card.append(el('div', 'parent-content', '原帖：' + extra.parentContent));
  }
  const head = el('div', 'post-head');
  const meta = el('div', 'post-meta');
  const authorEl = el('div', 'post-author', (item.pinned ? '📌 ' : '') + authorLine(item));
  if (item.status === 'pending') {
    authorEl.append(el('span', 'wait-badge', '已等待 ' + waitText(item.createdAt)));
  }
  meta.append(authorEl);
  head.append(meta);
  if (item.category) head.append(el('span', 'cat-tag cat-' + item.category, item.category));
  card.append(head);
  card.append(el('div', 'post-content', item.content));
  if (item.image) {
    const img = el('img', 'review-img');
    img.alt = '帖子配图';
    img.loading = 'lazy';
    // 待审图片受后端保护：带管理员 token 取 blob 显示（直接 src 会 404）
    fetch(item.image, { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => { if (!r.ok) throw new Error('img'); return r.blob(); })
      .then(blob => { img.src = URL.createObjectURL(blob); })
      .catch(() => { img.alt = '图片加载失败'; });
    img.addEventListener('click', () => {
      fetch(item.image, { headers: { 'Authorization': 'Bearer ' + token } })
        .then(r => r.blob())
        .then(blob => window.open(URL.createObjectURL(blob), '_blank'))
        .catch(() => toast('图片打开失败'));
    });
    card.append(img);
  }
  if (item.flagged) card.append(el('div', 'flag-note', '⚠️ 含有疑似敏感词，请重点检查'));
  const actions = el('div', 'review-actions');
  const mk = (label, cls, action) => {
    const b = el('button', 'btn ' + cls, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/api/admin/review/' + kind + '/' + item.id, { method: 'POST', body: JSON.stringify({ action }) });
        toast(action === 'approve' ? '已通过' : action === 'reject' ? '已拒绝' : '已删除');
        refresh();
      } catch (e) { toast(e.message); b.disabled = false; }
    });
    return b;
  };
  actions.append(mk('通过', 'btn-approve', 'approve'));
  if (kind === 'post' || item.status === 'pending') actions.append(mk('拒绝', 'btn-reject', 'reject'));
  actions.append(mk('删除', 'btn-delete', 'delete'));
  card.append(actions);
  return card;
}

/** 近 7 日发帖柱状图（纯 DOM/CSS，无 canvas、无第三方库） */
function renderDailyChart(daily) {
  const chart = $('dailyChart');
  chart.replaceChildren();
  if (!Array.isArray(daily) || !daily.length) return;
  const max = Math.max(1, ...daily.map(d => Number(d.count) || 0));
  const BAR_MAX = 70;
  for (const d of daily) {
    const count = Number(d.count) || 0;
    const col = el('div', 'chart-col');
    const bar = el('div', 'chart-bar');
    bar.style.height = (count === 0 ? 4 : Math.max(6, Math.round(count / max * BAR_MAX))) + 'px';
    bar.title = d.date + '：' + count + ' 帖';
    col.append(el('div', 'chart-count', String(count)), bar, el('div', 'chart-date', d.date));
    chart.append(col);
  }
}

/** 已上墙帖子卡片：保留删除与置顶操作 */
function approvedCard(p) {
  const card = reviewCard({ ...p, status: 'approved' }, 'post');
  const actions = card.querySelector('.review-actions');
  actions.replaceChildren();
  const del = el('button', 'btn btn-delete', '删除');
  del.style.flex = '1';
  del.addEventListener('click', async () => {
    del.disabled = true;
    try {
      await api('/api/admin/review/post/' + p.id, { method: 'POST', body: JSON.stringify({ action: 'delete' }) });
      toast('已删除');
      refresh().catch(e => toast(e.message));
    } catch (e) { toast(e.message); del.disabled = false; }
  });
  const info = el('span', 'post-time', '👁 ' + p.views + ' · ❤️ ' + p.likes);
  info.style.alignSelf = 'center';
  const pin = el('button', 'btn btn-pin', p.pinned ? '取消置顶' : '📌 置顶');
  pin.addEventListener('click', async () => {
    pin.disabled = true;
    try {
      await api('/api/admin/review/post/' + p.id, {
        method: 'POST',
        body: JSON.stringify({ action: p.pinned ? 'unpin' : 'pin' })
      });
      toast(p.pinned ? '已取消置顶' : '已置顶');
      refresh().catch(e => toast(e.message));
    } catch (e) { toast(e.message); pin.disabled = false; }
  });
  actions.append(info, pin, del);
  return card;
}

function overviewUrl(offset) {
  const params = new URLSearchParams();
  params.set('aoffset', String(offset));
  params.set('alimit', String(APPROVED_PAGE_SIZE));
  if (approvedQuery) params.set('aq', approvedQuery);
  return '/api/admin/overview?' + params.toString();
}

function updateLoadMore() {
  const btn = $('loadMoreBtn');
  const more = approvedOffset < approvedTotal;
  btn.hidden = !more;
  if (more) { btn.disabled = false; btn.textContent = '加载更多'; }
}

async function loadMoreApproved() {
  if (approvedLoading || approvedOffset >= approvedTotal) return;
  approvedLoading = true;
  const btn = $('loadMoreBtn');
  const seq = refreshSeq;
  const version = approvedVersion;
  btn.disabled = true;
  btn.textContent = '加载中…';
  try {
    const data = await api(overviewUrl(approvedOffset));
    // 期间列表已被刷新/搜索重置（可能只加载了第一页），丢弃本次结果避免错位追加
    if (seq !== refreshSeq || version !== approvedVersion) return;
    const ap = $('approvedPosts');
    data.approvedPosts.forEach(p => ap.append(approvedCard(p)));
    approvedOffset += data.approvedPosts.length;
    if (typeof data.approvedTotal === 'number') approvedTotal = data.approvedTotal;
    updateLoadMore();
  } catch (e) {
    toast(e.message);
    if (seq === refreshSeq) { btn.disabled = false; btn.textContent = '加载更多'; }
  } finally {
    approvedLoading = false;
  }
}

async function refresh() {
  const seq = ++refreshSeq;
  const data = await api(overviewUrl(0));
  if (seq !== refreshSeq) return; // 搜索/刷新竞态：只渲染最新一次结果
  const s = data.stats;
  const grid = $('statsGrid');
  grid.replaceChildren();
  const boxes = [
    [s.approved, '已上墙'], [s.pendingPosts, '待审帖子'], [s.pendingComments, '待审留言'],
    [s.users, '注册用户'], [s.total, '总帖子'], [s.totalViews, '总浏览'], [s.totalLikes, '总点赞']
  ];
  for (const [num, label] of boxes) {
    const box = el('div', 'stat-box');
    box.append(el('b', '', String(num)), el('span', '', label));
    grid.append(box);
  }
  renderDailyChart(s.daily);

  $('pendingPostCount').textContent = String(data.pendingPosts.length);
  $('pendingCommentCount').textContent = String(data.pendingComments.length);

  const pp = $('pendingPosts');
  pp.replaceChildren();
  if (!data.pendingPosts.length) pp.append(el('div', 'none-note', '没有待审核的帖子 🎉'));
  data.pendingPosts.forEach(p => pp.append(reviewCard(p, 'post')));
  pendingPostIds = data.pendingPosts.map(p => p.id);
  const approveAllBtn = $('approveAllBtn');
  approveAllBtn.hidden = !pendingPostIds.length;
  approveAllBtn.disabled = false;
  approveAllBtn.textContent = '全部通过';

  const pc = $('pendingComments');
  pc.replaceChildren();
  if (!data.pendingComments.length) pc.append(el('div', 'none-note', '没有待审核的留言 🎉'));
  data.pendingComments.forEach(({ comment, postContent }) =>
    pc.append(reviewCard(comment, 'comment', { parentContent: postContent })));

  const ap = $('approvedPosts');
  ap.replaceChildren();
  if (!data.approvedPosts.length) {
    ap.append(el('div', 'none-note', approvedQuery ? '没有找到匹配的帖子' : '还没有上墙的帖子'));
  }
  data.approvedPosts.forEach(p => ap.append(approvedCard(p)));
  approvedOffset = data.approvedPosts.length;
  approvedTotal = typeof data.approvedTotal === 'number' ? data.approvedTotal : approvedOffset;
  approvedVersion++;
  updateLoadMore();
}

function showPanel() {
  $('loginBox').hidden = true;
  $('panel').hidden = false;
  $('logoutBtn').hidden = false;
  refresh().catch(e => toast(e.message));
}
function logout() {
  if (token) fetch('/api/admin/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } }).catch(() => {});
  token = '';
  sessionStorage.removeItem('yr_admin_token');
  $('loginBox').hidden = false;
  $('panel').hidden = true;
  $('logoutBtn').hidden = true;
}
$('logoutBtn').addEventListener('click', logout);

async function doLogin() {
  const pw = $('pwInput').value;
  if (!pw) { toast('先输入密码'); return; }
  const btn = $('loginBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '登录失败');
    token = data.token;
    sessionStorage.setItem('yr_admin_token', token);
    $('pwInput').value = '';
    showPanel();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}
$('loginBtn').addEventListener('click', doLogin);
$('pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// 已上墙搜索（300ms 防抖）与加载更多
$('approvedSearch').addEventListener('input', e => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (q === approvedQuery) return;
    approvedQuery = q;
    refresh().catch(err => toast(err.message));
  }, 300);
});
$('loadMoreBtn').addEventListener('click', loadMoreApproved);

$('approveAllBtn').addEventListener('click', async () => {
  const ids = pendingPostIds.slice();
  if (!ids.length) { toast('没有待审核的帖子'); return; }
  if (!confirm('确定通过全部 ' + ids.length + ' 条待审核帖子吗？')) return;
  const btn = $('approveAllBtn');
  btn.disabled = true;
  btn.textContent = '处理中…';
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await api('/api/admin/review/post/' + id, {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' })
      });
      ok++;
    } catch {
      fail++;
      if (!token) break;
    }
  }
  btn.disabled = false;
  btn.textContent = '全部通过';
  if (ok && fail) toast('已通过 ' + ok + ' 条，' + fail + ' 条失败');
  else if (ok) toast('已全部通过 ' + ok + ' 条');
  else toast('没有帖子通过，请重试');
  if (token) refresh().catch(e => toast(e.message));
});

/* ---------- 公告管理 ---------- */
async function loadAnnouncement() {
  try {
    const r = await fetch('/api/site');
    const d = await r.json();
    $('announceInput').value = d.announcement || '';
  } catch { /* 忽略 */ }
}
async function saveAnnouncement(text) {
  try {
    await api('/api/admin/announcement', { method: 'POST', body: JSON.stringify({ text }) });
    $('announceInput').value = text;
    toast(text ? '公告已发布' : '公告已撤下');
  } catch (e) { toast(e.message); }
}
$('announceSave').addEventListener('click', () => saveAnnouncement($('announceInput').value.trim()));
$('announceClear').addEventListener('click', () => saveAnnouncement(''));
const _showPanel = showPanel;
showPanel = function () { _showPanel(); loadAnnouncement(); };

if (token) showPanel();
