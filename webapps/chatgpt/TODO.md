# chatgpt 应用级 TODO 台账

> 定位（2026-09-21 建立，V202609080008 两级 TODO 下级）：只收 chatgpt.com（OpenAI ChatGPT 桌面 Web）专属观察；通用浏览器经验 → skill TODO.md INBOX。
> **INBOX 只追加**：新问题先追加到 INBOX（一行一条），不做结构化；沉淀时搬入下方结构化区并编号。
> **编号前缀 GPT-**（独立空间，防与 skill TODO-NNN 混淆）；条目内必含 `升级状态:` 行。
> **升级判定双轴**（同时成立才可标 candidate）：① 根因机制不引用本应用专有资产 ② 解法可复制不依赖应用专属路径。
> **唯二升级触发器**：① 第二个 app 撞同机制坑（最强证据）② 人工推广流程显式确认——单 app 单次出现永不自动升级。
> 升级 = skill TODO-NNN 编号条目 + 本条目 `升级状态: 已升级→skill TODO-NNN (date)` + skill 侧来源行回指（双向链接）。

## INBOX（只追加区）

- 2026-09-21 台账建立：首批条目为 09-21 定位符整体漂移（改版断链）。前兆：2026-09-13 composer 空态形态漂移（send-button 空态消失，当时登记于 skill 主台账 INBOX——chatgpt 此前无应用级台账，今随 GPT-001 升格建立）。
- 2026-09-21 英文界面 aria 值复核（开始语音/停止/发送/听写 随界面语言变，type=submit 为唯一语言无关锚）——观察项，有英文环境时复核
- 2026-09-21 local-chatgpt:<uuid> 新中间态的 ID 时间戳规律核实（旧「WEB: 前 8 hex=unix 秒」判别法对新形态未验证）——观察项

## 结构化条目

### GPT-001 [resolved] 2026-09-21
- 现象：chatgpt.com 改版定位符整体漂移——`#prompt-textarea`→无 id `div.ProseMirror`、`#composer-submit-button[data-testid=send-button]`→`button[aria-label="发送"]`（无 id 无 testid）、`[data-message-author-role]`消失改「你说：」纯文本结构；gpt-single-chat.flow.json 步骤 1/2/4/7/8 与 continued 变体断链（oracle Jev 吸收辩论实弹发现，三轮对话靠手工 CDP 绕行完成）。
- 根因：chatgpt.com 前端改版重写 DOM 结构与属性命名——本应用专有资产（页面结构），非通用机制。可通用化的教训（aria/语义层存活优于 id 级 domPath）已吸收进 skill 主台账【录制定位素材增强】素材生成规则。
- 解法：现场复核空态/思考中/发送各形态元素（aria 形态存活良好）；重写 webapp.md 状态机与读回复约定（读回复改 main innerText「你说：」后取文）；修复两个 flow 的 domPath。修复任务载体=skill 主台账 agent 遗留项【chatgpt 定位符 09-21 整体漂移修复】（2026-09-21）。
- 通用性判定：app-only（轴①不成立——根因是本应用 DOM 改版；轴②不成立——解法绑定本应用元素结构）。
- 复核结论（2026-09-21）：已修复闭环——oracle 现场复核四形态（空态=开始语音+听写无 submit/有值态=submit 挂载全页唯一/思考中=aria-label 停止原位替换/完成=开始语音回归）实弹两轮产修复稿；fixer 落盘两 flow 换锚+webapp.md 重写；flow validate 2/2 PASS + 主 flow replay 9/10（唯一红步=步骤 9 screenshot 合成器通道环境损伤，非定位符问题，主台账人工区【chrome-browser 合成器通道恢复】待 restart 后补跑即 10/10）。残余风险两条转 INBOX 观察项（英文界面 aria 复核/local-chatgpt:<uuid> 新中间态时间戳规律）。
- 解决版本：V202609210003
- 验证证据：oracle 实弹四形态取证（短/长回复两轮全通）+ fixer flow replay 9/10（flow-fail-2026-09-21_14-38-47.json 红步判因=合成器通道 probe ③✗）+ URL 轨迹实锤 local-chatgpt%3A 中间态迁真实 uuid；用户 restart 后补跑三轮收口：9/10（截图挂）→ 9/10（截图挂+probe ③✗，同期既有 tab 截图正常区分非全局死）→ **10/10 全过**（截图 203ms，合成器冷启动停滞自愈——主台账 bak 归档行含复发判别法）
- 升级状态: app-only
