# ChatGPT（chatgpt）

- 状态：active ｜ slug：`chatgpt` ｜ last-verified：2026-09-21 ｜ 验证环境：NAS 容器浏览器 chrome-browser:9224（Chrome 151 / DPR 1.5）+ cdp.js flow 实弹（单轮 chat **10/10**（补跑三轮收口：合成器冷启动停滞自愈后截图步 203ms 过）；2026-09-21 改版定位符整体漂移修复+四形态实弹复核，V202609210003）
- 建档 2026-09-10（GPT 讨论发帖 flow 蒸馏入库）；2026-09-11 完善发送/停止按钮状态机 + 输出完成判别 + 单轮 chat flow 固化；2026-09-13 假绿链事故（gpt-debate-r1 三轮默认值假绿）定稿收单断言+双信号完成判别（P0-1/P0-2/P0-3 引擎侧联动）；2026-09-21 改版定位符整体漂移（id/testid/data-message-author-role 体系废弃）换锚修复（aria-label+type 锚，「你说：」文本锚，ProseMirror 库级 class 锚）。
- 通用手法（事件可信性红线 / 通道分级 / 录屏管线等）一律 → references/playbook.md；本文件只收 chatgpt 专属。

```jsonc
// 分段锚定语法 host[:port][/pathPrefix]；实现 = lib/matchers.js；提取 = webapp.md 首个含 matchers 键的 jsonc 代码块（块内注释禁写三反引号——会提前闭合代码块致 matchers 解析失败，2026-09-11 实测坑）。
{
  "matchers": {
    "urlPatterns": [
      "chatgpt.com" // 公有云唯一部署形态：精确 host 段（登录态必需；NAS 容器浏览器走 mihomo 代理出网，curl 直测 403 属 Cloudflare 拒 curl UA，浏览器访问正常）
    ],
    "knownDeployments": [
      { "pattern": "chatgpt.com", "version": "chatgpt.com 公有云（会话登录态走浏览器 profile；免费档）", "verifiedAt": "2026-09-11" }
    ]
  }
}
```

`identify --url https://chatgpt.com/ --assert-app chatgpt` 验证（matchers 与 flow 安全阀同源本文件，无 config.jsonc 独立登记）。

## 识别特征

- URL：`https://chatgpt.com/`（首页=新会话；会话页 `/c/<uuid>`；query 不影响识别——matchers 纯 host 段，2026-09-11 实测三形态单命中 score 8，伪装域名 fakechatgpt.com.evil.io 正确拒绝）。
- 登录态判别：body 无 `Log in` / `登录` 字样 = 已登录（侧栏底部显示用户名）；出现 `Log in` = 掉登录态，需人工恢复。
- 输入框：`div.ProseMirror[contenteditable=true]`（09-21 改版后无 id 无 testid；ProseMirror 为编辑器库级 class 实测跨改版存活、全页唯一；placeholder=「给 ChatGPT 发消息」；旧 `#prompt-textarea` id 已废弃，textarea 选择器仅作兜底保留）。
- **输入框右下角按钮状态机**（V202609210001，09-21 改版后 id/testid 体系整体废弃，三态按钮同槽位切换、锚走 aria-label+type）：

  | 状态 | 按钮文本 | 锚 | 说明 |
  |------|----------|----|------|
  | 空/完成态 | `开始语音`（type=button）+左侧`听写` | `button[aria-label=开始语音]` | 语音钮在位=空态=可发送；**完成主信号=此钮回归**；submit 不在 DOM |
  | 有内容态 | `发送`（**type=submit**） | `button[type=submit][aria-label]` | 语言无关锚（aria 只用属性存在性）；有值态全页唯一；鼠标真实点击发送（**用户红线：禁 Enter**） |
  | 思考/流式中 | `停止`（type=button） | `button[aria-label=停止]` | 完成辅信号=`wait cond absent` 此钮 |

  ⚠ aria 值（开始语音/停止/发送/听写）为中文界面 2026-09-21 实测，随界面语言变（英文界面未实测），type=submit 是唯一语言无关按钮锚。

- 回复读取（V202609210001）：`[data-message-author-role]` 已废弃——消息区为纯文本标记结构，`main.innerText` 中用户消息前缀「你说：」、assistant 消息前缀「ChatGPT 说：」。取最新回复：`main.innerText.lastIndexOf("ChatGPT 说：")` 之后取文，尾部截断锚=「ChatGPT 可能会出错」（中文 UI 套话）。
- 新会话入口：goto `https://chatgpt.com/` 首页即新会话（首选）；侧栏 `a[data-testid=create-new-chat-button]`（「新聊天」）备用。

