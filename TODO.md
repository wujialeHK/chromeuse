# chromeuse TODO —— 待办与进度台账（唯一活台账）

> **使用规则（6 条）**
> 1. **冷启动**：读「当前焦点」→ 扫「人工遗留项」分区（需用户动作）与「agent 遗留项·挂账观察区」（等触发，索引表）→ 人工条目读最后一条进度行即可接手，观察项按档案锚点回查。
> 2. **条目格式**：`- [ ] [难度|类型|优先级] 【标题】描述`；难度=简单|复杂；类型=bug|增强|新功能；优先级=高|中|低（高=阻塞复杂自动化主线无绕行；新功能默认低，提级须显式）。人工区条目含「需用户：…；完成后 agent：…」。
> 3. **进度时间线**：条目下 `  - 进度（YYYY-MM-DD）：事实；证据=file:line|tmpdata/…|V版本号|reports/…；下一步=动作`——只记接手最小事实；报告只放路径；跨会话边界必记。
> 4. **完成收口四步**：删条目 → CHANGELOG 记批（做了什么/证据/边界）→ VERSION.md bump → git commit（message=`V版本号 一句话`，详情不回写 commit）。
> 5. **验收口径**：`node selftest.js` ALL PASS（0 fail；warn 逐条有解释）；实弹任务 `-v` 双流+两连过；设计不确定先问用户；**新增/改命令=改 commands.meta.json+跑 `node scripts/build-help.js`**（禁直改 SUB_HELP/SKILL §1.2，#95 会抓漂移；同批核对 #98/#116④/mechanisms §8.2 计数）。
> 6. **对账四步**（每批收口顺手）：开放条目有效性复核 → 「当前焦点」重写（≤6 行，禁追加）→ 环境注记刷新 → INBOX 办结/吸收行删除（git 留痕）。

## 当前焦点（≤6 行，对账批重写，禁追加；每行指向下方分区条目标题，便于对照观察）

- 最近一批：**2026-11-18 Windows 复验收尾确认**（V20261117016，用户回传）——Windows 副本位全量 selftest **432 项 / 10 warn / 0 fail，ALL PASS**：覆盖 V20261116002（分隔符族/gitRoot/proc 守卫）→ 平台分层四批 → 三需求（R1/R2/R3）→ R4 flow 参与配置 → selftest 去 tmpdata 化 → 三轮 ISSUE 三修（Chrome88 beyond / LOG_DIR / --proxy）全部生效；**本轮修复全部收尾**。
- 前一批：2026-11-17 Windows 三轮 ISSUE 三条全修（V20261117015，骨架 434/0/0）；tmpdata 化（V20261117014）+ R4（V20261117011）+ 三需求（V20261117005~008）+ 平台分层（V20261117001~004）。
- agent 可自主项：**无在途**——Windows 复测捆已整捆收口（六步全过，用户 2026-11-18 确认）；人工区余 ERP 库存锁定复测捆+第二应用手册化；观察区 O1~O25；遗留尾件=uniqueDefault 影响清单（tmpdata/impl-b5a/unique-inventory.json）。
- 人工等待·ERP 捆：**【示例ERP测试库库存锁定复测批】**（2026-11-13 用户裁定改用现货锁定 spot-lock 流测试、领料锁定子项去除；批 8 整编+新引擎改造在途）——等用户确认「秒见三项」恢复（agent 实弹两连过=恢复实证）。
- 环境注记：ERP 服务可达（2026-11-13 实探 200/41ms；此前「服务端退化」注记已过时）；Selkies 活；chatgpt 定位符 153 新 UI 部分漂移待补记 webapp.md（ProseMirror/submit 仍有效）；chrome-browser 11-03 一次自愈型重启（复发再取证）；unpkg 出网意外通畅（2026-11-04 实测，勿泛化）。

## 指针

一行式：README.md（架构/安装）· SKILL.md（使用手册/红线）· references/playbook.md（操作守则）· references/facts.md（技术事实）· references/distill.md（蒸馏规则）· CHANGELOG.md + VERSION.md（批次史/版本真源）· reports/（报告与设计稿）· webapps/<app>/webapp.md（应用手册）

## 人工遗留项（需要用户操作/决策）——2026-11-05 用户裁定归纳：两大复测捆+其他

