# 淘宝/天猫（taobao-tmall）

- 状态：active ｜ slug：`taobao-tmall` ｜ last-verified：2026-11-13 ｜ 验证环境：NAS 容器浏览器 chrome-browser:9224（Chrome 156 / DPR 1.5）+ MCP 只读探查/flow 实弹（首页搜索栏经典结构 2026-10-15 实测存活；红包弹窗规则 2026-11-13 实录+合成 fixture 验证；旺旺/遮罩/断连经验来自 2026-10-13/14 护腰坐垫会话实战复盘）
- 建档 2026-10-15（护腰复盘批手册建档，用户裁定轻量路径：手册先行；商品搜索 flow 随本批固化 `flows/taobao-product-search.flow.json`）。
- 通用手法（事件可信性红线 / 通道分级 / 页签生命周期 / 拟人化红线等）一律 → references/playbook.md；本文件只收 taobao-tmall 专属。

```jsonc
// 分段锚定语法 host[:port][/pathPrefix]；实现 = lib/matchers.js；提取 = 本文件首个含 matchers 键的 jsonc 块。
{
  "matchers": {
    "urlPatterns": [
      "taobao.com",      // 主站（www 首页/搜索）
      "detail.tmall.com",// 天猫商品详情
      "buy.tmall.com",   // 天猫下单确认
      "login.taobao.com" // 登录
    ],
    "knownDeployments": [
      { "pattern": "taobao.com", "version": "淘宝主站公有云（未登录可搜索浏览；下单/旺旺需登录态）", "verifiedAt": "2026-10-15" }
    ]
  }
}
```

## 识别特征

- URL：`https://www.taobao.com/`（首页，标题「淘宝」）；搜索结果 `s.taobao.com/search?...`（新版）；天猫详情 `detail.tmall.com/item.htm?id=...`；下单 `buy.tmall.com`。
- 首页无登录墙可直接搜索（2026-10-15 实测；下单/旺旺才要登录态）。

## 专属操作手法

（以下各节=taobao-tmall 专属：商品搜索 / 旺旺客服 / 采集手法）

## 商品搜索（2026-10-15 实测：经典结构存活）

- 输入框：`input#q`（class=search-suggest-combobox-imageSearch-input，可见）——淘宝多年稳定锚，比京东 React 改版栏稳。
- 搜索按钮：`button.btn-search`（文本「搜索」）。
- **⚠ 搜索=新 tab 打开结果页（按钮与 Enter 皆然，2026-10-15 实测）**：原 tab URL 不迁移、联想面板不关闭——流内无可靠收单信号（flow 引擎单 tab 模型边界）。
- 固化 flow：`flows/taobao-product-search.flow.json`（首页→点搜索框→输入→点搜索按钮=触发段，只固化稳定入口段；结果页内操作不进 flow）。
- **编排层收单（replay 后必做）**：`node tools/cdp.js targets | grep "s.taobao.com/search"`（或 MCP `findTabs({urlPart:"s.taobao.com/search"})`）——新页签存在且标题=「<关键词>_淘宝搜索」即收单；后续采集在该新 tab 上做（findTabs 现查 id，勿记忆）。
- **新版详情页 CTA 商家可配置**：可能只有「领券购买」（直达订单确认页）而无「加入购物车」（2026-10-11 比价会话实证：全页 DOM 搜按钮文本仅 0×0 隐藏节点）——自动化加购前先全文搜索确认按钮存在性。
- 点击触发导航后旧 snapshot uid 必失效（SKU 切换/商品卡片点击），必须重新 take_snapshot。

## 旺旺客服（2026-10-13/14 护腰会话实战）

- **旺旺=同源 iframe 可直读**：客服会话在同源 iframe 内，evaluate 可直接读 DOM；坐标需 `getBoundingClientRect` + iframe 偏移换算（iframe 内坐标 ≠ 页面坐标）。
- **next-overlay-backdrop=阿里 next 组件库通用遮罩**：输入前先查 `div.next-overlay-backdrop` 是否在 DOM——在=有弹层遮挡，先处理弹层再输入。
- **断连恢复序列 checklist**（单次恢复 ~2min → ~30s）：检测断连（消息发送失败/iframe 重载）→ reload 页面 → 等会话列表出现 → 重新定位输入框 → 重发消息 → verify 送达。

## 弹窗拦截（popup-guard 规则锚点）

- 红包提醒弹窗「你有450元红包即将过期」（2026-11-13 实录，会话 `ses_e2ca1cc67ffd4HcsXWMCtnrQFx`）：组件=alicdn `tbpc-pop-dynamic-common`；DOM=`index_module_popMask`（全屏 fixed 遮罩，z=auto）> `index_module_redPacketReminderWrapper`（516×592 红包底图，实测渲染 300×312）> `index_module_redPacketPopupContent`（300×312）+ `index_module_redPacketPopupClose`（48×53，right:-122/top:-66，实测中心 1200,254）。规则=`taobao-redpacket-layer` / `-redpacket-mask` / `-pop-dynamic-mask`；⚠ 只删卡片会留全屏 popMask 挡住整页，遮罩必须同删。
- 既有中心浮层规则（rect≥600×400 + z≥1000）对本弹窗**双闸都不命中**（遮罩 z=auto、卡片 300×312）——2026-11-13 现场 scan 命中 0 的根因。

## 采集注意

- **评价详情需独立页**（评价列表内展开受限）——已知能力边界，采全量评价走独立评价页。
- **SKU 用 innerText 直读**（规格按钮文本），规避视口截断（rect 超视口时 DOM 结构法会漏）。
- 视口不足时元素「可见点不中」（2026-10-11 宽度维度实证：按钮 rect x=720 超视口宽 500）——`elementFromPoint(cx,cy)` 返回 null 是快速判别法，解法=resize_page 临时加宽操作完恢复。
