# 永荣校园墙 · R3 管理后台深化（给 Claude Code 的执行规格）

项目目录就是当前目录。可以改 `server.js`、`public/admin.js`、`public/admin.html`；不要动 `public/app.js`、`public/index.html`、`public/styles.css`（如确需给 admin 加样式，写在 admin.html 的内联 style 里）、`fonts.css`、`fonts/`。

## 后端（server.js）——【已由奶龙完成，勿动】

1. `GET /api/admin/overview` 增加查询参数支持（保持无参数时的返回结构向后兼容）：
   - 已上墙列表支持 `aq`（按正文关键词过滤）、`aoffset`（默认 0）、`alimit`（默认 100，上限 100）：返回里把 `approvedPosts` 改为按参数切片，并新增 `approvedTotal`（过滤后的总数）。
   - `stats` 里新增 `daily`：最近 7 天（含今天）每天的发帖数（统计当天 createdAt 落在该日的全部帖子，含待审/已通过/未通过），格式 `[{date:'11-18', count:3}, ...]` 按日期升序。
2. 其余接口与行为保持不变。改完运行 `node --check server.js`。

## 管理端（admin.js / admin.html）

0. **图片审核——【已由奶龙实现并实测通过，勿重做】**：带图片的帖子在「待审核帖子」卡片里必须把图片显示出来给管理员看（这是图片审核的入口——帖子和图片一起审，管理员没点通过之前，前台任何人都看不到这张图，后端已做访问控制）。实现要点：
   - reviewCard 里若 `item.image` 存在，追加一个 `<img class="review-img">`（DOM API 建元素），样式：宽 100%、圆角 12px、最大高度 260px、object-fit cover；点图片在新标签打开原图。
   - 待审帖子的图片受后端保护（未通过帖子的图片只有带管理员 token 才能访问），普通 `<img src>` 拿不到：必须用 `fetch(item.image, {headers:{Authorization:'Bearer '+token}})` 取 blob，再 `URL.createObjectURL` 赋给 img.src。已上墙帖子的图片是公开的，可直接用 src；为省事也可以统一走 fetch-blob。
   - 已上墙帖子卡片同样显示图片（直接 src 即可）。
1. **已上墙搜索 + 加载更多**：「已上墙帖子」标题下加一个搜索输入框（输入后 300ms 防抖，带 aq 重新拉 overview 并重置列表）；列表底部加「加载更多」按钮（还有更多时显示，按 aoffset/alimit=20 翻页 append；注意 overview 目前 alimit 默认 100，admin 首屏用 alimit=20）。搜索与翻页都要保持删除/置顶按钮可用。
2. **近 7 日发帖柱状图**：统计区下方加一个小图：用纯 DOM/CSS 柱子（不用 canvas、不引库），每根柱子高度按 count 比例，柱下标注日期，柱顶标注数量；count 为 0 的日子也要显示（矮柱）。数据来自 stats.daily。
3. **待审等待时长**：待审帖子与待审留言卡片的时间行追加「已等待 X」：小于 1 小时显示「X 分钟」，小于 1 天显示「X 小时」，否则「X 天」。用相对当前时间计算，渲染时算一次即可。

## 硬性要求
- 用户内容继续只用 textContent / DOM API，禁止 innerHTML 拼接用户数据。
- 不破坏已有后台功能：登录/登出、统计、待审通过/拒绝/删除、已上墙删除、置顶/取消置顶、全部通过。
- 写完对 server.js、public/admin.js 运行 `node --check`。
- 最后输出简短改动清单。
