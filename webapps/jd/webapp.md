# 京东（jd）

- 状态：active ｜ slug：`jd` ｜ last-verified：2026-10-15 ｜ 验证环境：NAS 容器浏览器 chrome-browser:9224（Chrome 151 / DPR 1.5）+ MCP 只读探查实弹（新版首页搜索栏结构 2026-10-15 实测；客服界面经验来自 2026-10-13/14 护腰坐垫会话实战复盘）
- 建档 2026-10-15（护腰复盘批手册建档，用户裁定轻量路径：手册先行；商品搜索 flow 随本批固化 `flows/jd-product-search.flow.json`）。
- 通用手法（事件可信性红线 / 通道分级 / 页签生命周期 / 拟人化红线等）一律 → references/playbook.md；本文件只收 jd 专属。

```jsonc
// 分段锚定语法 host[:port][/pathPrefix]；实现 = lib/matchers.js；提取 = 本文件首个含 matchers 键的 jsonc 代码块。
{
  "matchers": {
    "urlPatterns": [
      "jd.com",       // 主站（www/jd.com 首页与搜索跳转）
      "item.jd.com",  // 商品详情
      "search.jd.com",// 搜索结果
      "jdcs.jd.com"   // 客服工作台（⚠ 与主站会话体系独立，见下）
    ],
    "knownDeployments": [
      { "pattern": "jd.com", "version": "京东主站公有云（未登录可搜索浏览；下单/客服需登录态）", "verifiedAt": "2026-10-15" }
    ]
  }
}
```

## 识别特征

- URL：`https://www.jd.com/`（首页）；搜索结果 `search.jd.com/Search?search=关键词`（新版）；商品详情 `item.jd.com/<skuId>.html`；客服 `jdcs.jd.com`（企业客服工作台，需商家/客服账号登录）。
- 首页标题：`京东(JD.COM)-正品低价、品质保障、配送及时、轻松购物！`（2026-10-15 实测）。

## 专属操作手法

（以下各节=jd 专属：商品搜索 / 客服 / 采集手法）

## 商品搜索（新版首页，2026-10-15 实测）

- **首页已改版**：经典 `input#key` + `.button` 搜索栏**已废弃**——现为 React 搜索栏：
  - 输入框：`input.jd_pc_search_bar_react_search_input`（全页唯一、可见、约 503,58 起 636×36）
  - 搜索按钮：`button.jd_pc_search_bar_react_search_btn`（文本「搜索」，全页唯一；同栏还有图片搜索 `div.jd_pc_search_bar_react_image_search_button` 与切换钮 `button.jd_pc_search_bar_react_switch`，勿混淆）
- 固化 flow：`flows/jd-product-search.flow.json`（首页→点搜索框→输入→点搜索→进结果页，只固化稳定入口段；结果页内翻页/点入商品不进 flow——DOM 季度级腐烂）。
- 搜索后 URL 迁移 `search.jd.com`（效果断言锚）。

## 客服（jdcs.jd.com，2026-10-13/14 护腰会话实战教训）

- **统一界面**：jdcs.jd.com 单页签承载多店会话；**多 jdcs 页签并存会互踢会话**——同域客服页**严禁并行多开**（单页签复用；违反后果=会话丢失/重连循环）。
- **客服入口双路径**随机失效（入口 A/B 互为备份，一条不通换另一条，勿死磕——对齐 MCP 熔断红线 #10）。
- **「转人工」入口时机**：在机器人应答后才出现（首轮对话对象是机器人；直接找转人工按钮找不到是常态）；失效时恢复入口在弹层内。
- **评价区懒加载**：商品评价需滚动触发加载，采集前先滚动到底再取。
- **链接解析法优于 DOM 结构法**：jd 页面 DOM 结构变化频繁（季度级），优先从 `<a href>` 链接解析目标（URL 结构稳定），DOM 遍历定位作兜底。
