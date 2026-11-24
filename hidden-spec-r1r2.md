# 永荣校园墙 · R1/R2 前端升级任务（给 Claude Code 的执行规格）

项目目录就是当前目录。后端 server.js 已支持以下能力，**不要修改 server.js、fonts.css、fonts/ 目录、DESIGN.md**：
- `POST /api/posts` 接受 `image` 字段：值为图片 data URL（`data:image/jpeg;base64,...`），返回的帖子对象含 `image`（路径如 `/uploads/xxx.jpg` 或 null）
- `GET /api/posts` 支持 `offset`/`limit` 分页，返回 `{posts, total, hasMore}`；帖子对象含 `pinned`（布尔）
- 管理端 review 接口支持 action `pin` / `unpin`

只改 `public/` 下的 app.js、index.html、styles.css、admin.js、admin.html，并新建 public/manifest.json、public/sw.js。

## 要实现的功能

1. **图片发帖**（app.js + index.html + styles.css）
   - 发布抽屉里加「添加图片」按钮 + 隐藏的 `<input type="file" accept="image/*">` + 预览区。
   - 选中图片后用 canvas 压缩：最长边 1280px，导出 JPEG 质量 0.82 的 data URL，存到一个变量；预览显示缩略图和一个删除按钮（点删则清空）。
   - 提交时把 data URL 放进 `image` 字段（无图则不带）；提交成功后清空图片状态。
   - 帖子卡片（buildCard）和详情里：`post.image` 存在时在正文下方渲染 `<img class="post-img" loading="lazy">`，src 用 post.image（用 DOM API 设置属性，不要 innerHTML）。
   - CSS：`.post-img{width:100%;border-radius:14px;margin-top:10px;display:block;background:var(--line)}`，加一个淡入动画。

2. **置顶徽标**：卡片头部当 `post.pinned` 为真时显示一个小徽标「📌 置顶」（样式类 .pin-badge，橙色小胶囊），放在分类标签左侧。

3. **无限滚动**（app.js）：列表改为分页加载：每页 15 条（limit=15），维护 offset/hasMore 状态；在信息流底部加一个哨兵元素，用 IntersectionObserver 触发加载下一页并 append；切换分类/排序/搜索词时重置并重新从第一页加载。保留骨架屏只在首次加载时出现，加载更多时显示一个小的「加载中…」尾巴元素。

4. **下拉刷新**（app.js）：页面滚动在顶部（window.scrollY <= 0）时，touchstart→touchend 向下拉超过 70px 且没有抽屉打开，则重新加载第一页并 toast「已刷新」。实现要简单稳健，避免和正常滚动冲突。

5. **热门榜条**（index.html + app.js + styles.css）：在分类 chips 下方、信息流上方加一个 `#hotStrip` 区块：仅当未选分类（全部）且无搜索词时显示。数据取 `GET /api/posts?sort=hot&limit=5`，横向滚动卡片：名次数字（第 1–3 名用主色橙，其余灰色）、正文两行截断、点赞/浏览小字。点击卡片打开该帖详情。切换到「我的投稿」视图时隐藏。

6. **点赞粒子动画**（app.js + styles.css）：点赞成功点击时，在按钮位置生成 6 个小爱心/圆点粒子（span.particle），用 CSS 自定义属性给每个粒子随机方向，keyframe 动画飞出并淡出，动画结束移除。粒子内容用 ❤ 字符或纯色圆点均可，注意性能与不影响布局（position:absolute，按钮需 position:relative + overflow visible）。

7. **PWA**：
   - 新建 public/manifest.json：name「永荣校园墙」、short_name「校园墙」、start_url「/」、display「standalone」、background_color「#FAF5EC」、theme_color「#E4572E」、icons 引用 /icon-192.png (192x192) 与 /icon-512.png (512x512)。
   - index.html 加 `<link rel="manifest" href="/manifest.json">` 和 `<link rel="apple-touch-icon" href="/icon-192.png">`。
   - 新建 public/sw.js：缓存名 `yr-wall-v3`；预缓存 ['/', '/index.html', '/styles.css', '/fonts.css', '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png']；fetch 策略：`/api/` 开头的请求只走网络；其余先缓存后网络并回填缓存；activate 时清理旧版本缓存。
   - app.js 末尾注册：`if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{})`。

8. **管理端增强**（admin.js，必要时 admin.html）：
   - 已上墙帖子卡片的操作区加「📌 置顶 / 取消置顶」按钮，调用 review 接口 action pin/unpin 后刷新；已置顶的帖子在标题行显示 📌。
   - 待审核帖子标题旁加「全部通过」按钮：点击后二次确认（confirm），然后逐个 approve 当前待审列表，完成后刷新并 toast。

## 硬性要求
- 所有用户内容继续只用 textContent / DOM API 渲染，禁止 innerHTML 拼接用户数据。
- 保持现有配色变量与设计语言（暖纸色 #FAF5EC、柿子橙 #E4572E、卡片圆角 18px 等，见 styles.css 现有变量）。
- 不要破坏已有功能：发帖/匿名/分类/搜索/排序/详情/留言/点赞/我的投稿/后台审核都要继续可用。
- 写完后对 public/app.js、public/admin.js、public/sw.js 运行 `node --check` 确认语法无误。
- 最后输出一份简短的改动清单（改了哪些文件、各自做了什么）。