## 单轮 chat 调用约定（findorcreate 语义落在 AI 编排层）

cdp.js 纪律「永不自动开关 tab」指工具层不代开；tab 查找/创建由 AI 层按序执行：

1. **查**：`node tools/cdp.js targets` 找 `chatgpt.com` 页签（无则第 2 步，有则第 3 步）。
2. **create**：`node tools/cdp.js exec Target.createTarget '{"url":"https://chatgpt.com/"}'` → 开后 targets 列表延迟刷新，首查「未找到」勿急重复开（会开两个），先重查。
3. **激活**（推荐）：`node tools/cdp.js exec Target.activateTarget '{"targetId":"<tabId>"}'` 把页签置前台。
4. **replay**：`node tools/cdp.js flow replay webapps/chatgpt/flows/gpt-single-chat.flow.json --target chatgpt --var topic="<讨论议题全文>"`（N/N 全过；`--target` 用 URL 子串 `chatgpt` 比短 targetId 截断稳）。
5. **读回复**（只读探查，复制即用）：

```bash
node tools/cdp.js exec Runtime.evaluate '{"expression":"JSON.stringify((() => { const a = document.querySelectorAll(\"[data-message-author-role=assistant]\"); if (!a.length) return null; const m = a[a.length - 1]; return { count: a.length, text: m.innerText }; })())","returnByValue":true}' --target chatgpt --timeout 10000
```

（上式 = 取 `[data-message-author-role=assistant]` 最后一节点 innerText；JSON 参数整体用 shell 单引号包裹、JS 内字符串走 `\"` 转义。回复在输出的 `"value"` JSON 字符串里。）

## 多轮讨论约定（不沉淀 flow）

- **多轮讨论不固化进 flow.json**——讨论的本质是 AI 每轮看到回复后自己思考再发问，属于 AI 编排循环，不是确定性 UI 操作序列。
- 约定循环：首轮 `gpt-single-chat.flow.json`（goto 新会话）→ 读回复 → AI 思考 → 第 2 轮起改用 `gpt-single-chat-continued.flow.json`（**无 goto、保持当前会话**，`--var topic="<追问>"`）→ 读回复 → …… 循环至无问题 end。
- ⚠ 多轮时**勿再跑首轮 flow**（goto 会把会话重置丢上下文）。

## flows

- `flows/gpt-single-chat.flow.json`：单轮 chat 主 flow（goto 新会话 → 输入议题 → **鼠标点发送** → stop absent 完成判别 → 截图留证）。2026-09-11 实弹 9/9。
- `flows/gpt-single-chat-continued.flow.json`：多轮追问变体（无 goto；缓冲加长 2.5s 覆盖会话内新 user 消息渲染窗口）。2026-09-11 实弹 7/7。
- 判别式设计（V202609130001 双信号定稿）：发送后**收单断言**（效果断言）= `wait cond url contains "/c/"`（乐观会话创建=消息已提交，WEB: 前缀中间态也算）→ `wait cond element user 消息节点` → **完成判别双信号**：主信号 `wait cond element button#composer-submit-button[data-testid=send-button]`（发送按钮回归=生成结束，对 stop 滞留免疫，timeoutMs 120000）→ 辅信号 `wait cond absent stop-button`（timeoutMs 10000 交叉验证——主信号过而辅信号超时=stop 滞留异常转红）。旧单信号设计（element assistant → ms 缓冲 → absent stop）已废弃：存在性断言可被历史内容满足，且 stop 一闪而过的极短回复窗口不稳。空态下 send-button testid 形态 2026-09-13 实弹验证：`button#composer-submit-button[data-testid=send-button]` 在位且过 X1 闸门（36×36 可见）。

## 专属操作手法 / 已知坑