- [ ] [复杂|增强|中] 【示例ERP测试库库存锁定复测批（ERP 恢复后一批完成）】合并原【inventory-lock 复测准备】【库存锁定人工对照】+观察区 O2（E6 面板旁路/delivery 步骤 31 重锚）。**2026-11-13 用户裁定：业务已统一为库存锁定（现货锁定），测试一律用 spot-lock 流；领料锁定子项已去除**（功能不复存在，现货锁定无法测试该场景=按裁定直接去掉；diag-liliao 流已随整编删除）。**批内流程**：①用户确认「点开现货锁定下拉秒见三项」恢复（或 agent 实弹 spot-lock 两连过即恢复实证）→ ②agent 跑 sales-order-spot-lock 复测整体两连过（批 8 已改造适配新引擎）→按流程清理锁定记录（cast 伴跑留证）→ ③agent 同捆顺跑 E6 面板旁路实测（销售管理壳→侧栏双击销售订单判别）+delivery 步骤 31 待发池重锚（sales-delivery-extract 流批 8 已改造）→ ④用户 Selkies 侧人工对照观察一轮（人工观察 agent 不可替代）→ ⑤agent 对照结论入档+全批收口关条目。
  - 进度（2026-09-30）：inventory-lock 数据已备（SL2609300001/0002 两笔订单保留至复测完成）；链路 0~17 步已验证，菜单项→锁定页段被服务端退化阻塞（注入 26s~3min+/自灭）；证据=V202609300022+CHANGELOG 复测批。
  - 进度（2026-10-19）：E6 面板链全通到壳+侧栏（ERP flow 面板人类链路两连过 27/27×2）；领料锁定流程两连过+根因实锤（物料域缺 taihe-extension.jar→销售订单模块初始化中断）；证据=V202610190003+webapps/erp_demo_test/webapp.md。
  - 进度（2026-11-05）：**用户裁定归纳成捆**（原两人工条目+观察区 O2 合并，批内五步流程如上）；下一步=用户确认恢复后启动②。
- [ ] [复杂|增强|高] 【第二应用手册化验证·完整章程级】章程双重目标之一（方法论可迁移性验证）：刻意选性质不同的现代 SPA（React/动态 DOM/不同交互模型，非 iframe 老 ERP 同类），全管线录制→蒸馏→flow→回放+webapp.md 手册沉淀，实测蒸馏成本（<2h 可迁移成立 / >4h 收缩为 示例ERP 专用）。轻量第一步已落（jd/taobao-tmall 双手册+双搜索 flow 实弹，V202610150001）。需用户：提供目标应用+可访问地址/账号；完成后 agent：开全管线验证。
  - 进度（2026-10-15）：轻量第一步落地；完整章程级等选型+环境；证据=V202610150001。

## agent 遗留项·挂账观察区（gate/触发类索引表；细节档案=git 历史+CHANGELOG；压缩迁移存档=V20261104013 前最后完整版 commit `e023976`；**2026-11-05 O2/O11 升入人工区两大复测捆，编号跳空保留**）



> 以下开放条目源自 2026-11-13 opencode Browse 对比调研批（用户裁定优先级：好用类在前、省 token 类在后）；调研档案=reports/opencode-browse对比调研-20261113.md（v2 含 14 条批注回应+select 闸门分析 §2.7）。



