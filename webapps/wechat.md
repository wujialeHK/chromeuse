# 微信长截图懒加载专项（wechat.md）

- 状态：active ｜ last-verified：2026-10-22 ｜ 验证环境：NAS chrome-browser（2026-10-21 竞品采集全量 140 篇实证 + 2026-10-22 `scroll-shot` 内置 promote）
- 定位：微信文章长截图的**懒加载 / 占位图专项技术笔记**。应用入口、采集路径、反爬与配图规则见 `webapps/wechat-mp/webapp.md`；本文件只收长截图陷阱，避免与 app 手册重复。
- 来源：conventions 记忆 2026-10-21 用户裁定条目全文迁移；机制细节与工具面以 `lib/scroll-shot.js` / `node tools/cdp.js scroll-shot --help` 为准。

## 陷阱：占位图「已加载」误判（2026-10-21）

- **现象**：微信文章懒加载未触发的图是 `<img class="rich_pages wxw-img js_img_placeholder" src="data:image/svg+xml,...">`；此时 **`img.complete === true` 但 `naturalWidth === 1`**——用 `complete` 判已加载、用 `naturalWidth > 0` 判有图**都是错的**，长图会成段纯白（他方 140 篇里 31 篇 ≥2000px 空白）。
- **判据**：**强制 `img.src = img.getAttribute('data-src')` + 等 `naturalWidth > 1`**；占位符识别 = `src` 以 `data:` 开头 / class 含 `js_img_placeholder`。promote 后归 **pending 不归 placeholder**（src 已变真、class 仍在、nw 先归 0——判错会二次提前退出复现白段）。
- **GIF**：同为 `data-src` 懒加载；强制加载后还要等 **1.8s**（实测 1.5~2s）首帧解码再截，否则截到空白 / 未渲染帧。
- **并行截图**：**禁止共享 tab**——多 worker 复用同一页签（如 `--reuse`）会撞 navigate/close 竞态，实证 4 worker 复用一页 140 篇失败 21 篇；各自独立页签后 140/140。锁只保 pageId 获取，**不保同页签并发驱动**。
- **工具面**：`cdp.js scroll-shot` 已内置 promote（`--img-promote` 默认开、`--img-settle` 默认 1800ms）与 `naturalWidth>1` 判据；滚动预热不可靠（700px/180ms 慢滚到底仍可能停在占位符），只作背景图兜底（F9）。

## 采集检查清单

1. 长截图前确认 `scroll-shot` 版本含 promote（V202610220001+）。
2. 看清单 `images:{total,promoted,placeholder,pending,loaded}`——`placeholder>0` 即仍有未 promote 的图。
3. 出空白段先查占位图，不要先怀疑滚动或切段；`--blank-check` 默认开，仅 advisory。
4. 多篇并行 = 每 worker 独立页签，结束各自 `closeTab`；与 `webapps/wechat-mp/webapp.md` §懒加载与长图实证（F8/F9/F14/F15）互为索引。