- **本页首条 mouseMoved hover 处理偶发 ~5s**：flow click 步骤 timeoutMs 必须 ≥ 20s（实测同一会话内有时 548ms 有时 5s+，预算小必撞「CDP 命令超时 5000ms」）。
- **flow key 组合键失效**（如 `Control+A` 反而注入字母）：flow 引擎 dispatchKey 修饰键未带 modifiers 位掩码——chatgpt flow 层规避之（清空输入框走 goto 刷新天然完成，勿用组合键）。
- **输入框随内容自动增高、发送按钮 y 坐标漂移**（单行 y≈288 → 多行 y≈599）：flow 每步实时 locate 天然免疫；手动 exec 点击须先探新 rect，否则点在文字段落上（elementFromPoint 验证过此坑）。
- **type insertText 对长 CJK 讨论稿（千字级）一次填入无压力**；发送后输入框自动清空、右下角回语音按钮（空态标志）。
- **掉登录态**（出现 `Log in`）：需人工在 Selkies 桌面（`http://<NAS>:3000`）恢复登录，flow 不代做。
- **goto 后 URL 变 /c/<id> ≠ 重定向到历史会话**（V202609130001）：会话页 URL 有**乐观中间态** `/c/WEB:<hex>`——本轮发送后服务端确认前的临时会话 ID，随后迁到真实 `/c/<uuid>`。判别法：urlTrail 含 `/c/WEB:` 中间态 = 本轮乐观会话（消息已提交收单）＋会话 ID 前 8 hex 为 unix 秒（对准发送时刻可断定是本轮创建而非历史会话）。**诊断纪律：flow 失败后先读失败报告 `urlTrailSummary`/`terminalState` 勿急 browser-restart 抹现场**——urlTrail 的 WEB: 中间态是「其实发出去了」的直接证据（引擎 P1-2 已自动检测标注）。
- **click 步骤 text 字段无效**（V202609130001，gpt-debate-r1 三轮假绿事故定稿）：click 原语不消费 text——2500 字辩论稿误写进 click.text 被静默忽略，三轮 replay 全部发送 vars 默认值「请只回复：OK」（日志全绿内容全错）。长文本一律入 `vars` 经 type 步骤 `{{topic}}` 消费、回放 `--var topic="<全文>"` 传参；P0-2 字段白名单后 validateFlow 前置拦截（`含非法字段：text`）。
- **stop-button 滞留**（V202609130001）：偶发输出已结束但 stop 圆圈不消失——单信号 `absent stop` 判完成会误等满 120s 超时。完成判别用**主信号 send-button 回归**（`wait cond element button#composer-submit-button[data-testid=send-button]`，对滞留免疫）+ 辅信号 `absent stop`（10s 交叉验证）；主信号过而辅信号超时 = 滞留异常转红人工排查。与 screenshot 超时同场时先 `probe` 合成器（截图通道并非恒可用，见经验 2026-09-08 冻结条目）。
- **「浏览器检查未完成」致输入框消失（2026-10-21 竞品采集会话 ses_ea7cdc9e 观察，未做多轮复现）**：偶发输入框消失、页面提示浏览器检查未完成 → **刷新一次**（reload 当前页，**不重开新页**——新页会丢当前会话上下文）即恢复；刷新后输入框仍不见 → 再按登录态（出现 `Log in`，见上「掉登录态」）或反爬环境异常路径处理（→ playbook §MCP 交互模式纪律 反爬条）。
- **09-21 改版定位符整体漂移（V202609210001 已修复）**：`#prompt-textarea`→无 id `div.ProseMirror`；`#composer-submit-button[data-testid=send-button]`→`button[aria-label=发送]`（type=submit，无 id 无 testid）；`[data-message-author-role]`→「你说：/ChatGPT 说：」纯文本；stop-button testid→`aria-label=停止`。两 flow 已换锚修复+四形态实弹验证。残余风险：①aria 值/文本锚中文界面专属，英文界面需复核；②submit 全页唯一性为 09-21 时点实证，未来页面新增 submit 按钮有唯一性破风险（X1/X4 闸门兜底）；③乐观会话新增 `local-chatgpt:<uuid>` 中间态形态（URL 编码 %3A），旧「WEB: 前缀+前 8 hex 为 unix 秒」判别法对新形态未验证，不脑补。

## 经验

- 2026-09-10：Target.createTarget 开 chatgpt.com 后 targets 列表延迟刷新——首查「未找到」勿急重复开新 tab（会开两个），先重查 targets。
- 2026-09-10：exec --target 用 URL 子串（chatgpt）比短 targetId 截断匹配稳。
- 2026-09-11：发送/停止是**同一按钮 id（composer-submit-button）testid 切换**（send-button↔stop-button）——判状态查 data-testid 而非找两个不同按钮；aria-label 中文态（发送提示词/停止回答）随界面语言变，testid 稳定。
- 2026-09-11：DevTools 损伤排查记：本页 Input 超时曾同时伴随合成器失效（probe ③死），browser-restart 后合成器恢复但 Input 仍超时——最终归因首条（hover ~5s 慢，非损伤）；**probe 三通道 + 手动 exec 单发 Input 对照**是区分「环境损伤 vs 页面行为」的判别手法。
- 2026-09-11：极短回复（如「OK」两字符）流式窗口 <1s，stop 可能一闪而过——完成判别必须有 element+缓冲垫底再 absent（见 flows 节），否则「未开始即判完成」。