| # | 条目 | gate（何时动） | 触发后动作 | 档案锚点 |
|---|------|--------------|-----------|---------|
| O1 | CDP 随机失效深度排查 | 真实失效现场（先取证不急重启） | doctor-forensics 分型取证+Phase2/3 | V202609300008+reports/CDP失效分型取证协议 |
| O3 | 运行时索引化观察 POC | 重 SPA -32001 且网络/截图不可替代 | 按 Jev P0 终审四指标 | reports/Jev 吸收终审 |
| O4 | 录制帧率 v2/v3 | v1（--every-nth 默认 6）不够用 | trailing ack 巡航 1000ms+事件升 100ms | reports/录制侧演进分析 题2 |
| O5 | drag 阈值标定 | ≥5 段真实拖动素材 | 离线标定 6px 起点（aggregateDrags） | V202609170002 |
| O6 | 录制定位素材实弹核对 | 下次实录会话 | 蒸馏时顺手核对六型白名单/aria 优先/跨 iframe path；**素材消费协议已落（V20261113批1），下次实录顺手核对后关** | V202609220002 |
| O7 | 容器间同名 items 冗余 | 真实消费痛点 | 跨容器归并 | uiAppear 质量批 |
| O8 | diag-O toggle 探针补跑 | Selkies 环境可用 | 补跑 tmpdata/selkies-live/diag-O-toggle.flow.json 留档 | reports/面板死循环根因 §六 |
| O9 | 冻结期 Network 域实测 | 下次 -32001 现场 | net 取 payload 进 facts.md 归属表 | net 子命令批 |
| O12 | MCP timeout 提档副作用 | 真死锁场景 | 记体感时长进 facts.md（裁定维持 60000） | 用户裁定 2026-09-07 |
| O13 | webapps 识别特征索引表 | 应用 >10 个（现 4） | 索引表评估 | — |
| O14 | docker 结构性配置模板 | docker-only 结构键出现 | 加第三模板+#8/#9 联动 | — |
| O15 | 模板共享节生成脚本 | 模板 >4 个（现 2） | 评估手改事故率 | — |
| O17 | chrome-cdp-skill 并列安装（2026-11-13 C1 裁定连带降级） | ①≥2 类必要操作不可达②持久 tab 连接诉求 | 可选 --session-file 连接复用（finally 还原+--reset） | git e023976 条目全文 |
| O18 | 双端并发调度机制化 | 并发 ≥3 起/周或锁争用失败 | 队列/调度评估（锁已做调度不做） | — |
| O19 | BrowserAct/agent-browser/ego-lite | 反爬抓取/轻量替代需求场景 | 实测 | — |
| O20 | 视觉优先路线远期 | 成本/精度成熟 | 评估（现 --experimentalVision+click_at 承载） | — |
| O21 | N10 任务预算+断点续跑 | 长任务中断成真痛点 | --task-budget(E_BUDGET+resume 句柄)/--resume（scroll-shot 清单跳 ok 段/flow checkpoint 变量续跑）/HMAC 句柄；B7 已覆盖 cancel partial+并发面，未覆盖=预算自动停+续跑 | V20261104002 §14+git e023976 条目全文 |
| O22 | oracle 归因批三小件 | ERP 正常态/弹窗场景 | ①网络弹窗 DOM 特征采集→弹窗守卫 v1（检测+记录不自动关）②E1 多标签 A/B 刻意实验③replay 前置 ERP 标签计数告警 | V202609180003 |
| O23 | cdp.js --help 管道消费 8192 截断 | 下次 --help 管道消费受阻或随手批（pre-existing：process.exit 不等 stdout flush，HEAD 同截断，#119 批发现未修） | 退出路径改 process.exitCode 或 exit 前 drain stdout；主 help 现 ~11.9KB>8192，管道 grep/head 只见前 8192 | V20261112002 findings |
| O24 | parseArgs 布尔旗标吞后续 token（--json 型） | 随手批（pre-existing；#119 已给 --insecure 打了 =true 归一补丁先例 cdp.js main()） | 全面排查布尔旗标（--json 等）值消费形态，统一归一或禁值 | V20261112002 findings 1 |
| O25 | 直接路径断言未联动 flow 排除机制 | 下次改/删 erp_demo flow 时 | #44③/#46 活哨兵/#60/#67-D/#71 等仍直读 erp_demo flow 文件——排除状态下改删仍会红；如需「整 app 休眠」语义给这些点挂 excludeApp 短路 | V20261117011 报告 §十+fixer 边界⑤ |

## ISSUE（跨环境兼容性缺陷归档区 · Windows 端复验上报；与 INBOX 区别 = 已定性、待实施的修复项）

> 2026-11-16 首三批（#126/#130/#102 分隔符族 / #19 gitRoot 判据 / #113 /proc 守卫）已修复收口（V20261116002）；2026-11-17 二轮 5 项（fake 浏览器 spawn 垫片 / #133 期望路径 EXT / #134 /proc 守卫 / #137 反侧 OPP / #138 执行位注入）已修复收口（V20261117010）——**暂无开放条目**。

> **主线约束（2026-11-16 用户裁定，沿袭）**：本区全部为**兼容性修改**——NAS 端（Linux）必须流畅跑通、修改后不得引入新 bug（现有 selftest 全绿基线不可破坏）；每条方案均附「POSIX 等价/纯增分支论证」，NAS 端无法测 Windows，故 Windows 端做实证调研供直接实施。条目格式同上；解决后整条删除，结论进 CHANGELOG。

## INBOX（观察追加区；办结/吸收行对账批删，git 留痕）

- 2026-10-11 [bug] 视口截断（宽度维度）致 MCP click(uid) 报 "did not become interactive"：天猫详情页窗口 500×579 时按钮 rect x=720 超视口宽、滚动容器横向不可滚（scrollWrap sw=cw），elementFromPoint(cx,cy) 返回 null 是快速判别法；解法=resize_page 临时加宽（1280×800）操作完恢复。与 09-30 矮窗口高度维度条目同族。**开发候选②仍开放**：引擎层 click 前置视口校验（元素超视口时先尝试滚动/resize 再点，或 advisory 提示）；候选①已由 B4 诊断细分码吸收（V20261104002）。
- 2026-11-13 [bug|chatgpt] gpt-single-chat flow 步骤 type→发送 click 间时序坑（Chrome 156 实证）：type 后立刻 click，X1/X4 闸门过、495ms 返回 ✓，但点击被吞（URL 不迁 /c/、消息 0、输入框文字保留、按钮仍可点——已登录态排除登录墙；同锚缓冲后手动 click 成功实证锚无误）。修复=flow 步骤 4 前插 wait ms=1200（ProseMirror/React 状态同步缓冲，validate 过+待两连过实弹确认）；待蒸馏批补记 webapp.md。

> **两级 TODO**：应用级观察 → `webapps/<app>/TODO.md` INBOX（下级台账，独立编号）；本台账只收通用问题。升级双轴判据+唯二触发器见各 webapps/<app>/TODO.md 头注。
