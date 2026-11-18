# chromeuse CHANGELOG —— 人读版本史

> 版本规范 `V<YYYYMMDD><NNN>`：日期 = 发布日（git 提交当日），同日 +1，跨日清零回 001，>999 自然进位 4 位永不回绕。

## V20261118001 — 2026-11-18 [chore]

- **骨架运行态清理（用户裁定：运行时生成文件不污染骨架项目与 git；webapps 目录除外）**：
  - 删除 skill 骨架 `log/*.log`（77MB / 15 个轮转日志，保留 `log/.gitkeep`）与 `tmpdata/`（324MB / 5412 文件 / 108 目录，整目录删除——`lib/paths.js` 运行时按需重建）。
  - **保留** `webapps/*/tmpdata`（102MB 证据资产，用户明示除外）；`bin/`（用户自管二进制）、`config.jsonc`（机器实例）不动。
  - **gitignore 已完备（无需新增规则，实测验证）**：根 `.gitignore:71` `skills/chromeuse/tmpdata/` 整目录排除、`:74` `log/*.log`、`:24` `**/tmpdata/*`（覆盖 webapps 下 tmpdata，样本 `git check-ignore` 命中）；git 跟踪的运行时文件仅 `log/.gitkeep`（`git ls-files` 计数=1）。
  - **验证**：清理后骨架全量 selftest **434/0/0**（tmpdata 缺失自动重建）；build-help 49 命令零漂移；`git status` 干净（删除项均已被忽略，零跟踪文件变更）。

## V20261117016 — 2026-11-18 [doc]

- **Windows 副本位全量复验收尾确认（用户回传 2026-11-18）**：**432 项 / 10 warn / 0 fail，SELFTEST：ALL PASS**——覆盖 V20261116002（分隔符族/gitRoot 判据/proc 守卫）→ V20261117001~004 平台适配分层全链 → V20261117005~008 三需求（ffmpeg config.bin / `--config` / browser-up+--auto-launch）→ V20261117011 R4 flow 参与配置（启动汇总行纳入 4/排除 4 生效）→ V20261117014 selftest 去 tmpdata 化（干净 tmpdata 0 fail）→ V20261117015 三轮 ISSUE 三修（Chrome88 beyond 探测/A2、CHROMEUSE_LOG_DIR、browser-up --proxy）全部生效。
  - warn 10 条=平台分支与环境差异（#134 非 Linux `/proc` 正向实弹跳过、#19 非 git 仓自适应、各平台专属断言等），均设计内且可逐条解释；0 fail = 无遗留缺陷。
  - **本轮修复全部收尾**；**Windows 复测捆整捆收口**（用户同日确认六步流程全部完成：行尾归位实跑 / install junction→symlink→copy 三级回退 / flow replay 三态视口 / 多分辨率矩阵 / Node 采样 / 本批 selftest 复验）——2026-11-05 归纳的捆条目移除。

## V20261117015 — 2026-11-17 [fix]

- **Windows 三轮 ISSUE 三条全修**（V20261117013 上报；骨架 433→**434/0/0**，#141 新组 8 用例；build-help 49 零漂移）：
  - **ISSUE-1 Chrome 88 静默忽略 `captureBeyondViewport`（复杂）**：新 `lib/beyond-probe.js`（228 行）——`pngSize`/`judgeProbe` 纯函数 + 双拍编排（同 clip `beyond:true` vs `false`）+ **歧义态控制拍自证**（P3==P1 才判支持，防页面动画误判；oracle 报告唯一显式偏离，理由=现代 Chrome P2 实测「尺寸同+md5异」，严格双拍会每轮重探永不缓存）+ 缓存 `tmpdata/state/beyond-viewport.json`（dir 注入/原子写/损坏重探/key=browserVersion/无 TTL）+ **fail-open**（异常按支持且不写缓存）。`lib/scroll-shot.js`：A 分支 **A2 分叉**（`beyondSupported===false && captureHeight≤VIEWPORT_CAP(10000=截图单边上限) && viewportWidth≤CAP`）→ 段级 `beginEmulation` 撑视口 → 无 clip 截图 → `finally` 恢复轮次状态（有则重施加 plan/无则 clear）→ 失败落 jpeg 降级 → B 兜底；`manifest.beyondProbe` 留证；`lib/paths.js` 加 `STATE_DIR`；**不加 `--no-beyond`**（YAGNI）。**现代 Chrome 零回归实弹**：NAS Chrome/156 同长页改前后段图 **6/6 md5 逐文件一致**；首探 `beyondProbe={supported:true,by:'md5',cached:false}` → 二次 `cached:true` 且 capture=6/probe=0/Emulation=0。**P2 定性**（Chrome 156）：`beyond:false + clip高>视口` 不报错不夹高（完整尺寸、md5 异）→ 三行为均安全。
  - **ISSUE-2 `CHROMEUSE_LOG_DIR` 缺失**：`lib/paths.js` `LOG_DIR` 支持 env（未设/空串→默认逐字节同；绝对原样；**相对按 SKILL_ROOT**）；`DEFAULT_LOG_DIR` 单源导出；install.md 与 TMPDATA 成对隔离说明。
  - **ISSUE-3 浏览器 `--proxy-server` 缺失（用户裁定 b）**：`lib/browser-launch.js` `normalizeProxyUrl`/`resolveProxySource`（**CLI `--proxy` > env `CHROMEUSE_BROWSER_PROXY` > `config.proxy.httpProxy`**，全空不加参=现状逐字节同；非法值 fail-fast 不回退）/`redactProxyUrl`；`launchArgs` 第四参（Windows 继承同实现）；`browser-up --proxy` + `--auto-launch` 透传 + `--status` 显示（state 落脱敏值+proxySource，无代理不落字段）；复用实例+显式代理时提示需先 `--stop`。
  - **验收**：骨架 434/0/0；#141 8/8（判定四态/缓存注入/双拍+控制拍/A2 分叉与 >CAP/A2 透明性/缓存零开销/fail-open/源码锚点）；`grep process.platform` 零命中；新断言零 tmpdata 依赖（注入临时目录/fake）。
  - **边界**：Windows Chrome88 未实弹（NAS 无 88）→ A2 legacy 仅 fake 验证，真机口径=长页>3 倍视口+尾部 luma≠255+blankCheck 不 suspect；`captureHeight>CAP` 极端段保持 A→B；88 的 `clip.y>0` 坐标语义未实锤（宽触发口径防御性兜底）；有头 Windows A2 窗口会闪动（与 `--viewport-max-chunk` 同现状）。

## V20261117014 — 2026-11-17 [fix]

- **selftest 断言源彻底去 tmpdata 化**（用户裁定：「tmpdata 是运行时临时数据目录，selftest 等地方不要再出现依赖」；ISSUE 三轮 #46 根因修复）——骨架 **428/0/0**、**空 `CHROMEUSE_TMPDATA_DIR` 428/0/0**、live **427/1 warn/0 fail**：
  - **新增永久断言靶子**：`selftest/fixtures/flow/sentinel-match.flow.json`（最小合法 flow，`target.text.match:'exact'` + `wait.container.text.match:'contains'` 各一处，validateFlow 0 错）+ `selftest/fixtures/README.md`（「fixtures=断言靶子，非业务 flow」）。
  - **单源 helper**：`flow-policy.assertionFlows()` = `participatingFlows().participating` + `listFlowFiles(selftest/fixtures/flow)`（进程内缓存同源）；注释明示「tmpdata 禁止入断言扫描集」。
  - **三处运行态读取移除**（#46 曾硬断言「必须至少一处 match」，排除 erp_demo 后干净 tmpdata 必红；NAS live 绿纯属 tmpdata 恰有归档 flow）：`#18`（schema 全量扫描，`:1928-1941`）、`#44`（零回归哨兵，`:2660-2664`）、`#46`（match 活哨兵，`:2855-2875`）全部改 `assertionFlows()`，标题/文案去 tmpdata；`if (!hits) throw` 保留（靶子恒定 ≥2 处）。
  - **install**：`SELFTEST_EXT` 追加 `.json`/`.md`（覆盖 fixtures/flow + fixtures/README），排除规则不变；manifest **104→106**；`#133④` 断言补两新 fixture 键。
  - **反向验证**：临时移出 sentinel fixture → **425 过 / 4 fail**（#46「零 match 用法」+ #133④ manifest 缺键，哨兵仍活）→ 恢复 → **428/0/0**。
  - **保留**（不误伤）：全部 tmpdata **写入沙箱**用法（`mkdtemp(paths.TMPDATA_DIR,…)` 20+ 处）、源码/路径字符串断言（#19 PRUNE_KEEP 含 tmpdata / gitignore 收录 / VIDEO_DIR 单源）、#101 显式 `CHROMEUSE_TMPDATA_DIR` 注入。
  - **关闭观察项 O26**（#46 依赖 tmpdata 诊断 flow）。
  - **边界**：Windows 副本位需更新代码后重跑 `node install.js`（否则缺 fixtures → #46 + #133④ 红，属预期缺件信号）；装好后干净 tmpdata 全量应 0 fail。

## V20261117013 — 2026-11-17 [doc]

- **本机三项配置实测验收 + ISSUE 栏追加 3 条（Chrome88 截图能力缺口 / LOG_DIR env / 浏览器代理参数）**：Windows 端实测 Chrome（示例ERP 自带 88.0.4324.190）、ffmpeg（winget 9.0.2）、代理（空串+环境变量）三项配置全 PASS；真机暴露 3 项能力缺口入 ISSUE 待 NAS 修。
  - **配置生效证据**：`environment=windows`；binaries `source=config` 且 exists 全 true；`findBrowserExe` abs 直通；`browser-up` **1.2s 拉起**（Chrome/88.0.4324.190，pid/port/ready 正常）→ `targets` 2 个 → 自建页签 `new/eval(1+1=2)/goto(example.com 1034ms complete)/screenshot(140KB jpeg)` 全通 → a11y/css/DOM/probe 四通道抽测全通 → `--stop` 后端口关闭、无残留进程；ffmpeg 版本探活/真实编码解码/luma 空白检测全通；代理空串=无代理、模拟 Clash（大小写两条链）均命中 `127.0.0.1:7897`、config 非空时反压 env（核心假设成立）。现场还原：live `tmpdata` 零写入、仓库 clean、config 零改动（仅 `log/chromeuse.log` 被写入，导出 ISSUE-2）。
  - **ISSUE-1（复杂/bug/中）Chrome88 静默忽略 `captureBeyondViewport`**：实测 beyond true/false 输出 **md5 全同**（`754248ff…`）、视口下 3228 行恒 255 → `scroll-shot` A 路径（`lib/scroll-shot.js:1079-1085`）在 Chrome 88 产出**白屏长图**且 B 兜底不触发（白屏不算失败）。绕行已实测：`--viewport-max-chunk` 或 max-chunk≈视口高（848）；根治建议=运行时能力探测（缓存 tmpdata/state）+ legacy 走 `Emulation.setDeviceMetricsOverride` 撑视口（透明），现代 Chrome 原路径逐字节不变。
  - **ISSUE-2（简单/bug/低）`CHROMEUSE_TMPDATA_DIR` 不覆盖 `LOG_DIR`**：`lib/paths.js:102` 独立于 tmpdata → 测试仍写 live `log/`（7189→9140B）；修复=加 `CHROMEUSE_LOG_DIR` env（默认不变）+ install.md 一句。
  - **ISSUE-3（简单/增强/中）浏览器 `--proxy-server` 缺失（用户裁定 b）**：`browser-launch.js:277-284` 四参数无 proxy；Windows Chrome 不读 `HTTP_PROXY`。用户语义=config 留空、**命令手动加代理参数**；修复=launchArgs 增 `--proxy-server`，优先级 CLI `--proxy` > env `CHROMEUSE_BROWSER_PROXY` > `config.proxy.httpProxy`，三者皆空不加参（现状不变）。
  - **本机清理**：删除 live `bin/ffmpeg`/`bin/ffprobe` 两个 **Linux ELF**（79.8MB×2，`7f 45 4c 46` 实核）——释放 160MB；删除后 `resolveBinaries` 仍 `source=config`+exists（config.bin 绝对路径为唯一真源）、`ffmpegAvailable()=true` 不变。
  - **边界**：仅 TODO.md + CHANGELOG.md + VERSION.md（+ live 运行态清理）；未改 selftest/lib/tools 代码；测试产物保留在 `%TEMP%\cu-test-1118`（含 beyond-*.png/probe-*.js 取证）。

## V20261117012 — 2026-11-17 [doc]

- **TODO ISSUE 栏登记第三轮（1 条）：#46「match 活哨兵」把 tmpdata 运行态当担保源——用户裁定 fixture 化**：Windows 端复验 V20261117010/011 后，二轮 5 项修复全部验证生效（#133/#134/#137/#138④/#139 全绿；warn 13→14 属 #134 设计内），副本位 424 过/14 warn/**仅剩 2 fail=#46 一项**（用例行+组汇总行）。
  - **哨兵本意**（`selftest/main.js:2855-2875`）：`match` 值域白名单是代码常量，若库内无 flow 真用 `match`，白名单改坏也无真实数据踩到 → 假绿；故 `:2874` 活体断言「必须至少一处 match 用法」。动机正确，**错在靶子来源**。
  - **根因链**：扫描集合=`参与集合+tmpdata 全量`（`:2857`）→ 含 match 的只有 erp_demo 两 app 的 4 个 flow（各 7/6 处，实测）→ R4 批按用户裁定 `excludeApp:true` 排除 → 参与集合余 4 flow 全 0 match；tmpdata 段沿袭旧口径（注释自述「R4：webapps 段走参与集合；tmpdata 仍全量」），本机 live tmpdata 仅 1 个 0-match flow → `hits=0` → 红。NAS live 绿=其 tmpdata 恰有批 1 归档的 4 个含 match flow（`tmpdata/flow-archive-20261117144613/`）→ **活体担保隐式依赖运行态**。
  - **扫描源三处定性**（同批核查）：`:1931`（#18）=有则校验空集不 fail ✅；`:2663`（#44）=只要求 length≥1，参与集合恒 4+ 兜底 ✅；`:2857`（#46）=必须命中 match ❌ 唯一把运行态当 fail 充分条件者。
  - **修复（用户裁定=fixture 化）**：①新增 `selftest/fixtures/flow/sentinel-match.flow.json`（最小合法 flow，含 exact/contains 各一处）；②`:2857` 扫描集合改 `参与集合+fixtures/flow`（tmpdata 仅“有则校验”）；③`:1931/:2663` 保留但注释写明「tmpdata 仅 opportunistic，不得作断言存在性来源」；④`selftest/fixtures/README.md` 一句「fixtures=断言靶子非业务 flow」。
  - **⚠️ 需 NAS 复核两点**：①`install.js` manifest 是否覆盖 `selftest/fixtures/flow/*.json`（否则 copy 安装漏装→哨兵失活）；②#46 pass 文案里 `flows.length`/`hits` 数值会变（fixtures 计入），写死数字须同步。
  - **预期**：Windows 副本位 0 fail；NAS 骨架 **428/0/0**、live ALL PASS 不变；反向验证：临时删 fixtures flow → #46 应红（哨兵仍活）。
  - **边界**：仅 TODO.md + CHANGELOG.md + VERSION.md；未改 selftest/install/生产代码；证据=live `webapps/**/*.flow.json` matchCount 实测（0/0/7/6/7/6/0/0）+ 两份 `selftest.config.jsonc` + 三处扫描源源码。

## V20261117011 — 2026-11-17 [feat]

### 批 1：install 分发清单扩容 + live 部署面补齐（live 426/1 warn/33 fail → **435/1 warn/0 fail ALL PASS**）

- **分发缺口根治（五类历史漏装）**：`STATIC_FILES` 追加 `commands.meta.json` + `README.md`；`DIR_RULES` 追加 `scripts:'.js'`（build-help 纳入分发，消除「live 新脚本+旧 meta 误跑 build 降级 SUB_HELP」风险）；`selftest/` walk 放开 `.html/.txt`（fixtures 数据文件）并排除 `tmpdata/`/`.log`/`.bak-*`；manifest **95→101**；`#133④` 守门同批扩展（meta/scripts/fixtures/README）。
- **live 补齐**：install 同步 101 文件 + 删除 4 个已废弃 flow（`diag-liliao`/`open-app`/`sales-order-inventory-lock`/`sales-order-via-search`，备份 `tmpdata/flow-archive-20261117144613/` 含 SHA256SUMS）；残余 2 fail（live 旧 README 计数）随 README 分发清零。
- **归因存档**：live 33 fail = 22（meta 48 旧版，9 组）+ 11（4 个残留 flow → M1 25 条 vs 9 条，4 组）；`live 全量 selftest 非绿` 从此不再是常态。

### 批 2：R4 webapp flow 参与测试配置机制（用户裁定：erp_demo 两 app 即时排除）

- **新 `selftest/flow-policy.js`（145 行，零依赖）**：`readPolicy`（解析+schema 校验，错误聚合不抛）+ `listFlowFiles`（递归 `*.flow.json`，统一排除 `*.local.json`）+ `participatingFlows()/excludedFlows()`（单进程缓存；坏配置 app 保守按全参与，不静默排除）。
- **12 处 flow 枚举全部收敛**（#18/#20/#34/#44×3/#46/#58/#74/#126④/#126⑦/#127⑥/#130①），顺带归一 #126/#127 三处历史 `.local.json` 口径偏差。
- **语义=排除≠删除**：资产层断言恒 8；schema/lint 冻结基线/数量断言改在**参与集合**（= 资产 − 排除，结构式非硬编码）；#74 M1/M2 常量保留全量、断言按参与集过滤（撤销排除自动恢复）；`#130①` 镜像对「任一侧被排除即短路」；`webappModules` 对 excludeApp 跳过其 `selftest.js` 专属断言。
- **防误用三守门**：`reason` 必填 + 配置坏 fail-fast（解析失败/清单与实存不符/excludeApp∪excludeFlows 互斥）+ **凭据禁词扫描仍全量**（`#18b` 扫 `surface.all`，安全红线不可排除）。
- **新 `#140` 组 6 用例**：逐 app schema 聚合/清单一致性/空排除 warn/非法值六态/汇总行重算/源码守门（`lib/`、`tools/` 零引用 `selftest.config`）。
- **实例配置**：`webapps/erp_demo_test|erp_demo_dev/selftest.config.jsonc` → `excludeApp:true` + reason（用户裁定：临时测试库，项目后期整体移除，届时删配置即可）；两 `webapp.md` 各补一行说明（显式 replay 仍可用）。
- **install**：webapps 规则追加 `selftest.config.jsonc`（可选件，存在即分发）；manifest **101→104**（+flow-policy+2 配置）。
- **文档**：SKILL 主干 278/300（webapps 表 +1 行）、install.md 204/260（分发清单）、mechanisms §27（576/580，5 行增量）。
- **验收**：骨架 **428/0/0**（有配置：参与 4/排除 4，M1 3/M2 0/M3 0）；**零配置双向自证 443/0/0**（两配置移出 → 参与 8；与批前基线逐行 diff 仅三类预期差异=文档行数/#18 文案/结果数+#140，其余逐字节一致）；`build-help --check` 49 零漂移；`grep process.platform` 零命中；排除 flow 显式可用（`flow lint` exit 0）；live **427/1 warn/0 fail ALL PASS**（warn=#19 设计内）。
- **边界（下一批候选）**：①直接路径断言未联动排除（#44③/#46/#60/#67-D/#71 仍直读 erp_demo flow，排除状态下改删仍会红）→ 观察区 O25；②`#46` 依赖 tmpdata 诊断 flow（空 `CHROMEUSE_TMPDATA_DIR` 会红，既有脆弱点）→ O26；③Windows 待复验：配置解析/分发路径归一 + erp_demo 排除生效（汇总行纳入 4/排除 4）。

## V20261117010 — 2026-11-17 [fix]

- **Windows 复验 5 项 ISSUE 修复**（V20261117009 上报批实施；改动 100% 在 `selftest/main.js`，`lib/`、`tools/` 生产代码零改动）——NAS selftest **436/0/0 逐字节不变**（改前/改后全量日志 `diff=0`，二次跑同样 0 差异）：
  - **ISSUE-1 fake 浏览器可执行体 Windows 不可 spawn**（#138④ EFTYPE + #139②③ 连锁）：fixture 层 **spawn 垫片两通道**——①#138④ 生成的 runner 源码在 `require(browser-launch)` **之前**（先于 `lib/platform/linux.js:19` 加载期解构捕获）插 win32 `cp.spawn` 包装（`*.js → process.execPath` 引导）；②#139② 写 `win-spawn-shim.js` 经 `NODE_OPTIONS=--require` 预加载（**路径强制正斜杠**——NODE_OPTIONS 解析器把 `\` 当转义；含空格加引号，追加既有 NODE_OPTIONS）。同批 fixture `environment` 参数化（`process.platform==='win32'?'windows':'linux'`）。
  - **ISSUE-2 #133②**：全缺态期望路径 `ffmpeg/ffprobe` 补 `EXT`（win32 `.exe`；Linux `''` 与原字面量逐字节同）。
  - **ISSUE-3 #134②**：Linux `/proc` 正向四断言包 `platform==='linux'` 守卫，else `warn(134, …)`；负向/非法 pid 断言两平台恒跑。
  - **ISSUE-4 #137②**：fixture environment 取物理平台反侧 `OPP`（win32→`linux`，否则 `windows`），三处断言 `includes` 化（免转义）；NAS 侧文案逐字节不变（实跑 grep `environment=windows` 核对通过）。
  - **ISSUE-5 #138②**：非 Linux 注入等价 `fileExists`（POSIX 执行位在 Windows 不可观测）；**同批补 NAS 反证**——`chmod 644` 文件 → `findBrowserExe` 返回 null（Linux 执行位语义仍被覆盖），组级 check 数不变。
  - **验收**：NAS `selftest` 436/0/0 ALL PASS（`diff` 逐字节 0）；`build-help --check` 49 命令零漂移；`grep process.platform`（lib/tools 白名单外）零命中；`git diff --check` 干净；Linux 侧求值核验 23/23 PASS（垫片守卫内/environment='linux'/EXT=''/OPP='windows'/posixAbs=undefined）。
  - **边界**：Windows 端待用户复测（预期 429/13/12 → **441 过/14 warn/0 fail**；唯一新增 warn=#134 非 Linux 跳过）；设计观察（不属本批）：`builtinBin` 按宿主 platform 定 `.exe`、`findBrowserExe` 按 config.environment 选 impl——两者基准不同（文件系统能力 vs 发现规则）语义合理，未改文档。

## V20261117009 — 2026-11-17 [doc]

- **TODO 新增「ISSUE 兼容性」栏二轮（Windows 复验 5 项，修复面 100% 在 selftest/main.js、生产代码零改动）**：主线沿袭（NAS 436/0/0 不可破坏）；Windows 端已按拟议修法端到端实测（探针档案 %TEMP%\cu-research-1117\，不落库）。
  - **背景**：V20261117008 部署 Windows live（28 文件，分批防风暴零挂机，hash 对齐 remaining=0）；live `config.jsonc` Windows 化三修——`environment: linux→windows`（NAS 残留值，平台层按它选 impl，linux 语义在 Windows exe 探测必败）+ 补 `bin` 节（V20261117001 起 #16 实例补键为刻意 fail）+ `chrome` 三键转 active（windows 模板形态）——#16/#102/#110/#111 全转绿；副本位全量 **429 过/13 warn/12 fail**，12 fail 收敛为 5 检查项**全部 selftest fixture 平台适配缺口、生产零缺陷**。
  - **ISSUE-1 fake 浏览器可执行体 Windows 不可 spawn（#138④ EFTYPE + #139②③ 连锁，高）**：fixture fake-chrome.js（shebang+chmod）→ CreateProcess 不认脚本。可执行形态矩阵实测全排除（.cmd 无 shell=EINVAL CVE-2024-27980；.cmd+shell:true=cmd.exe 父 pid+孙进程孤儿+违 #138③ 闸门；改名 .exe=UNKNOWN）。修复=fixture 层 spawn 垫片两通道（#138④ runner 内 require 前插 cp.spawn 包装 .js→node.exe；#139② NODE_OPTIONS `--require` 预加载 shim——**路径必须正斜杠**，反斜杠被解析器吃掉）+ fixture environment 参数化（写死 'linux' 在 Windows 会选 linux impl 致执行位判定必败）。垫片全链已实测 8/8 断言（ensure→state→status→reused→stop→非 Chromium 拒绝 + 真 CLI --auto-launch/browser-up --stop）。
  - **ISSUE-2 #133② 期望路径写死无扩展名**：实现 builtinBin win32 给 `.exe` 是对的（与迁移前 ffmpegBins 同语义）；修复=期望值 `EXT` 参数化（Linux `EXT=''` 逐字节同原文）。
  - **ISSUE-3 #134② Linux /proc 实弹无守卫**：正向四断言包 `platform==='linux'` 门 + WARN（先例 #113）；负向/非法 pid 两平台恒跑。Windows warn 13→14 属预期非回归。
  - **ISSUE-4 #137② fixture 写死 environment='windows'**：warn 只在 ≠物理平台 触发，Windows 实机不触发；修复=取物理平台反侧 `OPP` 插值 + 断言改 includes（免转义）；Linux `OPP='windows'` 文案逐字节同原文。
  - **ISSUE-5 #138② POSIX 执行位断言 Windows 恒 false**（chmod 不改 statSync.mode，实测恒 0o666）：非 Linux 注入 `fileExists` 等价存在性；注册表部分 Windows 实机已全绿不动；建议 NAS 补 chmod 644 反证（执行位语义 Windows 侧不再覆盖）。
  - **预期终态**：Windows 429/13/12 → **441 过/14 warn/0 fail**；NAS **436/0/0 逐字节不变**（全部改动被 win32 守卫或求值等价覆盖）。
  - **边界**：仅 TODO.md + CHANGELOG.md + VERSION.md；未改任何生产代码与 fixture；设计观察一条随附（builtinBin 按宿主 platform 定 .exe vs findBrowserExe 按 config.environment 选 impl，基准不同语义合理，建议 mechanisms 留说明）。

## V20261117008 — 2026-11-17 [feat]

- **批 C2（R2 收官）：`browser-up` 命令接线 + `--auto-launch` 自动拉起 + 计数/文档全套**——selftest 435→**436/0/0**（#139 六用例）；CLI 48→**49 命令**：
  - **`browser-up`**（meta + cmdBrowserUp）：默认 `ensure()`（幂等：已就绪=复用，未起=发现→spawn 常驻→等就绪→state）；`--stop`（组信号→兜底 CDP Browser.close）/`--status`/`--timeout`（500~120000，默认 20s）；`jsonAllowed=false`（放行 13 不变，E_USAGE 拒绝面）；与 `browser-restart` 双向指针（up=OS 级拉起 / restart=CDP 级重启，后者依赖容器 keep-alive）。
  - **`--auto-launch` 全局保障**：顶层 pre-parse（位置无关）+ 分发前保障块（parseArgs 后、case 前）——仅 `browserUrl` 主机为 `127.0.0.1/localhost` 才幂等 ensure；非本地一行 warn 跳过（防误启本地实例连远端）；`browser-up` 自身不重复触发；与 `--config` 天然组合。
  - **联动**：GQ-004 连接失败 hint 追加「可运行 browser-up（或 --auto-launch）」（config chrome 三键齐备时）；`manualRestartHint` 第二行加 browser-up 指针（#135② 逐字节断言同批更新）。
  - **计数对账（C8 铁律全套）**：`build-help` 三产物重投影（49）；`#98`（拒绝 36+browser-up=49）、`#116④`（放行 13 不变）、`#128⑤`（49=13+36、§8.2、README×2）、`#129④`/`#16012`/`#96 main-help` 基线、mechanisms §8.2（36=49−13）+§25+§26。
  - **文档/模板**：chrome 三键注释补 browser-up 用法/Chromium 内核范围/userDataDir 独立非默认；install.md（Windows Start-Process 段与裸机 Linux 段）；SKILL §0.4 指针；playbook「本地调试实例拉起」节（591/600）；mechanisms §26 launch 机制（571/580）。
  - **#139 六用例**：meta/SUB_HELP/helpMain 双端同源+49 命令+--help；`--auto-launch` fake 实链（拉起→targets 成功→state→复用）；`--stop` 实链（进程消失+state 清理）；非本地跳过+warn；无 chrome 三键明确报错；源码锚点（pre-parse/保障块/case/文案联动）。
  - **边界**：Windows 真机待复验（App Paths `reg query` 实际输出/Edge·Brave/真机 spawn 常驻/--stop/--auto-launch）；本容器全程 fake exe（Node HTTP 同时响应 `/json/version`+`/json/list`），未启真浏览器。

## V20261117007 — 2026-11-17 [feat]

- **批 C1：R2 平台层 + 浏览器启动核心**——selftest 434→**435/0/0**（#138 六用例；#135① 覆写清单适配）：
  - **browser 契约 +3 方法**（共 7）：`findBrowserExe` / `spawnBrowser` / `launchArgs`。
  - **Linux 基准**：`findBrowserExe` 绝对路径→PATH 遍历→12 条固定目录表（google-chrome/chromium/snap/edge/brave/opt 系）；`launchArgs` 最小集（`--remote-debugging-port`/`--user-data-dir`/`--no-first-run`/`--no-default-browser-check`）；`spawnBrowser` = `spawn(detached, stdio:ignore, windowsHide, shell:false)` → `{pid,child}`（unref 归调用方）。
  - **Windows 覆写 findBrowserExe**：绝对直通→**App Paths 注册表**（HKCU→HKLM `reg query /ve`，3s 静默）→安装目录表（`%ProgramFiles%`/`%ProgramFiles(x86)%`/`%LOCALAPPDATA%` × Chrome/Edge/Brave/Chromium）→PATH；注册表输出解析/目录表抽纯函数可注入；OVERRIDES 追加第 3 项。
  - **`lib/browser-launch.js`（311 行，平台无关编排、零 `process.platform`）**：`validateChromeConfig`（三键齐备/Firefox·Safari 前置拒绝/端口范围/userDataDir 非空且 basename≠`User Data`）+ `isReady`（`/json/version`）+ `portMismatchWarning`（debugPort≠browserUrl 端口一行 warn）+ `ensure`（幂等 reused→发现→launchArgs→spawn+unref→20s/500ms 轮询→`Chrome/` 标识校验→原子写 state）+ `stop`（state.pid 组信号→2s→SIGKILL→CDP Browser.close 兜底）+ `status`。
  - **paths/quota**：`BROWSER_DIR`/`LAUNCH_STATE_FILE` 单源登记；quota 归 other 不自动删（#102 目录计数 17→18 机械适配）。
  - **#138 六用例**：契约七方法+覆写清单 3 项+委托；findBrowserExe 注入直测（Linux abs/PATH/表；Windows App Paths/表/PATH+reg fixture）；launchArgs 精确+spawn 安全锚点；**fake exe 全链实弹**（Node 假 `/json/version`：ensure→state→status→reused→stop→进程消失+state 清理，不启真浏览器）；拒绝面（Firefox/Safari/`User Data`/三键缺失/非 Chromium 就绪）；源码锚点。
  - **边界**：批 C2 待做（`browser-up` 命令 48→49 + `--auto-launch`/`--stop` + 文档/计数）；Windows 真机待复验（App Paths 实际输出/目录表/真机 spawn/Edge·Brave 的 Browser 字段）。

## V20261117006 — 2026-11-17 [feat]

- **批 B：R3 动态配置文件 `--config <path>` + platform 层惰性化**——selftest 433→**434/0/0**（#137 六用例）：
  - **`lib/config.js`（52→83 行）**：`setConfigPath(p)`（相对→`path.resolve(cwd,p)`；设后试读：不存在/schemaVersion 缺/坏 JSONC → throw 由入口 die）/`configPath()`/`resetConfigPath()`；`loadConfig()` 签名不变（9 调用点零改动）；新增 `CHROMEUSE_CONFIG_PATH` env——`--config` 从 argv 剥离后 jobs `--async` 子进程仍沿用同一实例（实链验证）。
  - **`lib/platform/index.js` 惰性化**：`detectPlatform/assertImpl/冻结门面/日志` 从模块加载期推迟到**首次调用**（闭包缓存单例，导出形态不变）；`config.environment` 与物理平台不一致 → 一行 warn（`echo:true`，合法跨平台测试用法不阻断）。
  - **`tools/cdp.js` 顶部 pre-parse**：在**第一个 lib require 之前**识别 `--config <path>`/`--config=<path>`，命中即 `setConfigPath` + `argv.splice` 剥离；缺值/不存在/坏文件 → 内联 stderr+exit 1 文案；全局选项帮助行增 `--config <path>`。
  - **文档扩限（用户 2026-11-17 批准）**：mechanisms 新增 §25（565/580）、playbook 新增临时 config 实例节（581/600）、SKILL §0.3 一行、install.md「多环境切换」节；selftest 6 处预算断言 555→580/575→600；`#96 main-help` 基线更新（帮助面有意变更 outLen 12399→12499）。
  - **#137 六用例**：config 三态单元/子进程实链（browserUrl=19999 生效+platform=windows 日志+物理不一致 warn 回显）/fail-fast 三形态（不存在/坏/缺值）/flag 两位置与等号形态且剥离不污染命令解析/平台惰性化探针（require 零构建→首次构建→单例缓存→冻结）/install.js 部署域边界+pre-parse 时序锚点（iPre < iPlatformReq < iRedactEnable < iRawArgv）。
  - **边界**：批 C1/C2（R2 browser-up）待做；Windows 待复验 `--config` 临时实例/相对路径 cwd 基准/`--config=` 形态；无 `--config` 时行为逐字节不变（冒烟 targets 默认 chrome-browser:9224 照旧）。

## V20261117005 — 2026-11-17 [feat]

- **批 A：R1 ffmpeg 配置化（用户参考实现落地；不做 PATH 探测）**——selftest 保持 **433/0/0**（#133②/⑤ 适配升级；#16 实例补键后转绿）：
  - **模板 bin 节 active 默认值**：linux `bin/ffmpeg`+`bin/ffprobe`、windows `bin\ffmpeg.exe`+`bin\ffprobe.exe`（相对=skill 根基准、与 cwd 无关；已安装别处改绝对路径如 `C:\ffmpeg\bin\ffmpeg.exe`；注释与 install.md 同步）。
  - **相对路径解析**：`explicitPath(v,key,baseDir)` 绝对原样/相对 `path.resolve(SKILL_ROOT,p)`（info 日志）/空值忽略；`resolveBinaries` 增 `opts.skillRoot` 注入；source 枚举不扩（相对/绝对均 `config`）；**不做 PATH/系统 ffmpeg 回退**（2026-10-28 裁定维持，hint 原句保留）。
  - **selftest**：#133⑤ 从「两模板深度相等」升级为「键集合相等+各模板值精确断言」（更严）+ 相对默认值解析到注入 skillRoot；#133② 新增相对路径/`../x` 越界 resolve/绝对直通/空值忽略用例。
  - **#16 门处理（计划外）**：模板 active 键必须存在于机器实例——骨架与 live `config.jsonc` 各纯增量补 bin 节（live 先备份 `config.jsonc.bak-20261117114104`，sha256 留证=修改前版本）；实例 `resolve()` source 由 builtin→config、路径与内置探测完全一致（行为等价）。
  - **边界**：批B（R3 `--config`）/C1/C2（R2 `browser-up`）/D 待做；Windows 实例升级后 #16 会提示补 bin 键（指引已落 install.md）。

## V20261117004 — 2026-11-17 [feat]

- **平台适配分层批 3（收官）：paths 归一 + lint 禁令 + 文档三件**——selftest 432→**433/0/0**（#136 五用例）：
  - **`lib/paths.js`**：新增 `toPosix(p, sep?)`（平台原生分隔符→`/`，POSIX 恒等；`sep` 仅供 selftest 注入 `path.win32.sep` mock，生产默认 `path.sep`）+ `toPosixRel(root, abs)`；JSDoc 明确「展示/跨平台键归一，不改文件系统语义」。收敛 `audit.js:88`、`quota.js:227`；`quota.js:152`（语义分段）/`evidence.js:250`（展示拼接）按边界不动。
  - **文档**：`SKILL.md §0.4 平台层规则`（5 行：单实现原则/四类平台能力走 platform/新契约 Linux 优先+OVERRIDES/禁令与豁免，主干 274/300）；`mechanisms §24`（三域/委托链/已迁移面/lint 白名单，554/555）；`playbook` 新功能指针（574/575）。
  - **#136 lint 禁令**：扫描 `lib/**`（目录级排除 `lib/platform/`）+`tools/*.js` 零裸 `process.platform`（含扫描面健康断言）；白名单**非空转**（platform/linux.js/index.js 命中在位）；豁免语义（install.js/selftest 不入扫描面）；paths 行为（POSIX 恒等 + `path.win32` 语义 mock 归一 + 两处转调锚点）；文档三锚点。
  - **平台分层全链完成度**：三域全覆盖（binaries 单实现、process 4 覆写、browser 2 覆写）；#133~#136 四组连续守门；`lib/`+`tools/` 平台字面量清零（白名单仅 platform/ 自身）。
  - **边界**：Windows 真机复验并入人工区 Windows 复测捆流程⑤（#132~#136 全量 + ffmpeg.exe 解析/转码 + /proc 恒 null/单 pid + NAS 提示文案 + beacon 127.0.0.1 + `--init-config auto` + toPosix 反斜杠归一）；未纳入=install.js（部署域自治）/browser-restart 静态双环境文案/evidence:250 展示拼接；**预算告警**：mechanisms 554/555、playbook 574/575 均余 1 行——后续加行须同批扩预算（mdrefactor）。
  - 附：批1 观察 flake 续记——#117 首跑一次 fail（live 共享浏览器视口 550 vs 595），二跑全绿，非平台层路径。

## V20261117003 — 2026-11-17 [feat]

- **平台适配分层批 2：browser 域 service 双 impl**——selftest 431→**432/0/0**（#135 五用例；#94③ 断言增强）：
  - **browser 四方法**：`defaultBrowserUrl`（127.0.0.1:9222）/`nasServiceHint`（NAS 服务名误配提示）/`beaconBase`（录制 beacon 基址）/`manualRestartHint`（冻结恢复命令）。Linux 基准；Windows 覆写 `nasServiceHint`（`--init-config windows` 文案）+`beaconBase`（`127.0.0.1:<port>`）；`defaultBrowserUrl`/`manualRestartHint` 零覆写继承（两平台同值）。
  - **调用面收敛**：`cdp-core.nasBrowserUrlHint` **删 platform 形参**（保留忽略参数会让 `'win32'` 实参静默返回 Linux 文案=假绿通道；3 调用点全改）+ `resolveBrowserUrl` 默认值走 provider + `record.beaconBaseFor` 删 `config.environment==='windows'` 判断（`--beacon-url` 优先级原样）+ `tools/cdp.js` 两处 `process.platform` 实参删除 + `printFreezeReport` 两行走 provider。
  - **文案逐字节等价**：`manualRestartHint` 保留原始 9 空格缩进（`console.error` 直出不变）；对 HEAD 旧源码字节比对 identical；#96/#94/#135 三重守 byte 级。`isNasServiceBrowserUrl` 纯函数迁平台层单源（cdp-core re-export 保 API 稳定）。
  - **边界**：批3 剩余（paths 归一 helper+SKILL/mechanisms/playbook+lint 禁令）；`browser-restart` 兜底文案平台中立（同时给 Windows/NAS 指引）**未纳入**（保留原位）；观察=#117 首跑一次 fail（live 共享浏览器视口 550 vs 595 硬编码 17 行），二跑全绿、非本批代码路径（grid/extract 与 browser 域无交集）。

## V20261117002 — 2026-11-17 [feat]

- **平台适配分层批 1：process 域 service 双 impl**——selftest 430→**431/0/0**（#134 五用例；#133① 覆写断言升级为细粒度）：
  - **`lib/platform/linux.js`**：新增 process 五方法 `procState/procCmdline/procStartMs/alive/signalProcessGroup`，从 `lib/jobs.js:171-214/515-523` 原样迁入（EPERM=存活/僵尸 Z=死/USER_HZ=100 偏差注记全保留）；`alive()` 内互调 **`this.procState()`**——Windows 覆写后经原型链自动命中。
  - **`lib/platform/windows.js`**：四方法覆写（三探针恒 null=无 /proc；`signalProcessGroup` 单 pid kill 'pid'/null）；`alive` 不覆写（继承 Linux，`null !== 'Z'` = 迁移前 win32 行为逐字等价）。覆写用 `Object.create(属性描述符)`——Linux 方法表已 freeze，原型同名属性不可写，赋值会被 [[Set]] 拦下抛 TypeError（实现细节已注记）。
  - **`lib/jobs.js` 调用面**：4 处 `process.platform`（:173/:192/:200/:517）清零，`readProc*`/`processAlive`/`signalProcessGroup` 转调 `platform().process.*`；导出名/签名/行为不变（record/cast/cdp 复用零感知）。
  - **断言**：`#133①` 适配契约域清单 `['binaries','process']` + 覆写清单细粒度 `domain.method` ↔ 自有属性逐项一致（未覆写须原型委托 `===` linux、覆写须 `!==`）；新增 **#134 五用例**：契约/委托链/覆写清单、Linux 实弹等价（当前 pid 状态/argv/startMs/alive + 不存在与非法 pid 安全降级）、Windows 覆写行为（禁真 kill）、源码锚点（jobs 零平台字面量+转调形态/windows `Object.create`/`this.procState`）、jobs 导出面与 platform 同源。
  - **边界**：批2 browser（cdp-core:73/116、record:101、cdp:460/4657/1404）待做；**#132④ 锚点经核实无需改动**（上游误判：该锚点读 selftest 自身 #113 测试层守卫，与 jobs.js 迁移无关，改动反而破坏防回归）；Windows 真机待复验（jobs cancel 单 pid 路径/覆写域 require 单测已覆盖，真机复跑 selftest）。

## V20261117001 — 2026-11-17 [feat]

- **平台适配分层批 0（B 方案首批：2 service + 1 provider）**——用户 2026-11-16 拍板 B 方案（否决 48 命令域全量=约 45 个空壳+5000 行样板；选 3 域分层），2026-11-17 开工；selftest 429→**430/0/0**（#133 六用例）：
  - **`lib/platform/` 四件套**：`contract`（Object.freeze 键集+加载期 assertImpl fail-fast）/`linux`（基准 impl，Object.freeze 方法表）/`windows`（`Object.create(linux.impl)` 原型委托+OVERRIDES 声明，批0 零覆写）/`index`（单例门面+`detectPlatform` 纯函数：config.environment 显式 > process.platform 兜底；config 读取失败容错回落；加载期一行日志 platform=… 覆写清单）。
  - **binaries 探测 provider（用户 bin 裁定落地）**：解析序 `config.bin.ffmpegPath/ffprobePath`（绝对路径）> 内置 `bin/`（保留 .exe 探测供 Windows 用户自行放置）> none+hint（下载地址/放置路径/config 键/不回落 PATH 声明）；`probeVersion` 真探活 5s+进程级缓存；**不做 PATH 回退**（2026-10-28「bin/ 单点真源」裁定维持）。
  - **三处硬拼收口**：`screenshot.js:506`（png 转码）/`tools/cdp.js:2011`（ffprobe 时长探针）/`:2060`（帧合成）——Windows 上原静默降级改为 hint 指引；`scroll-shot` ffmpegBins/ffmpegAvailable/probeImage 改走 provider（cast.js 复用零改动）。
  - **install 两修复**：`PRUNE_KEEP` 追加 `/^bin\//`（用户自放 ffmpeg.exe 不被 `--prune` 误删）；`--check` 单列 bin/ ℹ 不参与 drift；**`buildManifest` 补 `lib/platform/*.js`**（DIR_RULES 只扫 lib/ 单层，否则 copy 安装漏装平台层、Windows 桌面端必崩）。
  - **双 config 模板 bin 节**：active `"bin": {}` + 注释示例（ffmpegPath/ffprobePath、下载地址、解析序、不回落 PATH）；schemaVersion 维持 3（空节无结构破坏）。
  - **#133 六用例**：契约覆盖+覆写清单===OVERRIDES+委托同一性/冻结/缺键抛错；binaries 三态解析序注入纯函数（config>builtin(.exe)>none+hint+partial）；三处硬拼源码锚点+lib/tools 全仓扫描零残留；install 四锚点；双模板 JSONC 合法；平台判定纯函数+实际单例一致性+容错锚点。
  - **边界与下批**：批1 process/jobs（/proc 三探针+alive+signalProcessGroup）、批2 browser、批3 paths+lint 待做；Windows 侧待复验（.exe 探测/config.bin 采信/hint 呈现/--init-config windows）；观察=#126/#127 实弹 fixture 4 跑 1 次瞬时失败（既有环境 flake、不涉平台层，终验全绿）。

## V20261116002 — 2026-11-16 [fix]

- **Windows 兼容性三 ISSUE 修复批（V20261116001 上报定稿方案→NAS 实施；用户裁定主线=POSIX 零回归、NAS 基线不可破坏）**——selftest 428→**429/0/0**（#132 组四用例；全部改动集中 selftest/main.js，lib/tools 零改动）：
  - **#126/#130/#102 分隔符族（同一根因）**：四处 `path.relative` 结果追加 `.split(path.sep).join('/')` 归一（现 :17990/:19241/:12373/:12407）——win32 反斜杠键归一 POSIX 字面量；**两处假绿恢复真覆盖**（#102 ② names、#130 被删流 endsWith 否定断言原 Windows 恒 false=空转，归一后真断言）；POSIX 恒等不变式（sep==='/' 时 split/join 恒等）→ 三组原断言零行为变化。
  - **#19 gitRoot 布局判据**：新增 `SKILL_REPO_REL` 常量单源（560-562 长字面量收口，fail/pass 文案最终字符串不变）+gitRoot 命中后布局前缀校验——不匹配 → `warn(19,'SKIP …（非本仓骨架位：gitRoot=… rel=…）')`（原 FAIL 降 WARN=目标场景）；**NAS 旧布局复核=无旧布局检出**（全盘 find 仅骨架位 1 处；live 位向上无 .git 仍 SKIP），采用单值判据无需白名单。
  - **#113 /proc 探针守卫**：argv 实弹校验外包 `process.platform !== 'linux'` 守卫（非 Linux → warn，else 原三行逐字符不变）；`lib/jobs.js` 零改动（生产侧 `cmdlineHasJobId:null`「平台不可验证不误判」语义已是安全设计）。
  - **#132 组断言**：win32 relative 反斜杠→归一等价 posix 逐字符/POSIX 恒等不变式/三组实际断言形态 win32 复刻转绿（含 #130 非假绿双断言）/源码锚点防回归。
  - **待 Windows 端复验**（已并入 Windows 桌面端复测批流程⑤）：预期 #126 8/8、#130 6/6、#102 8/8 转绿；#19 FAIL→WARN（文案带 gitRoot/rel）；#113 1/7→0/7+1 WARN；副本位总预期由 422 过/11 warn/9 fail → ALL PASS；若复验异常重开 ISSUE。

## V20261116001 — 2026-11-16 [doc]

- **TODO 新增「ISSUE 跨环境兼容性」栏（Windows 端复验上报 3 条，含可直接实施的伪 diff 与 POSIX 零回归论证）**：主线=兼容性修改、NAS 426/0/0 基线不可破坏（2026-11-16 用户裁定）；`lib/`、`tools/` 零改动，全部修复点在 `selftest/main.js` 五处。
  - **背景**：chromeuse V20261031017→V20261113013 部署 Windows live（防风暴分批 35+31 文件、rescan 峰值 24、全程零挂机）+ live `config.jsonc` 升 schemaVersion 1→3（补 tabs/quota/redact 三节，现值未动）；`%TEMP%` 副本位全量 selftest **422 过/11 warn/9 fail**，9 fail 收敛为 5 检查项**全部 Windows 平台差异、零部署缺陷**（#16/#110/#111 已由 config 升级消除，不计入）。
  - **ISSUE-1 分隔符断言族（#126/#130/#102 各 1 用例，同一根因四处改点）**：`path.relative` win32 产出 `\` vs 写死 POSIX 字面量——:17979（清单冻结键，数值 6/3/6/3 全对仅键形不符）、:19230（保留流 includes 恒 false；dev/test 镜像逐字节一致已 hash 核实）、:12400（quota 淘汰 includes 恒 false；淘汰行为实证完全正确：4 候选全删/over-quota/evidence·flow-fail 零误删）；附带修复两处**假绿**（:19232 被删-flow endsWith、:12366 names——Windows 恒 false 否定断言=空转）。修复=各 1 行 `.split(path.sep).join('/')`（POSIX 恒等变换；#126 键序不受影响机理=绝对路径 sort 共享前缀下 `\`(0x5C)/`/`(0x2F) 不改变相对先后，本机 verify.js 实证 old=false→new=true）。
  - **ISSUE-2 #19 gitRoot 布局判据（Windows 主目录 dotfiles 仓误判）**：向上找第一个 `.git`=本仓根的假设在 Windows 失效（本机 `C:\Users\i8983\.git` 存在且无 .gitignore，副本/live 位必命中→FAIL）。修复 C-1=gitRoot 命中后再验 `rel===骨架位常量`（顺带收口 560-562 字面量单源），否则 WARN SKIP；不推荐 C-2（吞真问题）。⚠️需 NAS 复核：旧布局检出（v4 前 rel）会由可能 PASS 变 WARN（pass 数 -1，0 fail 不受影响），如需覆盖改白名单二选一。
  - **ISSUE-3 #113 `/proc` 探针缺平台守卫**：`lib/jobs.js:192` 非 linux 硬返 null（安全设计），但用例 `|| []` 把「不可验证」当「空 argv」误报 fail（`--job-id` 实际存在且无条件追加，:416）。修复 D-1=12690 加 `process.platform!=='linux'` 守卫+WARN（先例 #112 ③），else 分支三行 eq 原样；不推荐 D-2（wmic 已移除/Get-CimInstance 阻塞 sweep/动生产面违主线）。
  - **NAS 零回归汇总**：三项在 Linux 下均为恒等变换或纯增分支（骨架位 rel 严格相等实测、守卫条件恒 false 走原路径）；预期 Windows 副本位 422→ALL PASS（warn 11→13 左右）、NAS 426/0/0 逐项不变。
  - **边界**：仅 TODO.md + CHANGELOG.md + VERSION.md；Windows 端实证材料=%TEMP%\cu-research-1116\{probe.js,verify.js}（不落库）；未改任何生产代码；未跑 NAS 侧验证。

## V20261113013 — 2026-11-13 [fix]

- **popup-guard matchRule 单 entry AND 语义修复（V20261113011 缺陷闭环）**——selftest 427→**428/0/0**（#131 五用例）：
  - **修复**：`PAGE_UTIL.matchRule` 删除 selector/textContains 短路 `return true`，改条件计数全真判定——单 entry 内已给键（selector/textContains/rect/zIndexMin）全部成立才命中（与头注释宣称语义对齐，方向=实现对齐注释）；`anyOf` entry 间仍 OR；rect+zIndexMin 原 AND 保留；非法 selector 记该条件不成立（保守不回退文本/尺寸命中）。
  - **零行为变化实证**：现网三规则库（global/jd/taobao 12 条 16 entry）全单条件（multi=[] 普查）；scan 改前/改后逐字节 sha256 零差异（taobao 8 hits/tmall 8 hits/jd 0 hits 三页一致）；探针 `{textContains+rect}` 修复前命中 202×17 负样本（缺陷复现）→修复后仅正样本（AND 正确）。
  - **规则文件头注释同步改写**（编排方同批）：authoring 语义段从「⚠ 旧缺陷描述」改为「✅ AND 语义+历史注记」——新规则可直接写复合约束，旧单 selector 写法保留有效无需回改。
  - #131 五用例：红包探针正反/四条件逐否决/anyOf 仍 OR/现网 12 条单条件回归/非法 selector 保守。

## V20261113012 — 2026-11-13 [feat]

- **示例ERP flow 整编批：业务统一后只留两流+新引擎兼容实弹+eval redact（用户 2026-11-13 裁定）**——selftest 426→**427/0/0**（#130 六用例）：
  - **flow 整编（用户裁定：业务已统一为库存锁定，只用现货锁定测试）**：测试库删 diag-liliao/sales-order-inventory-lock/sales-order-via-search，保留 sales-delivery-extract/sales-order-spot-lock；dev 删 open-app+复制两保留流（逐字节一致）；两 webapp.md 订正现货锁定表述+旧 flow 删除说明；领料锁定历史文案注明「功能已统一」。
  - **新引擎兼容改造+实弹**：spot-lock 27→30 步（改密模态防御+树项/菜单项 strictTag+搜索 retry）**30/30 两连过+cast 伴录**（mp4 双轮 1.5MB+json 清单，`webapps/erp_demo_test/tmpdata/evidence/`）；delivery-extract 38→41 步改造段 **31/31 全过**，步骤 32 被**测试库空数据**阻塞（销售送货单 0 条业务红，非兼容问题；待补数据可直接重跑，边界已入 webapp.md 已知坑）。
  - **lint 基线下降**（修复可缩减条款兑现）：28 步/M1 22→**18 步/8 flow·M1 9·M2 0**（delivery 测试库+dev 镜像各 3 条 M1，spot-lock 0）。
  - **eval redact A+C（用户裁定顺手清）**：eval 返回值进 completedSteps/失败报告前过 §16 `redact.text()`（vars 保持原值）；M7 lint 扫描 eval/cond.when.expr 敏感关键词 advisory；#130③b fake-CDP 实链断言（`<redacted:…>` 且不含原值）+源码断言 vars 原值；mechanisms §22 补声明。
  - **积压改动收编**：`webapps/chatgpt/flows/gpt-single-chat.flow.json` +5 行（另一会话现场修复：type→发送 1.2s 状态缓冲，156 版 type 后立刻 click 被吞实证）——内容核对合理一并入库，其 M1 步号偏移已在 #74 基线适配。
  - **cast 并发纪律沉淀**（playbook）：cast 伴跑 replay 须 `--no-foreground`（默认前台保障与 replay 并发会吞点击/焦点超时实证；cast 自然到时才落 mp4）。
  - 遗留：delivery-extract 两连过待测试库补送货单数据；`webapps/erp_demo_test/selftest.js` 随流删除改造（webapp 级）；tools/cdp.js flow lint 静态总结行 M7 未列（边界外小项）。

## V20261113011 — 2026-11-13 [fix]

- **淘宝/天猫红包类弹窗规则补充（用户顺手指令：3 条规则不覆盖「450 元红包」弹窗，popup-guard scan 命中 0 条）**——规则库 6→12 条（taobao/tmall 成对 3 类新增）：
  - `redpacket-layer`（remove）：`[class*='redPacketReminder']`/`[class*='redPacketPopup']` 红包卡片本体；`redpacket-mask`（remove）：`[class*='popMask']:has([class*='redPacket'])` 仅含红包节点时整层移除（高精度防误伤 coupon/myBenefit）；`pop-dynamic-mask`（hide 兜底）：空/换皮遮罩清空（保留 DOM 供 data-cu-pg-hidden 误杀排查）。
  - **验证（L1 实录+fixture）**：真实已登录淘宝首页 4951 节点（含 12 个「红包」叶子文本）负样本 scan **命中 0**；合成 fixture（真实类名+alicdn `tbpc-pop-dynamic-common@1.0.44` CSS 1:1 复刻）三 rect 与 2026-11-13 实录完全一致+视觉确认；dry-run 观察期注入命中 12 条；`popup-guard on` 真动作弹窗消失零残留；12/12 归一 0 issue。
  - **边界如实**：弹窗为一次性提醒不可自然复现（证据=实录 DOM 复刻 fixture+动态注入）；tmall 3 条为同组件库类名推定（无 tmall 实弹录像）；旧规则双闸不命中根因已记 webapp.md（DOM 特征/规则 id/last-verified 2026-11-13，53→58 行）。
  - **⚠ schema 真缺陷发现（未修，登记待办）**：lib/popup-guard.js 头注释宣称「同 entry 多条件=AND」，实际 selector/textContains 各自短路 return true（仅 rect+zIndexMin 真 AND）——复合规则会退化为纯文本匹配误杀整页（探针实证：文本+rect AND 语义应 0 命中实际高 202/17 命中）。本次规则已绕开复合写法；修复（实现 AND 或注释如实化）+主 selftest 断言=批 8 收口后小批处置。

## V20261113010 — 2026-11-13 [feat]

- **九条目实施链批 7（终批）：C1 命名会话+页签租约（条目闭环；用户裁定「现在做完」）+全链收官对账**——selftest 425→**426/0/0**（#129 四用例）：
  - **tab-govern CAS→租约协议**：注册表条目可选租约字段（owner/expiresAt/heartbeatAt/leaseMs，schema v2 旧条目兼容）；`new` 发租+`resolveTarget` touch 心跳续租（15s 节流）；planReclaim 联动（他方活跃租约保留+过期清成无主按空闲阈值回收）；**`close` 他方活跃租约诚实红 E_BUSY 零关闭**；`targets` 非缺省 owner 标 `[cu:<owner>]`；命名入口=env/config `CHROMEUSE_TABS_OWNER`/`CHROMEUSE_TABS_LEASE_MS`（默认 local/30min）。
  - **单用户零感知**：默认路径与现状逐字节一致（stdout 单行无租约噪声断言）；零新命令零新旗标（--check 48 命令零漂移）。
  - 边界：不做跨命令互斥（同一页签多 owner 并发 click 交叉靠调用侧纪律，本批只兜租约归属+回收/close 破坏面）；心跳零命令空闲自然过期；注册表 v2 回滚会丢租约字段（留意）。
  - **全链收官（V20261113003~010 共 8 commit）**：oracle 七批计划→fixer 串行实施→编排方逐批亲验收口；selftest 416→**426/0/0**；CLI 47→**48 命令/13 放行面**；九条目（C1/C2/C4/C5'/C6/C7/C8/C9+录制定位链）全部闭环；**O16 关闭**（其触发后动作「页签租约」=本批落地）；过程升级 3 起均妥善处置（批 5b 计数订正边界授权/auto-wait 复核否决/批 7 用户裁定从搁置改做完）。
  - **全链遗留尾件**（不阻塞）：①29 步存量 flow uniqueDefault 影响清单冻结（tmpdata/impl-b5a/unique-inventory.json，实弹修复随 ERP/实录机会另行编排）②eval 敏感值落盘是否 v2 加 redact 待裁定（mechanisms §22 已注意）③8 真实流 live replay 全量未做（ERP frp 平时关/写流红线，fake-CDP 10/10+fixture 两连过替代证据）。

## V20261113009 — 2026-11-13 [feat]

- **九条目实施链批 6：C2 人机接力 handoff 协议（条目闭环；本链唯一新增命令 47→48）**——selftest 424→**425/0/0**（#128 六子面；oracle 前置设计四项偏差编排方批准：两段式/无 done 动作/touch 信号文件/jsonAllowed=true）：
  - **新命令 `handoff` 四形态**（单命令×旗标：默认 start 落盘即返输出醒目横幅 / `--wait <id>` 可选进程内阻塞 2s 轮询信号文件 / `--status [<id>]` / `--cancel <id>`）——**混合两段式**（纯阻塞会把 HUMAN REQUIRED 横幅困在进程里=协议失效；--wait 即用户「后台 shell 轮询自转」裁定的 CLI 产品化）。
  - **状态机**：`waiting→confirmed(touch 信号)/expired(deadline)/cancelled`；活跃判据=state∧deadline 双字段读者侧即时判定（滞留自愈）；原子写+24h 惰性清扫+终态不可逆（新 lib/handoff.js 356 行，jobs 先例全抄）。
  - **协议可靠性**：jsonAllowed=true 第 13 放行（touch 路径必须机器可靠提取——错路径=协议死锁，中文横幅不宜 parse）；三计数六项联动（#98 48/#116④ 13 放行·拒绝面 35 不变/mechanisms §8.1·8.2/JSON_COMMANDS/README×2/SKILL L87 手写引导行 12→13）。
  - **页签与留证**：tab-govern busy 豁免补 deadline 判定（修滞留 waiting 永久堵死回收缺口）+永不置前+超时保留+报告；前后截图 fail-soft 2s；audit 四 action（created/confirmed/expired/cancelled）；challenge 阻断文案衔接 handoff 指引（批 3 预留兑现）。
  - **实弹**：真实浏览器接力两连过（start→touch→wait exit 0→confirmed）+超时红两连过（E_TIMEOUT/expired）；审计 4/2/2 实录；mechanisms §23（548/555）+playbook 3 行（572/575 含后台轮询时序）。
  - 边界如实：§号偏差（设计写 §20 实落 §23=5a/5b 占号）；终态截图 status 惰性路径无 CDP 上下文记 null；罕见并发双记审计未加跨进程锁（单 agent 无竞态）。

## V20261113008 — 2026-11-13 [feat]

- **九条目实施链批 5b：C5' flow 表达力 V2（条目全闭环=C5' 终批）**——selftest 423→**424/0/0**（#127 八子组）：
  - **四新原语**：`eval`（只读沙箱：静态拒绝 process/require/fs/eval()/Function()/import()；3s 缺省/10s 上限预算；E_POLICY_DENIED/EVAL_TIMEOUT/EVAL_FAILED）+`set`/`eval.var`/`loop.indexVar` 变量赋值（插值改步骤执行时——存量静态变量等价；分支未覆盖消费 VAR_MISSING 诚实红）+`cond` 跳步（when 条件+jump label/skip；label 唯一/禁跳入循环体）+`loop` 受控循环（times/over+itemVar；**全 flow 共享 50 次硬上限** LOOP_LIMIT_EXCEEDED）。
  - **原语计数口径单源化**（编排方授权补边界）：引擎文案改 ACTIONS.length 派生+mechanisms §22 唯一真源+selftest 派生断言；README 13/meta 12/playbook 14→**18**+build 重生成（#96 flow-help 1755→1830 同批）。
  - **auto-wait 复核定案：不做留 V3**（fixer 复核+编排方批准）——M1 lint 已强制操作步前置闸门+click.gate 已有；轻量等待会改全部操作步失败时延+掩盖「目标不存在」真红即时性。
  - 存量回归：10 flow schema/lint 冻结零回归+**fake-CDP 全流执行 10/10 ok**；本地 fixture「点击→读值→变量→分支→循环×3」两连过；jd 只读真实 CDP 抽样 6 步正常（第 7 步收单断言=站点行为漂移诚实红，deepInteract 命中链证明非回归）；ERP 5 流 frp 平时关闭/chatgpt 写流红线未全量 live（如实）。
  - 边界外 3 处申报消费面（tools/cdp.js done 进度/summary.completed/完成行改 stepsDone——不修则循环流显示错误进度）已接受；eval 敏感值落盘注意已入 §22；mechanisms 预算随批提 535→**555**（536/555）。
  - **C5' 条目终态**：闸门族（批 5a nth/uniqueDefault/细分码/aria name）+表达力 V2（本批）+auto-wait 复核（不做）=条目三段全部闭环。

## V20261113007 — 2026-11-13 [feat]

- **九条目实施链批 5a：C5' 定位闸门族（select 唯一性闸门 L202 用户核心提议落地）**——selftest 422→**423/0/0**（#126 八组用例；CLI 零变更零漂移）：
  - **`target.nth`**（0 基，与 CLI --nth 同名同基）：text/role 两层；unique/nth 互斥；越界红附候选清单（tag/text/rect/frame——防 CLI/flow 排序链不同源陷阱，已声明边界）。
  - **`_meta.uniqueDefault` 默认 true**：六操作类（click/rightClick/type/select/scroll/drag）单点注入；三级逃逸链=target.nth/target.unique > 步骤级 unique > 全局 uniqueDefault:false；**存量 10 flow lint 前后零差异**（M1 22/M2 5/0 冻结不变）+**29 步影响清单冻结棘轮**（tmpdata/impl-b5a/unique-inventory.json，存量实弹修复另行编排）。
  - **蒸馏条文兑现**（批 1 指针）：操作类默认生成 unique:true+nth 多值例外+步骤级逃逸+质量清单唯一性闸门项。
  - **`TARGET_AMBIGUOUS` 细分码**（gate/requireLocated 共用出口+失败报告 error.kind=target）；**role 层 aria name 匹配**（target.name 与 role 同用，accNameOf 三源：aria-label>alt>textContent 与 refs pgName 同口径，contains/exact）。
  - 实弹三连过：默认红附候选→nth:2 消歧→unique:false 逃逸（本地 fixture 3 同名按钮）。mechanisms §21（530/535）；playbook 批三四原语段+M1/M2 计数过期注记由编排方随收口更新（:411/:412）。

## V20261113006 — 2026-11-13 [feat]

- **九条目实施链批 4：C6 快照语义分组压缩（条目闭环）**——selftest 421→**422/0/0**（#125 八用例）：
  - **`a11y --group` opt-in**：渲染层按 landmark 语义分组（12 角色同义表含 HTML 标签）+组内同父同角色连续 run 合并（`role ×N: @e3 "名" | @e4 "名"`）+冗余行折叠（InlineTextBox/ListMarker 并入——父文本副本/视觉符号，真页收益显著）+深度秩压缩；**默认输出逐字节零变化**（golden 断言）+**@eN 编号源完全不动**（分组仅渲染形态，ref 序列默认/分组态 19/19 一致实证）。
  - **收益实测**：实弹本地页 6062→2560 字符（**-57.8%**）；合成典型应用页 52.8%/36.5% 双口径 ≥30% 达标；扁平无 landmark 页仅 7.2%（如实写入 §20 边界，不承诺全场景 30%）。
  - `--group` 与 find/diff/cursor/out 互斥（E_USAGE）；`--json data.groupView`（stats+groups）；#96 a11y-help 基线同批；mechanisms §20 预算随批提 520→**535**（524/535，沿革注释续写）。
  - 边界：分组态省略 bounds（保留在默认视图/data.nodes）；--frames 帧归属保留但未单独造 fixture（代码直通）；未做 --expand 控件（YAGNI）。

## V20261113005 — 2026-11-13 [feat]

- **九条目实施链批 3：C4 bot challenge 识别与止损（条目闭环；用户 L201 语义落地）**——selftest 420→**421/0/0**（#124 八组用例）：
  - **检测**：新 lib/challenge.js——八墙数据化特征表（Cloudflare/Akamai/DataDome/PerimeterX/Imperva/AWS WAF/通用 captcha/access denied；title/文本 6KB/DOM/Cookie 名/页侧全局五类信号）+单墙 ≥2 类**不同**信号合取（防误报）+数据化单点便于热修；CDP 不回传响应头（cf-ray 等指纹未纳入，如实）。
  - **挂点**：goto 导航后置+new 附着检查+flow goto 步级（CLI>`_meta`>默认三级）三挂点；flow 挂点置于冻结轮询 catch 外（首轮红自修：阻断异常曾被吞成 NAV_FAILED）。
  - **双态语义（用户裁定）**：默认=检测即阻断 exit 1（`CHALLENGE_DETECTED`/复用 E_POLICY_DENIED+data.challenge+接管提示）；`--allow-challenge`=放行仅提醒（warnings+data.challenge）；`--challenge-wait-ms` 有限自愈（默认 15s，CF/Akamai/Imperva 类非交互盾等待，交互盾不等待）——参考 Browse「禁止自解/禁止连环重试」。
  - 实弹本地 fixture 双态三连过+零误报负样本；audit `challenge.blocked|allowed`；#96 五条基线同批（goto/new/flow/main/flow-usage）；mechanisms §19（516/520 预算内）；真实盾站未实测（任务纪律只打本地 fixture，如实）。
  - 首轮 2 红自修复记录：flow catch 吞异常+#123「new 旗标零新增」旧断言随规范内旗标变更调整为只钉 C8 面。

## V20261113004 — 2026-11-13 [feat]

- **九条目实施链批 2：C7 HAR 标准导出 + C8 页签治理（条目闭环×2）**——selftest 418→**420/0/0**（#122 六用例+#123 七用例）：
  - **C7 `net --har <path>`**：HAR 1.2 单源构建（新 lib/har.js：log/creator/pages/entries/timings/pageref）；redact §16 全复用（头/URL/postData/body/queryString→`<redacted:*>` 引用，实弹 7 类凭据原值零残留）；默认路径零变化（富字段采集仅带旗标启用）；#96 net-help 基线同批。
  - **C8 页签治理（用户 2026-11-13 裁定降级形态=命名标记+回收+防抢前台）**：新 lib/tab-govern.js——agent 页签注册表（new 登记/close 注销/targets 打 `[cu]`）+惰性空闲回收（new/close 顺带无 daemon，默认 10min，config `tabs` 段/env 可配）+**白名单铁律**（未登记=用户页签永不回收）+永不抢前台（源码闸断言回收/扫描零 activate；select 除外）+busy 豁免（job/lock/handoff）；注册表预留批 7 租约化字段形态；config 模板补 tabs 段示例（编排方顺手）。
  - 实弹：HAR 3 entries+15 处脱敏；页签登记/回收/未登记页签不动/用户页签全程未动；新 help 基线（new/close-help）同批；mechanisms §18（508/520）+playbook 两行（567/575）预算内。
  - 边界如实：Cookie 头浏览器禁发→脱敏由合成断言覆盖；flow/MCP 路径页签不登记=永不回收（安全侧）；close 多余参数静默忽略（既有观察非本批引入）。

## V20261113003 — 2026-11-13 [feat]

- **九条目实施链批 1：录制定位链 V1 + C9 诊断易用性（条目闭环×2；计划=tmpdata/impl-plan-261113/plan.md）**——selftest 416→**418/0/0**（#120 五用例+#121 八用例）：
  - **V1a/V1b 蒸馏协议补全**：distill.md 输入节收录 locate-materials jsonl+「素材→target 生成规则」五条（aria.name 首选/dynamicCls→强制 aria/domPath ③层兜底/testid→desc/同文本多义→container）+「相邻事件等待决策树」四分支（<500ms 直连/可定位→cond 就绪即走/无文本容器→clamp(实测,500,3000)/无锚点→wait ms+desc）；unique 默认条文留指针归批 5a（边界划界执行）；77→104 行。
  - **C9 诊断易用性**：doctor/probe/printLocateFailure 输出加「结论行+nextStep 动作行」（八层分型原文案保留只在头/尾追加；help 面零漂移 #96 不动；probe/doctor --json data 增 conclusionStatus/conclusion/nextStep；LOCATE_DIAGNOSES 表 E_ 码 hint 族）——实弹 Chrome/156 验证。
  - V1c：O6 挂账不关（gate=下次实录），条目行加注「素材消费协议已落，下次实录顺手核对后关」。
  - 遗留如实：TODO「9 条可推进」焦点行=批前已有（上批焦点修正未提交），本批同 commit 收口。

## V20261113002 — 2026-11-13 [chore]

- **录制定位链需求分析批（用户提出「录制时捕获定位参数+精准等下一事件」→ oracle 查证定案）**——分析档案=reports/录制定位链分析-20261113.md：
  - **现状回答（用户「是不是已实现」）**：采集端大头**已实现**（V202609220002 六型白名单富采集 locate 素材 jsonl：aria{role,name}/稳定 domPath/id/testid/text/dynamicCls，动态类与动态 id 全滤除）；cond 八键+anyOf 引擎已能表达「等下一事件元素」；**真缺口=素材落盘未用**（distill.md 输入清单零收录、素材→target 生成规则无条文）——「能力已备、链路未闭环」。
  - **痛点② wait N 秒属实、新旧分明**：8 流实测=三个现代流零 wait-ms 全 cond；五个 ERP 老流 wait-ms 重度（delivery 38 步含 11 个均值 5.5s），主因=跨域 iframe uiAppear 盲区+服务端退化期产物。
  - **主流对照**：Playwright codegen（录制时多匹配自动强化 locator 唯一+strictness>1 抛错+auto-wait 六检查）/DevTools Recorder（selector 优先级+每步多 selector 顺序回退）——chromeuse 采集端字段集≈主流全集，差距全在消费端契约。
  - **落地**：新条目【录制定位素材消费闭环+蒸馏等待决策树】（V1 纯文档批：素材进蒸馏协议+生成规则+相邻事件等待决策树+顺手关 O6；效率账 delivery 流预估省 40~50s）；C5' 追加姊妹条目互指注记（正交不合并：本条=文档批、C5'=引擎批）；排期建议=C4/C5' 后顺手批。

## V20261113001 — 2026-11-13 [chore]

- **opencode Browse 对比调研批收口（thdxr 推文 → explorer 调研 v1 → 用户 14 条批注 → oracle 查证重整 v2 → 用户裁定落地 TODO）**——调研档案=**reports/opencode-browse对比调研-20261113.md**（451 行，含四问四答/14 条批注回应/可落地清单/select 闸门分析；证据截图 reports/evidence/opencode-browse-20261113/）：
  - **核心事实**：推文（dax/@thdxr 11-12 个人体验）指向独立产品 **OpenCode Browse**（MCP server+Chromium 扩展+本地 relay，Patchright/Playwright 驱动用户真实浏览器，v0.0.16）；与 opencode Desktop **内置** browser（Code Mode 40+ 操作）是两套；全链 CDP。
  - **用户裁定落地 8 条开放条目**（排序=好用类在前省 token 在后）：C4 bot challenge 止损含 `--allow-challenge` 旗标（高，L201 语义=默认阻断提示接管/旗标放行仅提醒）/C5' 定位机制自研补强（高，L150/L202 不引 Playwright——flow unique 默认开+nth+蒸馏协议+自动等待+L159 flow 表达力 V2 合并）/C2 handoff 人机接力（中高，L147 通知=状态落盘+agent 自决+opencode 优先）/C9 诊断易用性（中，L155 结论行+nextStep）/C6 语义分组（中后，L203 排后）/C7 HAR（低）/C8 页签分组回收（低）/C1 命名会话（低，L146 降级）。
  - **select 唯一性闸门机制定案（L202 用户核心提议）**：CLI 交互层**已完整实现**（E_AMBIGUOUS 多命中不猜+--nth 消歧+@eN fail-closed，drive.js:183/cdp.js:2428 实证）——用户提议在 CLI 层是既有能力确认；**真缺口在 flow replay 层**（unique 契约 opt-in 赌排序/无 nth/蒸馏不自动加），四步实施拆步进报告 §2.7，并入 C5'。
  - **O10 关闭**（Playwright MCP 并存实测——gate「方案二启动」被用户裁定「不接 Playwright」永久否决）；O16/O17 加降级注记（C1 连带）；Browse 容器化 7×24 结论=勉强可行得不偿失（核心卖点依赖人在场，报告 §L144）。
  - 过程：explorer 调研（推文实读无登录墙+Snowflake 交叉验证）→ oracle 重整（新增 9 条断言 A13~A21，chromeuse 源码核实 select 闸门现状）→ 编排方抽查验收（源码锚点复核）→ 落地。

## V20261112002 — 2026-11-12 [feat]

- **三缺口实施批 #119（V20261112001 立项 → oracle 设计 tmpdata/insecure-design/plan.md → fixer 实施 → 编排方亲验两连过）**——selftest 415→**416/0/0**（#119 七组用例）：
  - **缺口① `--insecure` 连接级证书忽略（四命令窄集 goto/new/exec/flow replay）**：挂点=openClient 第三参（连接后 **browser-level** 无 sessionId 发 `Security.setIgnoreCertificateErrors`，S2/S3 两级发送实证）+flow-engine runFlow connect 后一行（长连接整场覆盖=自签 SPA/WS 正确挂点）；断连自动回退零全局残留；audit `security.ignore-certs` action（真实落盘编排方复核）；--json data.insecure:true（goto/flow）；不支持命令静默忽略（fake 断言钉死零 Security 调用）；**窄集修正**：TODO 原方向 screenshot/probe/wait/a11y/eval 经查证「单命令窗口内只有导航触发证书校验」全部不加。
  - **缺口② `wait --expr <JS>`（新旗标不新命令）**：轮询 Runtime.evaluate truthy 判定，与 --text 互斥，复用 --interval/--timeout，容错对齐 waitForText（异常续轮询超时才败），主 frame 不跨 iframe——CLI 级「等任意 JS 表达式」缺口补上（seq2481 裸脚本能力的等价物）。
  - **缺口③ main help 按组速查区（build 第三产物）**：cdp.js 模块级 CMD_QUICKREF 生成块+helpMain 插值；**位置顶部化**（编排方批准偏离 plan §3.3.1：原「子命令：」后位置在 head -c 600 验收口径外，标题后=截断保头语义更强）；#116 扩三产物 --check+quickref 与 meta 投影一致断言。
  - **实弹**：自建自签 HTTPS fixture（openssl+node https 随机端口，finally 清理）**两连过**+无旗标对照组 ERR_CERT_AUTHORITY_INVALID（防假绿）；**⚠ 3020 已被 chrome-browser 信任库信任不能作靶**（S6 实证：浏览器信任/curl 不信任）——环境注记进 playbook。
  - **#96 基线重置**：goto-help/flow-help/wait-help/main-help 四条（11200→~11.9KB 含速查区）；**预算随批提升**（沿革先例）：mechanisms 500→520（§17 新节，502/520）、playbook 560→575（自签验证管线组合样例，566/575）；#98/mechanisms §8.2/#116④ 零变化（无新命令）。
  - **findings（4 条实施级，fixer 终报）**：①parseArgs 布尔旗标吞后续 token（plan §7.2 预警成真）——`--insecure=true` 归一补丁（--async 同款）已打，`--json` 等其余布尔旗标同病 → 挂 O24；②quickref 常量块置于 SUB_HELP **之后**（防 record:/grid: 行撞 #80/#82-87 群的 SUB_HELP 切片锚点），输出顺序仍顶部；③实弹纪律三条沉淀=先对照后 --insecure（S5 秒级时滞会假绿）/HTTPS fixture 必须子进程（spawnSync 阻塞父事件循环致 Page.navigate 假超时）/flow _meta.app 走已登记 app 安全阀；④cdp.js --help 管道消费截断在 8192 字节（process.exit 不等 stdout flush，HEAD 同截断=pre-existing）→ 挂 O23；当初「全列仅见 14 名」机理=8192 截断+grep 形态双重因素，速查区顶部化正是解药。另：fixture 证书落 os.tmpdir（非 skill tmpdata，防仓库密钥残留）finally 已删。

## V20261112001 — 2026-11-12 [chore]

- **linux-desktop 上线验证批复盘 → cdp.js 三缺口立项（agent 区新增 3 条开放条目，2026-11-12 用户指令「看验证过程有无 cdp 缺少项」）**——证据源=会话 ses_e37ac1218ffe5OGDQ2k1jZENk9（linux-desktop Docker 远程桌面容器方案，提交推送前浏览器验证段 seq2418~2499，编排方直读 session db 复盘=L1）：
  - **缺口①【--insecure 自签 HTTPS 通道】（中优先级）**：该会话验证 `https://NAS_IP:3020`（linux-desktop gateway，自签证书）时——exec `Security.setIgnoreCertificateErrors` 成功后同批 `Page.navigate` 仍 `ERR_CERT_AUTHORITY_INVALID`（单命令独立 session，Security 域设置不跨命令保持）→ 被迫裸写 Node22 WebSocket 单连接脚本（忽略证书→导航→等待→截图→读 isSecureContext）完成验证；cdp.js+lib 源码零 `Security.` 调用实证缺口。方向=常用命令加 `--insecure` 连接级旗标。
  - **缺口②【复合验证就绪等待】（低）**：裸脚本还承担「等 WS/canvas 就绪再截图+读状态」；goto 仅 --timeout 无就绪条件语义；方向=先查证现有等待能力再定最小旗标或文档化。
  - **缺口③【main help 命令速查行】（低）**：会话两次 grep main help 找命令落空→猜 `newPage` 失败（真名 `new`）→exec 透传绕行开页签；方向=meta 生成一行速查（#96 main 基线同批）。
  - 附注：用户看到的「fallback 到 chrome-devtools MCP」实为该会话 seq2418 在 Code Mode 搜 chrome-devtools 工具目录（返回空，未实际使用 MCP 干活）；真正的绕行通道=exec 透传+裸 CDP 脚本，已如实归因到上述三缺口。

## V20261108001 — 2026-11-08 [chore]

- **install.js ts() 收敛 formatStamp 单源（2026-11-05 用户裁定「无依赖按推荐来」，2026-11-08 落地；单源收敛清单最后悬置项闭环）**：
  - 改动=顶部 `require('./lib/time')`（与既有 lib/log 同级依赖——**「零依赖」实指零第三方，本地 lib 依赖是既定架构**，#25 断言本就强制 install.js 接入 lib/log）+`ts()` 改一行委托 `time.formatStamp()`。
  - **行为变更（用户已裁定接受）**：备份命名 `.bak-20261108123456`（UTC 纯数字）→`.bak-2026-11-08_10-17-23`（**本地时区**+文件名安全形状，实测形态留档）；`.bak-*` 拼接点（install.js:148）与 PRUNE_KEEP `/\.bak-/` 永不删规则零改动兼容。
  - 验证：node --check+selftest **415/0/0** 全绿（#19/#25/#94 install 相关断言无回退）+formatStamp 输出形态实弹。

## V20261105001 — 2026-11-05 [chore]

- **人工遗留项归纳整理（2026-11-05 用户裁定：两大复测捆+其他老样子）**——8 条人工项收敛为 **4 条**：
  - **【示例ERP测试库库存锁定复测批（ERP 恢复后一批完成）】**：合并原【inventory-lock 复测准备】【库存锁定人工对照】+观察区 O2（E6 面板旁路/领料锁定复测/delivery 步骤 31 重锚），五步批内流程（用户确认恢复→agent 复测两连过+删单→agent 顺跑 E6/领料/delivery→用户 Selkies 人工对照→agent 入档收口）；三条目前置证据行保留。
  - **【Windows 桌面端复测批（一次回传一批完成）】**：合并原【行尾归位+终验】【视口三态实测】【Node 版本采样】+观察区 O11（junction 实测）+【多分辨率与录制视口②③+矩阵 A-D】（列为可选延伸步④），六步批内流程（准备→行尾归位+junction→视口三态→可选矩阵 A-D→一次回传→agent 入档+终验）。
  - 其他两条老样子保留：【install.js ts() 行为裁定】【第二应用手册化验证·完整章程级】。
  - 观察区 O2/O11 升入两捆后**编号跳空保留**（表头注明，锚点稳定不重排）；焦点区人工等待两行改写为两捆指针。

## V20261104013 — 2026-11-04 [chore]

- **agent 遗留清理批 C10：TODO 终态对账收官（台账收敛为「人工项主视图」）**——**压缩迁移存档=git `e023976`（V20261104012，压缩前最后完整版）**，被压缩 22 条的全文/进度行/候选方案细节均可回查：
  - **终态结构**：人工遗留项 **8 条**（存量 4+迁入 4：行尾治理/第二应用/多分辨率与录制视口合并/Node 版本采样，全部含「需用户：…；完成后 agent：…」格式）+ agent 挂账观察区 **O1~O22 索引表**（gate/触发后动作/档案锚点四列）+ INBOX 1 条（视口截断候选②仍开放）；TODO 103→**~90 行**。
  - **吸收与合并**：INBOX E6 两行+delivery 步骤 31 → O2（ERP 恢复捆）；oracle 归因批三小件（弹窗守卫/E1 A/B/标签告警，09-18 起未办结）→ O22（如实保留不丢）；O16/O17/O21 候选方案要点并入「触发后动作」列。
  - **规则升级**：使用规则 5 增 C8 后新流程（新增/改命令=改 meta+跑 build+同批核对三处计数）；规则 1 适配新分区结构；**#6 分区头断言同批适配**（agent 分区头「（agent 可自主完成）」精确匹配→「agent 遗留项」前缀匹配——结构演进，断言 B/C 逻辑不变实测仍过）。
  - **facts.md 补 C3 结论节**（「后台 tab 节流四格对照」5 条：等待/采集通道无退化+定时器 1s 钳制+bringToFront 7~36ms+污染过滤方法论+V202610220003 未复现边界；127/200 行）——与既有 E2 getEventListeners 节互证。
  - **全清理链总账（V20261104005~013 共 9 commit）**：oracle 计划 35 条判定 → 闭环 **12 条目**（L38 口径/L40 description/L42 单源/L59 88 版本闸/L63 四格证伪/L107 截图标注/L110+L94 N12 POC+实施/L35 同源化/L61 网格三段）+人工迁 5+压缩 22；selftest 410→**415/0/0**；新能力 5 项（--annotate/grid 双命令/--js-listeners 三旗标/88 advisory/同源化流程）；过程事件 3 起（C8a 会话尾部卡死接手/C1·C2 并行瞬时态互扰/unpkg 环境假设证伪已记 memory）。

## V20261104012 — 2026-11-04 [feat]

- **agent 遗留清理批 C11：N12 JS click 监听可交互候选（--js-listeners / --mark-js / --cursor-pointer，条目闭环）**——selftest **415/0/0**（414→415：#118 组九用例）：
  - **新 `lib/js-listeners.js`（~440 行，单一实现源）**：`scanClickListeners` **单 session 闭环**（evaluate 取 documentElement→getEventListeners{depth:-1,pierce:true}→releaseObject，**零 Debugger.enable**——POC 硬约束源码注释在位）；**能力闸**=error.code（-32601/-32000）→`{supported:false,code}` 明确降级不崩不静默（88 分叉承接）；候选解析 cap 200+errors 计数；cursor:pointer 只读扫描；来源合并（spec+js-listener+cursor-pointer 去重）。
  - **三旗标默认关接线**：`locator probe --js-listeners`（监听节点并入候选，纯监听源无文本锚点可用）/`--cursor-pointer`（组合候选）/`a11y --mark-js`（无 role/name 监听节点加 `[J]`，只标不改节点数）；**X1/isClickable 判定逐字节零改动**（源码红线断言）。
  - **默认零漂移三重实证**：①默认 probe 文本输出逐字节 golden（6 行精确）②默认 `--json` 无新字段 ③**throw-js 哨兵证明默认路径零 DOMDebugger 调用**（零性能成本）。
  - **实弹四录**（153 自建页签）：纯 onClick 无 role/name 的 div 列出（source=js-listener）/a11y `[FJ]` 标记（去 J 与默认逐行一致）/双源组合去重/cursor-only——页签卫生含失败轮 finally 兜底关闭。
  - **语义边界如实**（mechanisms §12.8 五条，482→490/500）：只覆盖**直接监听**（React 17+ 根委托元素级不可见，--cursor-pointer 兜底）；window/document 自身监听不在 documentElement 子树内（未承诺）；跨源 OOPIF 未验证；handler 源码不可得。
  - **C8 新流程复用**：meta 登记（locator/a11y flags 增补）+build 重建 SUB_HELP/SKILL §1.2（2 行）；#96 locator/a11y help 基线同批；47 命令/12 放行/35 拒绝面计数不变；#1 manifest+九组用例（纯函数/红线/golden/三旗标/E_USAGE/meta/实弹）。

## V20261104011 — 2026-11-04 [feat]

- **agent 遗留清理批 C9：虚拟化网格（react-data-grid）读数与定位支持（L61 条目三段全闭环=C6 纪律+C7 POC+本批）**——selftest **414/0/0**（413→414：#117 组）；**首个走 C8 新流程（meta+build）的命令实战**：
  - **设计定稿**：读数=`extract --kind grid`（**只读零滚动零合成事件**——#117② 源码闸门守门，输出 generation/列头视觉序 visibleHeaders（rect.left 排序）/visibleRows/totalRows/totalCols/单元格值+rect+visible，离屏未渲染输出「离屏未渲染≠空值」指向滚动命令）；定位+滚动=独立新命令 `grid locate|scroll-to`（有页面副作用不进 extract）：locate=按列头文字+行号定位→必要时滚动+轮询复读→**默认还原 scroll**（--keep-scroll 保留）；scroll-to=只滚动保留现场（--restore-scroll 可还原）；滚动后派发一次原生 scroll 通知令 RDG 重算虚拟列（C7 POC F2：程序化 scrollLeft 不自动触发列虚拟化）。
  - **双代际识别**：v6 `.react-grid-*`（fixture 实测）+v7 `.rdg-*`/aria-colindex/aria-rowindex（类名面从 v7 beta.47 bundle 落实现，**v7 fixture 未跑**——C10 后可补 CDN 冒烟）；`--col` 文字→data 索引，视觉序仅展示（不把视觉序号当列索引）。
  - **落点**：新 `lib/grid.js`（624 行：纯函数+只读/滚动/还原三表达式+Node 侧四入口，同源 iframe frameElement 坐标链）+`tools/cdp.js`（extract 分流+grid 命令 dispatch）+`commands.meta.json`（grid 命令+组+since=V20261104011）+新 `selftest/fixtures/grid/`（fixture.html 窄容器 1000×20 列虚拟化+iframe 冒烟页+serve.js 随机端口+vendor 三 UMD+sha256 校验，**入库**）+SKILL.md §1.2 网格组（经 build 生成）。
  - **实弹三录**（chrome-browser+本地 fixture 随机端口）：①列头视觉序定位——横向滚动后 DOM 首列仍列头1、视觉首列列头8，`grid locate --col 列头11 --row 500` 命中 `R500-C11`（DOM 序≠视觉序的解药实证）②离屏复读 diff——extract 读=「未渲染：离屏未渲染≠空值」→locate 滚动后复读=`visible=true` ③E_NOT_FOUND hint 含「离屏未渲染≠空值」；附加：默认还原 restored=true/scroll-to --row 700/iframe 坐标链 `R7-C3`。
  - **C8 新流程三处硬编码同批**：#98=**47 命令·35 拒绝面**、#116④=35、mechanisms §8.2 补 grid（482/500）；#96 main-help 基线 10833→**11200**（有意：helpMain 增 grid 行）；playbook 纪律节三行内命令指针（**零加行** 555/560）；README 46→**47**（两处+「46 命令」残留订正）；SKILL 引导 blockquote「其余 34」→35。
  - **边界如实**：iframe 坐标沿用 locator absRect 口径（只累加 frameElement rect 不含 border）；v7 totalRows=aria-rowcount−headerRows 分组/汇总未细扣；frozen 列/编辑态/lookup 弹窗不在 fixture 覆盖；#117 实弹依赖 chrome-browser 可达（不可达 warn 跳过，纯函数/fake-CDP 仍跑）。

## V20261104010 — 2026-11-04 [feat]

- **agent 遗留清理批 C8b：--help 同源化·投影与断言改造子批（L35 大项闭环，V20261104009 C8a+本批=完整交付）**——selftest **413/0/0**（412→413：#116 组）：
  - **title 扩展（编排方裁定 A 方案落地）**：meta 增可选 `title` 字段（12 条：screenshot/cast/flow/locator/click/type/wait/console/goto/a11y/css/popup-guard，全部 ≤60 字符）——SKILL §1.2 投影取 `title||summary`，SUB_HELP 仍用 summary → **帮助面零漂移保持**（#96 四条基线 main 10833/screenshot 1666/probe 445/click 1482 恒等，cdp.js 与 C8a 版 git diff 为空）；build 校验 title 形态（非空/≤120/单行）。
  - **SKILL §1.2 接线为生成物**：build 就地覆写「§1.2 引导 blockquote 后、§1.3 前」（引导 blockquote 手写保留；11 组/46 条生成段）；§0.1 维护约定改写=「改命令=改 commands.meta.json+跑 build（直改 SUB_HELP/§1.2 被 #95 抓漂移）」；SKILL 主干 **264/300**（生成后较手写 270 更紧凑）；**移除 C8a 组标题预检**（改 meta 组标题可直接 build，一致性由 --check+#116⑤⑥ 兜底——单源语义修正）。
  - **#95 改造（CORE_FLAGS 硬编码表删除=核心收益兑现）**：flags 源改读 `meta.flags`（selftest 内 45/46 命令硬编码表 :11181 删除）；新增 meta↔SUB_HELP 集合一致断言+`spawnSync build-help.js --check` 零漂移断言（live 无 git 可跑）；detail-only 旗标（--async/--out 等）以 SUB_HELP detail 为落点校验；**10 个历史测试组 SKILL 文案断言适配**（#87/#88/#90~#95/#109/#115——21 fail→0，投影后文案校验非行为变更）。
  - **#116 新组六用例**：①build 幂等（连跑 sha 相同）+双产物漂移检测 ②schema 负样本（缺必填/非法 group 等 4 例）③删命令同步减（临时副本跑不碰真文件）④jsonAllowed 三方一致（meta==mechanisms §8.1==JSON_COMMANDS）+拒绝面 34 ⑤组标题/组序/一行式一致 ⑥组标题改名单源构建——全部 mkdtemp 副本内跑。
  - **条目原文验收实证**：zz-test 临时命令进 meta→build→**cdp.js SUB_HELP+SKILL §1.2+`zz-test --help` 三面自动出现**（47 命令态仅 #98/#116④ 预期红）→删除复原 sha256 校验三文件全 OK+零残留——「新增命令只改 meta+跑 build」成立。
  - **文档计数订正**：拒绝面 29/31→**34（46−12）** 全链（mechanisms §7/§8.2 补 audit/artifacts/job+SKILL §1.2 引导行+README 45→**46** 两处）。
  - **遗留（C9/C10 必守）**：新增命令=meta+build+同批核对 #98 总数（46）/#116④（34）/mechanisms §8.2 名单；§1.2/SUB_HELP 禁手改；C8a 生成注记仍署 C8a（为保 cdp.js 恒等未动）。

## V20261104009 — 2026-11-04 [feat]

- **agent 遗留清理批 C8a：--help 同源化·迁移与注入子批**（L35 第一段；深度规划=tmpdata/agent-cleanup-261104/deep-d1.md）——**帮助面零漂移达成**，selftest **412/0/0 不变**：
  - **`commands.meta.json`（新，46 命令全量）**：schemaVersion 1+groups 11（标题原文对齐 SKILL §1.2）+每命令 usage/summary/detail/flags/group/since/jsonAllowed；**schema 必要扩展**=groups[].commands 顺序数组（SKILL §1.2 展示序；commands 对象序保持原 SUB_HELP 序——#80 源断言 20000 字符窗口限制，按组重排会让 flow/record --lock 文案掉窗，实测 1/4 失败后定此设计）；jsonAllowed=12 与 mechanisms §8.1/JSON_COMMANDS 一致；since 5 条新命令标注（⚠ audit/artifacts 用帮助原文内批次号 V202611030004/5，CHANGELOG 发布号为 V20261104001——历史口径差异已报，零漂移优先不本轮改）。
  - **`scripts/build-help.js`（新，零依赖）**：默认整体覆写 cdp.js SUB_HELP 块（锚=块首/块尾，自动 node --check）+`--check` 只检不写漂移 exit 1（供 #95 spawn 断言，live 无 git 可跑）+`--preview` 出 §1.2 预览；构建期校验=必填字段/usage 前缀/group 引用/组标题存在 SKILL/组覆盖全集。
  - **模板忠实性校准闸通过**（deep-d1 §5 风险 2 前置）：5 条简单命令 build 产出与现状逐字节一致后才放开全量；**终态=SUB_HELP 46/46 值逐字节恒等 HEAD+仅 1 行生成注记（93 字节）→ #96 四条基线 sha 全等无需重置**（main 10833/screenshot 1666/probe 445/click 1482）；build 幂等（连跑 sha 相同，编排方复核实证 d44c9b90×2）。
  - **交接与裁定**：`tmpdata/c8a/HANDOFF-C8b.md`（接线建议 5 条+summary 质量缺陷）；**编排方裁定=缺陷处置选 A**（10 条「--json 先行」命令 summary 反切欠佳+popup-guard/cast summary 超长——C8b 增 meta.title 字段供 SKILL 投影，summary 仍供 SUB_HELP，零帮助面漂移；B 方案重排文本需 #96 重置，弃）。
  - **⚠ 过程事件（如实）**：fixer 会话尾部卡死（实质工作已全落盘：HANDOFF+meta+build+WORKLOG 记录 46/46 全检与零漂移结论；steer 35s 无响应）——按用户熔断指令 task_cancel 后**编排方接手验收**（亲跑 selftest/幂等/--help 抽查/meta 全同步核对），未重启重做。
  - **文档计数残留（C8b 顺手订正清单）**：mechanisms §8.2「31（45−12）」实际拒绝面 **34（46−12）** 且列表缺 audit/artifacts/job；SKILL §1.2 引导行「其余 31 命令」陈旧；README「45 子命令」实为 **46**（#98 硬编码 46 为准）。

## V20261104008 — 2026-11-04 [feat]

- **agent 遗留清理批 C5：N11 截图标注 set-of-marks（screenshot --annotate，L107 条目闭环）**——selftest **412/0/0**（411→412：#115 组 9 用例）：
  - **POC 通道定夺**（批内第一步）：①ffmpeg drawtext **不可用**（/root/tools/bin/ffmpeg 7.0.2-static 构建缺 freetype 只有 drawbox；容器零字体——fc-list 不存在+/usr/share/fonts 不存在）②下载字体方案**否决**（无渲染器可用+字体须同步 live 部署面违背零依赖边界）③**纯 Node zlib PNG codec+内置 5×7 点阵字模选定**（`lib/annotate.js` 344 行，仅 node:zlib 零第三方；decode 147ms/encode filter0+level6 ≈134ms@2558×996，自适应过滤 1338ms→优化 10×）——**live 零新增文件零安装步骤**。
  - **命令形态**：`screenshot --annotate`——现场物化 ref 表（内部 perceive.runA11y+refs.materializeRefs，**与 a11y --ref 同源同编号**，refs.js 零改动导出面已具备）→Node 侧叠 `e1..eN` 红框+黄底编号（**零页面注入**）→stdout/`--json data.annotate` 输出 `{refs[{ref,rect}],annotated,total,scale,skipped,refTable}`；ref 物化预算固定 10s 不随 --timeout；按 targetId 覆盖 refs 表（与 a11y --ref 同语义单一真源）；代际/滚动漂移/失败**明确报错不静默降级**。
  - **红线实证**：`--annotate` 关闭时截图**字节不变**（golden 硬比对：HEAD 版 cdp.js vs 新版同页签三连截图 sha256 `609be7c4…` 完全一致）——#115⑨ 源码闸门常驻。
  - **实弹**（自建页签谁开谁关）：8 元素页 `a11y --ref` 与 `screenshot --annotate` **8/8 编号与 rect 逐条一致**；--dpr 3（scale=3+restore ok）/--viewport 800x600（8/8+还原）/400x200（**6/8 越界 e7/e8 如实 skipped=offscreen**）；`click --ref @e1` 用 annotate 产出的表命中「确定」——**标注不改变真实点击路径**；用户页签（飞书/BigModel）全程未触碰。
  - 帮助/文档：SUB_HELP+主帮助 screenshot 行、SKILL §1.2 捕获组行内（主干仍 270/300）、mechanisms **§13.5 视觉标注**（470/500）；#96 screenshot-help 1267→**1666**/main-help 10739→**10833** 有意同批（含文档补全批后 helpMain 文本漂移的一并校正）；#95 CORE_FLAGS 补 --annotate。
  - 遗留（如实）：仅支持 png（jpeg 组合明确 usage 报错）；密集元素标签可能压邻（纯视觉，碰撞避让后续可选）；重页面 ref 物化超 10s 明确报错。

## V20261104007 — 2026-11-04 [chore]

- **agent 遗留清理批 C6+C7：虚拟化网格 L61 线前两段完成（纪律先行+fixture POC 通过；条目保留待 C9 实施）**：
  - **C6 纪律先行**（`references/playbook.md:124-130` 新节「虚拟化网格取证纪律」，549→**555/560** 行）：识别（.react-grid-* 类名或行数≪totalRows）/①判空纪律（空串≠空值，滚动复读+截图**双向佐证**：滚前空+滚后有=虚拟化，前后皆空=真空值）/②定位纪律（DOM 序≠视觉列序，列头文字+行号禁 nth-child）/空白格坐标兜底（frameElement 累加）/③全量走「重新执行查询」。同批压缩 3 处腾位（iframe 两条并一条+删「子命令速查」重复条+flow 视口改指针——零信息丢失，清单见批 WORKLOG）。
  - **C7 fixture POC 通过**（零代码，产物=`tmpdata/grid-poc/`）：**通道②采纳为 canonical**（本地 UMD react@16.14.0+RDG v6.1.0+`node serve.js` :8123 零依赖，自包含+版本钉死+sha256 留档；`getent hosts opencode` 容器互访实证）；判据三条全实证（1000 行×20 列渲染=17 行/340 cells/20 列头、全量 20k cells vs DOM 340+hasR500/R999=false、scrollTop 5000 行集 R1..R17→R144..R162 diff 非空）；**列虚拟化症状双实证**（窄容器 scrollLeft=1200 后每行仅 10 列可视、`cells[0]` 读到 R1-C11 静默错位越界+HeaderCell DOM 序≠视觉序）；**⚠ 通道①CDN 意外可用**（chrome-browser goto unpkg 785ms 渲染成功——「容器出网必挂」假设证伪，环境事实已更新 memory；选型仍取②为去外部依赖）。
  - **C9 定稿建议**（排 C8 后）：fixture 提 `selftest/fixtures/grid/`（+vendor UMD+serve 随机端口起停）；选择器双代际（`.react-grid-*` v6/`.rdg-*` v7）；核心断言=列头按 rect.left 排序/离屏滚动复读/E_NOT_FOUND hint 命中；边界如实（v6 等价非真实版本、iframe 坐标链/frozen 列/编辑态不覆盖需实弹回归）。
  - RDG 行为 findings：v6 列虚拟化 resize 后不触发须 scroll 事件；v6.1.0 npm 包不含 CSS（内联样式即可）；横向滚动后 HeaderCell 恒 20 个不随列虚拟化（不能作列可见性判据）。
  - 验证：selftest 411/0/0（#4 playbook 555/560）；页签/服务清理核对（targets 无残留+8123 已停+无 serve 进程）。

## V20261104006 — 2026-11-04 [chore]

- **agent 遗留清理批 C3：后台 tab 节流四格对照实证（L63 条目闭环，gate 证伪）**——纯实证批零代码，产物=`tmpdata/c3/`（report.md 218 行+driver/fixture/analyze 脚本+20 轮原始 JSON/PNG）：
  - **四格结论**（4 格×5 采样×20/20 clean，共享浏览器污染过滤后）：**等待/采集通道无后台退化**——wait 命中（后台无 btf 反而更快 219ms vs 386ms，因页面定时器慢导致等待目标更晚出现的前置噪声）/evaluate/console 推送（p50 1ms 级）/CDP 轮询/工具与 raw 截图（后台也 5/5 成功，raw 不置前帧龄 105~258ms）全正常。
  - **归因三层**：可见性=区分变量非故障源；渲染调度=四格差异唯一来源（后台 `setInterval(200ms)` 钳至 ~1000ms、rAF 完全停摆、`setTimeout(4000)` 落 1s 栅格 4067~4986ms——Chrome 调度行为，工具侧不可解也无需解）；CDP 连接=全程无差异。
  - **裁定**：L63 gate 证伪关闭（ensureForeground 已够）；focus emulation/`Page.setWebLifecycleState` **不立项**（前者不改 visibilityState、后者不解除定时器钳制，均无效）；`Page.bringToFront` 生效 7~36ms 实证（ensureForeground「置前后立即复核」写法成立）。
  - **重要 findings**：①V202610220003「后台 30s 超时/旧帧」在 Chrome 153+轻页**未复现**（边界如实：重页面/被遮挡窗口未覆盖，不能断言缺陷消失）；②**方法论沉淀**：共享浏览器做对照实验必须逐拍记录 visibilityState+污染过滤（v1 预跑 2 例中途翻转整批作废重采样）；③后台页定时器 1s 钳制事实待补 references/facts.md 一行（**并入 C10 收官批**，预算 200 注意）。
  - 未覆盖边界（如实）：intensive throttling（隐藏 ≥5min）/tab freezing/重页面合成器/Chrome 88 分叉/DPR——出现真实场景再立新条目。

## V20261104005 — 2026-11-04 [feat]

- **agent 遗留清理批 C1/C2/C4 合入**（oracle 整体计划=`tmpdata/agent-cleanup-261104/plan.md`：35 条判定=可推进 9/人工迁 5/压缩 21；C3 四格对照在途）——四条目闭环+人工区新增一条：
  - **C1 快赢（L38/L40/L42 三条目闭环）**：L38 计数口径核验收口=flow 原语 **14**（`lib/flow-engine.js:20` ACTIONS 逐项）+录制**基线**事件 14（`tools/recorder.js:8-9` 头注释 9+5 族；⚠ 运行时含 paste/wheel/focusin 等追加类型 >14，台账措辞统一「基线 14 类」防再争议）+playbook:400/408 已与真源一致；L40 SKILL description 483→**436**/500（余量 64；去重「网页操作/UI 验证/截图取证」与 MCP 产品名——触发场景由命令/工具列举与首句承接，#5 守门过）；L42 ③pad2 三处收敛 time.js 单源（log/audit 改引用，零新增依赖；⚠ 原登记「time/log 各一」过时，实为 ×3 含 audit.js）+②num/④ts 维持（cdp.js 主模块不反依赖录制模块，别扭依赖>2 行收益）+①install.js:46 ts() 行为变更**转人工裁定**（人工区新条目）。
  - **C2 Chrome 88 版本闸+矩阵（L59 条目闭环）**：`lib/cdp-core.js` 新增 `parseChromeVersion`（容 Chrome/HeadlessChrome 前缀，非 Chrome 串 null）+`mcpAdvisory` 纯函数——下限 **94**（唯一硬证据=WebCodecs 94+（GQ-001 screencast 依赖）；材料中「<96」为测试者兜底建议无实机证据不采纳；措辞「MCP 已知降级线（非硬协议门槛）」；`MCP_ADVISORY_BELOW` 常量单点可调）；probe（`tools/cdp.js:322-333` 通道① advisory+ℹ 行）/doctor（`:963-964`）接通——**advisory 非失败 exit 语义不变**，实弹 153 解析正确不触发+fake 88 单测触发；`references/install.md` 新增「Chrome 88 实测命令矩阵」16 数据行（174→**199/260**，三列=能力|88 实测|处置/替代，取材 `tmpdata/test-runs/2026-10-29/` 13 文件全映射）；selftest **#114** 新组 5 用例（parse 边界 93/94/95+advisory 文案+fake-CDP probe/doctor 双触发）+#96 probe-help/main-help 两条基线有意更新（338→445/10649→**10739**）。
  - **C4 N12 POC（L110 前置完成，零代码）**：**DOMDebugger.getEventListeners 免前提通过**——无需 Debugger.enable/Runtime.enable 直调成功（零副作用，2ms 返回 listeners[]）；结构完整（type/useCapture/passive/once/scriptId/lineNumber/backendNodeId）+50 节点批量 96ms（avg 1.92ms）+`documentElement depth:-1 pierce` 全页扫描 55 listeners/5ms（**backendNodeId 可与 AXNode.backendDOMNodeId 直接 join**=--mark-js 零额外往返）；**硬约束三条入实施设计**=①objectId 会话级（跨连接报 -32000，须单命令单连接闭环，禁拆 eval+exec）②React 根委托元素级不可见（子节点 0 条/根容器 1 条——直接监听语义边界，配 --cursor-pointer 兜底）③handler/originalHandler 源码不可得；88 未测归分叉承接（建议实施带 error.code 能力闸降级）。证据=`tmpdata/n12-poc/`（report.md+raw/49 文件+4 个附加采样脚本）。实施批排 C8 后。
  - **验证**：selftest **411/0/0**（410→411：#114 新组；C1/C2 并行期各自首跑见对端半落地瞬时 fail，合并树全绿——双方 WORKLOG 留痕）；pad2 单源 grep 复核（唯一定义+两引用）；description 含「浏览器」#5 过。
  - **遗留**：doctor 真机实弹待空闲窗口（副作用=bringToFront 动第一个 page 页签，fake-CDP 已覆盖语义）；88 矩阵为 2026-10-29 记录聚合非 Windows 复跑；L110 条目保留（转「C8 后排实施」态）。

## V20261104004 — 2026-11-04 [chore]

- **TODO 对账批（能力补强收官后全档整理）**：
  - **G4 条目关闭（按条目自身约定）**：原预案「a11y 快照分级落地后重评」——B6a 已交付 `a11y --find/--diff/--frames/--cursor`（万节点 --find 565B/只看变化行/iframe 整树），重页面感知体积控制需求自有 CLI 侧已覆盖，MCP take_snapshot 依赖度大幅下降；上游若加 depth 参数属被动收益，不再占条目。
  - **孤儿进度行清理 ×3**：闭环条目删除脚本「删条目+紧随一条进度」在多进度行条目上的漏删残留（B0 定案行/GQ-011.4 disabled 行/settle gate 旧行）——均已闭环信息在 CHANGELOG 留痕，纯冗余删除。
  - **gate 触发确认**：【--help 完整同源化】触发线已过（登记时 30+→现 45），是否立项（元数据单源+build 脚本，约 2~3 人天）**待用户裁定**；N11（截图标注）依赖 N4 已落地转为「待排期」；INBOX 视口截断条候选①标注已由 B4 诊断细分码大部分吸收。
  - 验证：selftest 410/0/0 不回退；TODO 118/300 行。

## V20261104003 — 2026-11-04 [feat]

- **能力补强批 B6a/B6b 并行合入——核心批 B0~B7 全部收官**（N5/N7 条目闭环；selftest **410/0/0**=基线 376→410）：
  - **B6a-N5 a11y 快照分级**（lib/snapshot-diff.js 新+perceive 扩展）：四模式=--find（树内检索+±2 上下文）/--diff（身份键 bId 优先→结构路径兜底；不可比回落 forcedFull 四因含导航；truncated 标 degraded）/--out（stdout 三键摘要+快照落盘）/--cursor（base64url token 续页，零 CDP）；三降噪=--exclude 子树剪除/--frames same-origin（**B0 定案路径落地：Page.getFrameTree 递归+逐帧 getFullAXTree({frameId})+DOM.getFrameOwner 挂接，实测双 iframe 22 节点同见**）/--visible-only 遮挡过滤；**88 分叉**=frameId 参数被忽略/拒绝→framesUnsupported+approximate:true 如实降级；基线按 target 存 tmpdata/a11y-baseline/（quota 预登记类）；默认输出逐字节不变（golden 硬比对）。**实测标定**：万节点级（3 帧×3500=10525 节点）--find 单命中 565B<2KB；diff 比例三页 0.019%/1.75%/1.27% 均 <20%；导航后 forcedFull 实证。findings：chrome-browser 通道单帧 >4000 AX 节点断开（疑响应体积上限未定性）→万节点验收用多帧合并达成；diff 结构路径兜底同 role/name 删除有序号位移边界（已标注，bId 为正常路径）。
  - **B6b-N7 输出脱敏**（lib/redact.js 新）：三层配置（secretsFile 本机凭据文件**禁入 skill 红线 #8**/urlParams 默认 7 项/patterns 正则+内置 Authorization·Cookie·Bearer·JSON 敏感键模式）；**四出口持久化前统一过滤**（stdout/stderr 文本+--json 信封+落盘 JSON/文本+audit 第二层 redact.deep）；**type 泄漏路径封堵**：默认只打字符数（value=null+valueChars），--echo-text 显式回显且仍过脱敏（行为变更已标）；net URL/body 过渡防线；--no-redact 显式关+audit 记 redact.disabled；**占位符输入 %KEY%**（secretsFile 优先/同名 env 回退，真值只进 CDP insertText）；config 模板×2 schemaVersion 2→3（#8/#9/#16 同批联动）。实弹 29/29（三处无原值+--no-redact 审计+占位符真值只进 CDP）。边界：tools/recorder.js 独立子进程录制文件不在包装内（--full-input 原文可能落盘，已标注）。
  - **合入对账**：#108/#109（22 组）+#110/#111（17 组）；#96 a11y-help/type-help golden 同步；#95/#98 全绿。

## V20261104002 — 2026-11-04 [feat]

- **能力补强批 B4/B5/B7 三批并行合入（串行收口单 commit）**——五条目闭环（R2 诊断/N4 引用句柄/N6 作业模型/N8 extract/N9 assert），selftest **383/0/0**（基线 376）：
  - **B4-R2 命中诊断增强**：定位细分码三枚启用（E_NOT_FOUND 零命中/E_AMBIGUOUS 多命中不猜/E_HIT_BLOCKED 命中被挡）+`interactState()` 可交互性判读（disabled/readOnly/aria-disabled/cursor:not-allowed+「非定位失败」一句话）+E_HIT_BLOCKED evidence（elementFromPoint 遮挡元素 tag/class/rect/z-index+三层祖先+inFixedLayer+hint 三条可行动下一步）——click/type/hover/drag/upload 五失败路径统一接入；实弹=透明遮罩 fixture 命中 E_HIT_BLOCKED 全证据+disabled select 判读+正常点击回归无忧。
  - **B4-N8 extract**：`extract --kind text|table|attr|links|json` 只读原语（零合成事件/零导航/零注入，跨同源 iframe）；table 首行表头+links 去重+json 支持 JSON-LD 与内嵌 script；实弹五 kind 全过。
  - **B4-N9 assert**：批量断言独立命令（--count/--text/--no-console-error/--url/--attr 可多条），**复用 B2 expect.buildProbeExpr 单源**（不另写一套）；默认失败不中断 exit 0 全明细/--fail-fast exit 1/no-console-error 读已有历史；--url 裁决=URL 正则（浏览器地址走 config）。
  - **B5-N4 引用句柄 @eN**（lib/refs.js 863 行）：`a11y --ref` 产引用表（仅 clickable/focusable+有 rect 节点，--max-refs 默认 50）；**物化恒定 2 次往返**（DOM.getDocument(pierce)+单次 evaluate 批量，弃 callFunctionOn 句柄泄漏面——断言 resolveNode 0 次）；三级定位链 cssPath→role+name（AX role↔DOM 映射表+name 三源 aria-label→alt→textContent）→container 收窄；失效契约 E_REF_STALE（导航/loaderId 闸门/元素替换不猜不救）+E_AMBIGUOUS+重解析有界一次；click/type/hover --ref 消费；`__cu_ref` 不可枚举标记=受控页面例外（不改 DOM 属性/不触发 MutationObserver）；**默认 a11y 输出逐字节不变**（golden）；fixture 实弹四场景+跨 iframe partial ref+goto 失效全过。
  - **B7-N6 作业模型**（lib/jobs.js，C 案裁决全套）：cast/scroll-shot/record/flow replay 增 `--async`（**秒回实测 101ms**+jobId+stateFile）；**O_EXCL 原子槽位**（wx 内核级，消灭 TOCTOU；上限 4/CHROMEUSE_JOB_MAX）；状态文件 {pid,startedAt,cmdline} **三元组孤儿判定**（/proc cmdline+启动时刻，防 pid 复用）；cancel 双路（record POST /__stop 优先+进程组 SIGTERM→3s→SIGKILL，partial 产物保留）；`--async` 强制显式 --target（tab 礼仪同源）+argv 剔除自身防递归；`job list/status/cancel` 三子命令+600s 惰性清扫；E_BUSY 满载拒绝（实弹 5 抢 4 槽+audit 实记）+--wait 可选阻塞（510ms 实测）已实现。
  - **合入对账**：#98 拒绝面=46（新增 extract/assert/job 落 E_USAGE）；#95 CORE_FLAGS 同源全过；mechanisms.md 预算 320→440（§12 B4/§13 ref 契约/§14 作业契约，现 404 行）；#96 golden 基线同步（locator-help 诊断说明）。
  - 遗留（如实）：input[type=submit] 第四源（value 命名）未做——该类仅走一级 cssPath；partial 树 --ref 整表覆盖（一次快照=一代）；flow 侧 --locator 固化消费未接线；console 历史回放仅 153 实测 88 未验证；Windows 进程组 kill 回落单 pid+#112 真实并发用例 warn 跳过。

## V20261104001 — 2026-11-04 [feat]

- **能力补强批 B3：N3 结构化审计日志 + N2 产物配额与保留期**（前任 fixer 派发零启动熔断后重派完成；N2/N3 条目闭环删除）：
  - **N3 audit（lib/audit.js 新）**：白名单字段制恒 10 键（ts/cmd/targetHost/targetPath 截 200 去 query/action/code/phase/elapsedMs/artifact/sessionId）——**绝不落 DOM 文本/输入值/URL query 原文/Cookie/Token**；挂两点（die 出口+then(code!==0) 共用 finalizeFailure）+成功单点上移 exit 0（覆盖全 41 命令含 audit 自身，一次调用一行）；`tmpdata/audit/yyyy-mm-dd.jsonl` 按天；`CHROMEUSE_AUDIT=0` 关；`audit tail/stats` 子命令；30 天 purge。实弹验证：type 假密码流程 grep 零命中（NO_LEAK_OK）；sessionId 经 CHROMEUSE_SESSION 落盘；stats 聚合含 audit 自身（自洽）。
  - **N2 quota（lib/quota.js 新）**：`artifacts report|prune|pin` 三子命令；分类表=video 3d（第一淘汰）→screenshot/download 7d→log 7d（最后）→fail-report/evidence 30d 不参与淘汰→**other 永不删（test-runs 用户材料已拍板）**；17 登记目录（含 refs/jobs/a11y-baseline/flow-checkpoints 预登记）；admit() 五入口（screenshot/scroll-shot 每段/cast 每帧+mp4/record 事件流+素材/-v 预检）；总配额 2GB/单产物 64MB；**prune 默认 dry-run+`--apply` 显式闸**（>500 文件或 >1GB 须 --yes）；超限 E_QUOTA 信封；schemaVersion 1→2（config 模板×2+#8/#9/#16 同批，本机实例同步过 #16）。
  - **对账**：report 与 find 逐目录精确相等（1781 文件/57.3MB/17 目录覆盖）；真实 tmpdata dry-run 506 文件 35.9MB、test-runs 不在清单；fixture --apply 后 pin 保留/证据类数量不变/固定序淘汰正确；70MB 单产物 E_QUOTA。
  - **⚠ 测试事故（如实报备）**：早期 fixture 验证 `prune --apply` 时 log 目录恒为 SKILL_ROOT/log（不受 CHROMEUSE_TMPDATA_DIR 隔离）→误删 24 个历史 chromeuse.*.log（gitignored 运行调试日志，非证据非用户材料，不可恢复）+log/.gitkeep（git checkout 已恢复）。修复=分类规则收紧（.gitkeep 全路径归 other 永不删；log 目录只认 *.log 其余归 other）+后续测试显式传临时 logDir。教训=N2 核心风险「误删」在开发期自证，防线已按「占位文件白名单+扩展名严格匹配」加固。
  - **验证**：selftest **376/0/0**（基线 351→376：#101 audit 7 用例+#102 quota 8 用例+#98 拒绝面 41→43 更新）；audit/artifacts 不支持 --json 落 31 拒绝面（#98 同批）。
  - 遗留：video 帧流逐帧 admit 未做（lib/screencast.js 不在本批文件面，一次改动即可接入）；record 事件流被拒时内存数据随进程退出丢失（已输出明确提示）；audit targetPath 过渡防线已就位待 B6b redact 第二层。

## V20261103003 — 2026-11-03 [feat]

- **能力补强批 B2：R1 交互后生效判据 phase/expect（四态状态机）**（用户裁定提前立项的 gate 条目闭环，条目已删）：
  - **`lib/expect.js`（新，零 npm 依赖）**：四态状态机（confirmed 判据窗口内成立/effect_pending 已送达有进展但判据未成立=显式中间态非成败/dispatched --no-wait-effect 送达即返回=旧行为/stalled 零进展转取证）——**转移表先行**（tmpdata/b2/state-machine.md：四态全部终态吸收、retry=新实例显式建模、probe_unobservable→stalled）；直接复用 `target-resolver.TEXT_EXISTS_V2_SRC/buildVerifyExpr` 单源（四路评审确认 X4 类方法不可复用后的更优落点）；`settleEffect`=deadline+400ms 节距+progress 三源。
  - **五命令接线**：click/type/key/drag/upload 增 `--expect-text/--expect-value/--expect-selector/--expect-count/--effect-ms/--no-wait-effect`（默认 30000=v2 裁决⑤/下限 500/上限 180000）；phase 进信封（--json data.phase+data.effect；stalled=E_TIMEOUT 失败信封+取证 hint 含 screenshot/doctor 指引）；exit 语义=confirmed/effect_pending/dispatched 全 0（调用方读 phase）、stalled=1。
  - **硬红线守护**：M4 假绿审计——节距 ≥400ms、下限 500ms（源级断言禁 <100ms 短封顶，#99③）；**裸命令（无 --expect-*）零新增 CDP 调用+输出逐字节不变**（#100② 文本精确相等+data deep-equal+0 次 Runtime.evaluate 证明）。
  - **findings（实弹抓真）**：①--expect-value 初版 `'value' in el` 会把 button 空 value 当主体值→改按元素类型取值（input/textarea/select→value、contenteditable→innerText、其余→textContent）；②progress 纯 CSS 动画盲区（不改 DOM/文本/尺寸）→hint 引导 screenshot 复核+文档如实声明；③key/drag/upload 不在 B1b 12 命令 --json 放行面，phase 暂走文本输出（扩放行面留 B4/B5 裁决）。
  - **验证**：selftest **351/0/0**（#99 状态机全转移+解析互斥+M4+复用单源+帮助面 / #100 fake-CDP 9 用例含裸命令三重证明）；实弹（9224）四态全绿：confirmed（polls=2/matchedAtMs=408）/effect_pending（progress=true/firstProgressMs=410）/stalled（E_TIMEOUT+hint）/裸命令单行旧格式；expect-value/selector/count 场景补充验证；页签谁开谁关。

## V20261103002 — 2026-11-03 [feat]

- **能力补强批 B1b：12 命令 --json 迁移 + 29 命令 E_USAGE 拒绝面**（N1 收口；前任 fixer 静默熔断后重派从零实施，防挂纪律=WORKLOG 探活锚点）：
  - **放行 12**（9∪5 去重：probe/targets/a11y/click/type/goto/screenshot/flow/wait + locator/console/css）全部走 `chromeuse-cli/1` 成功信封（`ok:true`+data+warnings）；**29 拒绝**（精确枚举=mechanisms §8.2）在分发层统一拦截（cdp.js:2944，switch 前）：**不执行命令**+exit 1+单行失败信封 E_USAGE——禁止「执行+告警」混合语义；未知子命令同点拦截（旧行为主帮助 stdout 会破坏单文档，改为 `未知子命令：x（见 --help）`）。
  - **既有 5 命令迁移（breaking，用户拍板直接迁移）**：data **原样保留旧报告对象**、外层换信封——迁移前后 deep-equal **8/8 PASS**（基线=tmpdata/b1b/pre-*.json+compare.js 归一 at/elapsedMs）；#90③ 同批更新；消费方改读 `.data.*`（仓内外零消费方已核）。
  - **契约扩展（findings 1）**：失败信封 data 不再恒 null——报告型失败（旧报告矩阵/probe·screenshot 矩阵/goto/wait/click 定位诊断/flow 失败 reportPath+summary）带结构化 data（mechanisms §1/§8.4）；`--json` 下 flow 进度行全转 stderr（文本模式不变）；回放 warnings 挂信封顶层。
  - **selftest**：#97（12 命令成功信封结构+5 命令 deep-equal+报告型失败 data 契约+stdout 单文档+非 json 文本 spot）+ #98（29 拒绝 E_USAGE/exit 1/单文档/文案钉死/**无副作用探针**+41 完备性）；#96 golden 扩 20 条；#95 CORE_FLAGS 9 命令补 --json。
  - **验证**：selftest **349/0/0**（4 轮复跑，基线 347→349）；实弹（chrome-browser 9224）12 命令全抽查 exit 0+单行信封+data 齐；flow replay 失败实测 E_LOCATE+reportPath；record/cast/new/eval/unknown 拒绝实测无产物；页签谁开谁关。
  - 遗留：locator pick 成功路径实弹未做（需人工点击；同 emitOk 单点+fake 超时已覆盖，风险低）；成功路径 audit 接线留 B3。

## V20261103001 — 2026-11-03 [feat]

- **能力补强批 B1a：CLI 失败出口单点化 + chromeuse-cli/1 信封骨架**（实施计划 v2 首个代码批；v2=oracle 计划+council 三席+GPT 浏览器咨询四路评审合成，27 项修订+三裁决；用户拍板 A=旧 schema 直接迁移/B=全量推进）：
  - **三出口改造（P0 结构缺陷修复）**：cdp.js 既有失败出口三类（throw→catch :2893 / `die()` :93 process.exit 直通 ~120 处 / cmd 内 return EXIT_ERR 散点 ~44 处）——`main().catch` 单点假设不成立（四路评审一致确认）。终案=exitCtx+`process.on('exit')` 同步发射（复用 :81 先例）+ `main().then(code!==0)` 兜底+信封去重；die() 改造保留原 stderr 逐字节；新增 `fail(code,msg,extra)` 冻结裸 die。
  - **`lib/envelope.js`+`lib/errors.js`（新）**：信封 `{envelope:{name:'chromeuse-cli/1',command,at},ok,code,message,retryable,hint,...}`（单行/≤800 截断/retryable 必带 backoffMs）；**码表 20 条**（v1 17 + E_LOCATE 定位链/E_IO 文件类/E_BUSY 预留 B7；E_FAIL→E_INTERNAL 对齐 kind；E_NOT_FOUND/E_AMBIGUOUS 细分码本批不发射留 B4/B5）；kind 权威+消息模式映射（codeFor）；非幂等动作 retryable=false（红线 #10 联动）；audit 接缝（默认空实现+setAuditSink 留 B3）。
  - **golden 双套 runner（#96）**：文本模式逐字节比对+JSON 模式结构断言（不锁字段序）；基线快照 10 条 8 条逐字节相同（唯 2 条 diff=有意新增的 --json 帮助行）已冻结 golden。
  - **stdout 单文档纪律（findings 1）**：占用探针设计——console.log 已输出后失败不再补信封（防现役 5 命令「报告后 exit 1」变双 JSON）；B1b 拒绝面落地后该窗口自然终结。
  - **文档**：新增 `references/mechanisms.md`（126 行，信封 schema+码表+三出口表+映射优先级+交接点；#4 budget 登记 200）；SKILL.md 文件地图+§1.2 信封指针（主干 258/300）。
  - **验证**：selftest **347 过/0 warn/0 fail**（基线 345→347，#96 七用例）；三出口验收 a/b/c 实录（die→E_USAGE 信封/fake 定位失败→E_LOCATE/throw→E_CDP/真实不可达→E_CONN retryable+backoffMs:3000）；非 --json 输出逐字节不变（8/10+2 有意变更）。
  - **边界**：不动 41 命令路由；12 命令迁移/29 拒绝面=B1b；audit 实装=B3。
- **同批 B0（N5 frames POC，实施批前置）**：评审前提被实测推翻——`Accessibility.getFullAXTree` **有 frameId 参数**（devtools-protocol master 实抓，约 Chrome 92~94 引入）153 实测逐帧取树 18 节点可用；主树不含子帧（Iframe childIds 空）/partial 对 iframe 元素不带子文档/页侧仅降级——N5 `--frames` 定案=Page.getFrameTree 递归+逐帧取树+DOM.getFrameOwner 挂接（零注入零降级；88 分叉=参数缺失降级或如实报不支持）。证据=tmpdata/capability-plan-261103/b0-frames-poc.md（56 文件）。

## V20261031018 — 2026-10-31 [doc]

- **Windows 复验归档收尾（V20261031017 修复三项用户端验证通过）**：用户回传 Windows 端测试截图（OCR 归档提取）——①#93 planCastPaths **FAIL→PASS**（跨平台语义断言生效）；②#87④ 像素法 **FAIL→WARN**（本机无可用 ffmpeg 正确跳过，守卫按设计工作）；③upload `--browser-path` 修复确认（POSIX/Windows 双标准、原路径直传浏览器进程注释在案）。【行尾治理】条目进度行补 Windows 复验证据；条目保留至行尾归位实跑（install.md 指引）+ #7 零 WARN 终验。焦点行同步（agent 侧无待推进高优先项）。
- 附：本会话读图走 openeyes 本地 RapidOCR 通道（双服务 down→heal 一条命令自愈双 up，符合预期路径）。

## V20261031017 — 2026-10-31 [fix]

- **Windows 复验 ISSUE×3 修复闭环（承接 V20261031016 上报批，ISSUE 栏清空）**：
  - **①upload --browser-path 跨端产品缺陷（bug/高）**：`lib/drive.js` `resolveUploadFiles` 重构——`skipLocalCheck` 分支**前置且零 resolve**（原样下发：`DOM.setFileInputFiles` 由浏览器进程解析），新增 `isBrowserAbsPath()` 双标准绝对校验（POSIX `/x` / Windows `^[A-Za-z]:[\\/]`），相对路径建连前报错（比静默 resolve 安全）；本地校验分支 resolve+statSync/accessSync 行为不变；SUB_HELP/SKILL upload 行同步「须浏览器侧绝对路径」。新增用例：POSIX 原样返回/Windows 盘符字面量不被改写（Linux 旧代码下此用例必红=跨平台护栏）/原文去重/4 种相对路径拒绝/默认模式回归。**跨端边界如实**：NAS 同端只能证不回归+护栏用例，Windows CLI→chrome-browser 容器实弹（contentOk）留 Windows 端复验。
  - **②#93 planCastPaths 测试假设缺陷**：期望值 POSIX 字面量→**语义断言**（basename 产物名+三产物同目录+改写告警+绝对性）；同族 p4~p6（rootDir/exists 回调）一并 `nodePath.resolve/join` 构造化；产品 cast.js 不动（resolve 本身正确）。
  - **③#87④ 像素法集成用例 ffmpeg 守卫**：选守卫方案（fake luma 注入需改产品 lib/scroll-shot.js 超授权清单）——与 ③ 同款 `ffmpegAvailable()` 守卫+WARN，但守卫分支**保留 fail-soft 真断言**（回落 DOM 吸附计划几何不变/无 px 吸附/有跳过 note）；模拟 ffmpeg 缺失全量 **345 过/4 warn/0 fail**（③④ 双 WARN 预期）验证通过，二进制已还原。
  - 验证：NAS 全量 **345 过/0 warn/0 fail**；CLI 闸门实弹（相对路径拒绝/绝对路径放行）；git 变更 4 文件=授权集。
  - 附（同会话）：仓库根 7 个 0 字节垃圾文件（`**使用规则（6`+`1.`~`6.`，16:41 shell 误解析 TODO 头部文本事故）已确认删除，无信息丢失。

## V20261031016 — 2026-10-31 [doc]

- **TODO 重建 ISSUE 栏：Windows 端复验 3 项待修（1 产品缺陷 + 2 测试缺陷）**：承接 V20261031015 部署后在本机 `%TEMP%` 副本跑全量（341 项 / 5 warn / 6 fail，NAS 同版 344/0/0），把 6 fail 收敛为 3 条可实施问题；其余 warn 定性为非缺陷（#7 已由 .gitattributes + 工作区归位解决、#19 非 git 仓位正常 SKIP、#84 已修为正确 skip）。
  - **ISSUE-1 `upload --browser-path` 被本地 `path.resolve` 污染（bug/高，跨端产品缺陷）**：`lib/drive.js:531` 先 resolve，`:536` 的 `skipLocalCheck` 分支 push 的仍是 `abs` → `/config/Downloads/x.txt` 变 `C:\config\Downloads\x.txt`；而 `:614 DOM.setFileInputFiles` 把 list 原样发给浏览器（`:513-515`/`:563` 注释明确"路径只在浏览器进程可见"）。Windows CLI + 容器浏览器（本机 config 即 `environment=linux`/`browserUrl=chrome-browser:9224`）**必现上传失败**；同端组合不暴露，故 NAS 全绿也测不出。自检锚点=`selftest/main.js:9964`。修复=skipLocalCheck 分支不 resolve（去重键用原文），本地校验分支保持 resolve；风险=`--browser-path` 相对路径语义未定义，建议要求绝对路径或直接报错。
  - **ISSUE-2 `planCastPaths --out` 断言写死 POSIX（bug/中，测试缺陷）**：`lib/cast.js` 的 `path.resolve(o.out)` 是正确产品行为（本地输出路径），但 `selftest/main.js:10679/10681/10684` 期望值写死 `/x/y/rec.mp4` → Windows 实得 `C:\x\y\rec.mp4`。修复=期望值改 `nodePath.resolve('/x/y/rec.mp4')` 或退化为 basename/stem 关系断言。
  - **ISSUE-3 #87 ④ 像素法用例缺 ffmpeg 守卫（bug/中，测试缺陷）**：`selftest/main.js:9093`（runScrollShot + `--snap-px`）依赖真实 ffmpeg 行剖面；同组 ③ 已在 `:8988` 有 `warn(87,'bin/ffmpeg 不可用…跳过…')`，④ 漏加 → 无可用 ffmpeg 环境误报 fail（本机 bin/ffmpeg 为 NAS Linux ELF，`ffmpegAvailable()` 正确返回 false）。修复=补同款守卫，或改 `deps.luma` 注入 fake 剖面（零外部依赖）。与 #84 修复（`selftest:8201`）同族，属漏网点。
  - **边界**：仅 TODO.md + CHANGELOG.md + VERSION.md；未改 `lib/`、`selftest/`、`tools/`。本机未在 live 跑全量（防 watcher 风暴），全部数据取自 `%TEMP%\cu-verify-1031` 副本；副本带 NAS ELF `bin/ffmpeg`（`bin/` 不入库）——正因 `ffmpegAvailable()` 已做真实探活，本次行为正确（走 skip 而非崩溃）。
  - **部署事实（同批记录）**：chromeuse V202610280004 → V20261031015 已装 Windows live（72 个 git 跟踪文件，hash 全绿，`install.js --check` 源=装机一致）；`openeyes`/`myopenclaw`/`subagent-ops`/`coding-workflow`/`mdrefactor` 无变化。另按 ISSUE-2（V202610280004 批）把 Windows 工作区存量 5 个 `w/crlf` 文件（`config/popup-rules.jsonc`、`lib/popup-guard.js`、`webapps/erp_demo_test/flows/sales-order-spot-lock.flow.json`、`webapps/{jd,taobao-tmall}/popup-rules.jsonc`）归位为 LF，`git ls-files --eol` 归零。

## V20261031015 — 2026-10-31 [doc]

- **用户终审三裁决落地**：①SKILL 行数守门改**分区计数**（council 留裁项）——主干（§〇~§三+§六）≤300 行、专题区（§四~§五）≤200 行，selftest #4 分段断言（现行主干 256/300、专题区 78/200；总额制 340 废止；专题 append 不再挤占主干预算），SKILL §0.1 守门句同步；②--help 完整同源化维持 TODO gate 登记（轻量同源断言已 V20261031014 落地）；③TODO 完成条目清扫=【console.* 归位】条目删除（其「口径单源」职责已由 SKILL §0.1 红线承接；完成态全档扫描零残留，开放条目 39 条=gate/观察/人工等待类）。
- 验证：selftest **345 过/0 warn/0 fail**；TODO 118/300。

## V20261031014 — 2026-10-31 [doc]

- **文档重构批（用户指令：cdp 主通道+21 新命令后按最新版本重构使用说明）+ mdrefactor V2 四步质量门全过**：SKILL.md 219→**334 行**（最长行 2259→667 字符）、README 142→145、install 172→173、playbook 554→549；selftest 344/0/0。
  - **重构主体**：使用说明按「cdp 主通道、MCP fallback」重组（§1.1 通道结论+14 行任务路由表→§1.2 命令速查 **11 场景组/41 命令一行式**（捕获/交互/页面生命周期/感知/视口模拟/自动化/录制/取证后处理/诊断入口/识别预处理/逃生舱）→§1.3 五步循环→§1.4 MCP fallback 速查）；专题收拢单一「§四 专题决策树」（### 专题一/二/三，append 规则入维护约定）；§0.1 维护约定（SUB_HELP 唯一准源+改命令七步落点含 CORE_FLAGS 登记+信息保全红线）；**--help 轻量同源落地（用户裁定）**=selftest #95 命令片段级旗标断言（SUB_HELP↔SKILL 双端）+CORE_FLAGS 反向覆盖（缺登记即 FAIL，负样本三步验证）；README 命令枚举指针化、install/playbook scroll-shot 细节回指化（单一归属地）；MCP 命名残留主通道化（轻探针=eval readyState、坐标兜底=click-at）。
  - **两道质量门+复验**：校验一（explorer 独立信息保全）=**零丢事实**（12 条弱化/轻偏差全回补：cast ffmpeg 精确串/标称帧率理由/「不假装成功」/五处限定语等）；council 三席评审（alpha/beta/gamma）→synthesis 清单 P0×5+P1×7+P2×4 全执行（分组重排零跳空矩阵=reroute-matrix.md、#95 断言假阴性修复、专题编号双轨收拢、CORE_FLAGS 静默失效双保险、排障表+媒体失败 2 行、文件地图补通道路由、红线号存量错两处同源修、playbook 速查表瘦身）；复验（verify-2.md）=三项全过（12/12 回补/重排零新损/三验独立重跑）。
  - **口径校正**：README「21 个新命令」实为 **20 新+1 旧**（scroll-shot 为 V202610210002/3 既有）——批次清单迁 `tmpdata/doc-refactor/21-new-commands.md` 留档。
  - **登记不修**（TODO 新条目）：F2/F3 计数口径四方不一致（文档面不写数量，源代码为准待触碰核定）、F10 description 余量 17 字符观察；**待用户裁定**：340 守门是否改「主干/专题分区计数」。

## V20261031013 — 2026-10-31 [fix]

- **快赢批：GQ-003/004/008 三条简单修复收口（TODO 三条目删）**：
  - **GQ-003 probe 对 newtab 误报**：`lib/cdp-core.js` 新增纯函数 `isNoFrameUrl`（chrome://newtab / new-tab-page / new-tab-page-third-party——不出帧内部页）；probe ③合成器命中即跳过+「不出帧属正常」注明，exit 0；实弹 newtab 跳过/about:blank 三通道全绿对照（411ms/14503B）。
  - **GQ-004 Windows browserUrl 默认值**：install.js 抽出纯函数 `resolveInitMode`（auto→win32=windows）+主流程 require 化（selftest 无副作用断言）；cdp-core 新增 `isNasServiceBrowserUrl/nasBrowserUrlHint`——建连失败且 browserUrl 主机名=chrome-browser 时 stderr 提示「--init-config windows 或手改 127.0.0.1:9222」（win32/非 win32 文案分支）；install.md 补 auto 平台语义。**边界：win32 实机未跑**（纯函数+fake-CDP+Linux 文案分支覆盖；Windows 端复验随 install.md「行尾归位与验证」清单顺带）。
  - **GQ-008 PowerShell JSON 传参**：`exec --params-file <path>`（与 paramsJSON 二选一、缺值/空/不存在/目录/JSON 非望建连前报错；读取器复用 page.js `readExpressionFile` 加 flag/label 参数，eval --file 零变化）；帮助注明「PowerShell 引号吞噬时优先 --params-file」；实弹 Runtime.evaluate 文件传参通过。**边界：PowerShell 5.1 Out-File UTF-16LE/BOM 未兼容**（按规格复用 utf8；真实反馈再补编码探测）。
  - 遗留：doctor 的 screenshotProbe 仍走裸通道（既有注释「诊断面保留原始信号」 deliberate，不改）。
- 验证：selftest **#94 组 7 用例（343 过/0 warn/0 fail）**；实弹 4 项（newtab probe/正常 probe/exec --params-file/hint 文案）日志=tmpdata/quickwin-20261031/。

## V20261031012 — 2026-10-31 [feat]

- **【cdp.js 最小交互命令集】二期第四批（功能批收官）：录屏 cast（GQ-010 F+GQ-001）**：新增 `lib/cast.js`（573 行）+ `cdp.js cast --duration <s> [--out] [--every-nth] [--quality]` 一次性命令形态（CLI 短连接架构，不做 start/stop 长驻对；duration 0.1~600s 上限防误录爆盘）：
  - **fps 按真实跨度归一（GQ-001 核心防错）**：`fps = 实际帧数 / 首末帧 timestamp 跨度`，标称帧率绝不参与（--every-nth 只控抽帧）；<2 帧 `insufficient-frames` 如实失败（报帧数/时长/帧间隔 min/median/max，不产假视频）；帧文件恒保留（ffmpeg 缺失/帧不足时唯一留档+离线等价命令）；异常 >60fps clamp+note。
  - **实弹抓到并修复两个真 bug**：①任务书/蓝本笔误的协议方法名 `Page.screencastStop` 在 153 直接 -32601（`exec` 复现留档）——实际为 **`Page.stopScreencast`**（finally 必停路径）；②2880×1349 奇数高度触发 yuv420p `height not divisible by 2`（exit 187）——加 `scale=trunc(iw/2)*2:trunc(ih/2)*2` 偶数护栏（最多裁 1px 无感）。
  - 复用单源：`scroll-shot.ffmpegAvailable()/ffmpegBins()`（未重写）、`ensureForeground`（hidden/读取失败才置前 fail-soft）；帧事件立即落盘+立即 ack（params.sessionId=帧序号与 flatten 会话撞名陷阱已注释）；清单 `chromeuse-cast/1`（含 fpsSource/spanMs/intervalsMs/probe）。
  - **验证**：selftest **#93 五组（342 过/0 warn/0 fail）**；实弹（Chrome 153）：动画页 5s=20 帧/间隔 242~257ms/**fps=4.219（span 4740ms metadata）**/mp4 99,226B+独立 ffprobe 复核（h264 2880×1348/avg_frame_rate 4219/1000）；静止页 3s=**仅 1 帧 insufficient-frames 如实失败**；**153 稀帧结论=与 88 同款**（静止仅变化时推帧，动画按变化节奏推）——GQ-001 归一设计在现代版同样必要；页签复原。
  - **88 分叉**：无（四件套 88 均存在，稀帧=能力差异非分支，文件头注释）。
- **二期功能批全部收官**（P0+P1 全量、P2 顺手 css）：7 命令（一期）+6（标签/eval）+5（视口/模拟/交互）+2（感知）+1（录屏）=**21 个 cdp.js 新命令**，GQ-010 六类缺口 A~F 全覆盖（trace/lighthouse/heap 按排期结论不补）。

## V20261031011 — 2026-10-31 [feat]

- **【cdp.js 最小交互命令集】二期第三批：感知类 a11y+css（GQ-010 B 族收口）**：新增 `lib/perceive.js`（926 行）+ `cdp.js a11y/css` 两命令——零 Input/零页面副作用（selftest #92⑤ 源码断言禁 dispatchEvent/navigate/setFileInputFiles 等）。
  - `a11y [--text|--selector] [--depth N] [--timeout] [--json]`：整树=`Accessibility.getFullAXTree` 单次原子调用（与 DevTools take_snapshot 同源，避免逐节点 partial 快照不一致）；定位子树=`getPartialAXTree(objectId)`（复用 locator objectId+backendDOMNodeId 过滤，跨同源 iframe 实测）；**超时必返**=send 逐命令超时+外层 `Promise.race` 双保险（`--timeout 1` 实测 183ms 返回 timedOut:true 不挂死，stderr 给 DOM/screenshot 替代通道）；**体积控制（G4 教训）**=--depth 默认 8（0=全量）+--max-nodes 输出上限 2000（大页 4200 按钮实测 2000 行+omitted:1617+partial/degraded 如实分级）；紧凑缩进行输出 `role "name" (x,y wxh) [F/C/D]`（非 MCP yaml 大树）；前 150 节点并发 DOM.getBoxModel 取框（bounds:null 如实标注剩余）。
  - `css [--text|--selector] [--computed] [--matched]`：computed 走页面侧 getComputedStyle（477 项实测）；matched 启用 CSS 域（origin/选择器/media/层叠，实测 4 条规则，上限 200 条）；实测坑修复=DOM.enable→getDocument→CSS.enable→requestNode 后 getMatchedStylesForNode（直取 nodeId 报 -32000）。
  - **88 分叉（成本裁定就地处理）**：88 getFullAXTree 无 depth 参数（忽略额外参数）→悬空 childIds 判据识别服务端未裁剪→客户端裁剪（depthMode:'client' 标注）；协议显式拒绝则无参重发（paramFallback）——注释入码无登记项。
  - **验证**：selftest **#92 组 5 用例（341 过/0 warn/0 fail）**；实弹（chrome-browser 153）：depth 8/3/0=27/12/37 节点、--text 子树 2 节点+多候选 ambiguous 不猜 exit 1、1ms 超时必返、1200/4200 按钮大页三档行为（2000+truncated / 0+timedOut / 200+partial degraded）、css 双模式+iframe、targets 复原（证据=tmpdata/cdp-p3-live/ 70+ 文件）。

## V20261031010 — 2026-10-31 [feat]

- **【cdp.js 最小交互命令集】二期第二批：视口/模拟/交互补充（GQ-010 P1 族收口）**：viewport/emulate/dialog/upload/drag 五命令（执行=熔断重派批：前 agent 静默挂起取消、产出经盘点为完成品 340/0/0，重派补实弹+修 3 个真机问题）：
  - `viewport [WxH] [--dpr] [--reset]`（lib/page.js，Emulation 页面环境域与 drive.js 红线身份隔离）：恒 `dontSetVisibleSize:true` **绝不动真实窗口**（不带该位会改窗口且 clear 无法还原）；**命令结束自动还原**（session 断开 Chrome 自清理，实测外部读回无残留）；stdout 前/中/后三段读数；文档写明与 flow `_meta.viewport` 三态策略互不干涉（本命令=操作者显式意图，等同 MCP resize_page 场景）。
  - `emulate --ua/--media [--reset]`：施加+双清（153 无 clear 命令→`-32601` 回落 set-empty；88 若有 clear 直接走，行为一致）；UA/print 实测+还原复验。
  - `dialog [--auto] [--text] [--wait]`：短连接一次性语义（CDP 无法查询挂起态/常驻自动处置，限制入文档）——queryOnly 400ms 观察窗如实 exit 1；预埋监听用法 843ms 捕获 alert+accept+页面存活。
  - `upload <file> [--into-*] [--browser-path]`：`DOM.setFileInputFiles`（CDP 官方注入通道非 DOM 合成事件）；**注入后读回 files[0].size 防假绿**（0 字节 exit 1）；非 file input 拒绝；`--browser-path`=容器隔离逃生门（路径仅浏览器进程可见时跳过客户端预检、仅验证读回——**环境事实入文档**：本 homelab chrome-browser 与 opencode 容器无共享挂载，默认路径必然 exit 1 属防假绿正确行为，实际使用走 NAS 宿主 `configDownloads/`+`--browser-path`）。
  - `drag`（lib/drive.js）：Input 域 hover→press→**N 段插值 move（硬带 button:'left'+buttons:1 位掩码——G3b 反证缺位全链退化普通 mousemove）**→release；**单源复用**=lib/flow-engine.js drag 原语改为消费 `drive.DRAG_TRACE/planDragPath`（G3 实证 5 段/90ms/80ms，CLI drag 与 flow drag 同函数同参数）。
  - **验证**：selftest **#91 组 7 用例，340 过/0 warn/0 fail**；实弹 **27/27 PASS**（21 主链+6 upload 补充；viewport/DPR2 实测+还原、UA/print、dialog 双形态、upload 22B 注入 size 复核、drag 5 段插值 DROPPED+dragstart/enter/drop/dragend 全事件、targets 无残留；日志=tmpdata/interact-2b-live-final/）。
  - **88 分叉**：无特判（全长期协议）；clear 命令 153/88 差异以回落兜底覆盖；未实机 88（沿用待验证条目）。

## V20261031009 — 2026-10-31 [feat]

- **【cdp.js 最小交互命令集】二期第一批：标签管理+eval（P0 收口）**：新增 `lib/page.js`（336 行实现单源，Target/Page/Runtime 域——独立于 drive.js 因其红线身份=「全 Input 域真实事件」，生命周期混写会污染单源声明）+ `cdp.js` 五子命令与 targets 增强：
  - `goto <url>`：协议白名单（http/https/file/about/chrome 过；javascript/data/ftp/chrome-extension/缺协议拒）；**双信号等待**=Page.frameNavigated 主 frame 提交闸门（防「导航未提交读到旧页 readyState=complete」假完成）+loadEventFired+readyState 轮询兜底（Page.enable 失败退化纯轮询如实标 `pageEnabled:false`）；--timeout 总预算 500~600000ms；errorText 如实 exit 1。
  - `new [url] [--background]` / `close <id|--all-but <id>|--match <kw> [--yes]>` / `select <id>`：close 计划器三选一形态校验+仅 page 型 target；**裁决语义**=唯一命中直接关、多命中无 --yes 只列候选 exit 1 零关闭、--all-but 批量破坏面必须 --yes 且逐条列出；id 支持唯一前缀（多前缀不猜）；new/close stdout 恒回显完整 targetId（可 sed 配对=「谁开谁关」页签礼仪可脚本化）。
  - `targets --json`：`chromeuse-targets/1` 投影（id/type/title/url/attached 布尔+total/attachedCount/byType），human 输出不变。
  - `eval [--file <path>]`：文件版避 shell 引号（多行原文/空/不存在/目录全处理）；awaitPromise 支持异步 IIFE；异常打印描述+行号 exit 1。
  - **验证**：selftest 新增 **#90 五组**（白名单/关闭裁决/投影与文件读取/fake-CDP 含非法协议零 CDP 副作用/CLI 17 条建连前非法值+源码锚点+页签礼仪）——**339 过/0 warn/0 fail**；NAS Chrome 153 实弹 14 项 PASS（new→targets→goto（含 https 重定向+chrome://version）→select→eval --file→close --match 两候选不猜→--yes 批关→--all-but 拒绝→前缀关；targets 10→10/pages 2→2 复原；日志=tmpdata/cdp-p2/live-acceptance.log）。
  - **88 分叉**：无（全 Target/Page/Runtime 88 已存在域族，未用实验 API/94+ 特性）。
  - **已知边界**：goto/eval 的 --target 沿用 cdp-core.resolveTarget（完整 id/url 子串/title 子串，不支持 id 前缀——改公共解析影响全部子命令，本批未擅动；close/select 自带解析器支持唯一前缀）。

## V20261031008 — 2026-10-31 [doc]

- **【行尾治理】Windows 端收尾准备（NAS 侧）**：install.md 新增「Windows 端行尾归位与验证（一次性）」节（L120-158，132→172/260 行）——①`git ls-files --eol | Select-String 'w/crlf'` 列待归位（预期≈根文档/webui-ext js/skills 内 5 旧检出）；②定向归位 PowerShell 管道（tab 解析实测依据+打印清单+`Read-Host y` 确认闸+`Remove-Item`+`git checkout --` 定向重检出；⚠ 禁整树 `checkout-index -a -f` 警示保留；`w/mixed` 变体提示）；③复验空清单；④Windows 端复验清单表（#7 零 WARN/#14/#61 全绿/#22 CRLF 闸/#84 PASS 或探活 WARN+`scroll-shot --help` 含 `--snap-cuts`；预期剩余 WARN=#19 非安装位与浏览器依赖跳过项）。**归位实跑在用户 Windows 端**（PowerShell 块=Linux 侧语法审查级 L2，首跑先核对清单再确认）；实跑全绿后【行尾治理】条目即可关闭。
- 验证：selftest 338/0/0；install.md 172/260；#9/#84/#87 文档锚点未受影响。

## V20261031007 — 2026-10-31 [feat]

- **log 终端回显能力（用户裁定 A：恢复长任务实时 stderr 进度，闭环 V20261031006 归位批的行为变化声明）**：`lib/log.js` 新增选项式回显——`log.info/warn/error(…, { echo: true })` 该条**写盘后同步打 stderr 单行**（`[tag] msg`，信息量=迁移前 console 行，回显独立于写盘成败、失败 try/catch 吞）；**默认全关**——不传 opts 的既有调用零行为变化（flow-engine 等既有 log 用户不受影响）；`CHROMEUSE_LOG_ECHO=0` 全局安静门（仅识别 `0`，其余值视为开启，头注释已写明）。
  - **echo 标注 24 处**（运行期进度/告警类）：scroll-shot 17（逐段截图进度/切点吸附/像素法位移/空白自检/段成败等）+screenshot 6（视口覆盖/重试/诊断矩阵/降级/退避）+record 1（非 JSON payload）；**终态/摘要类 4 处不标**（滚动还原×2/视口还原×2——CLI 最终输出已兜底，避免双份）；`--no-foreground` 安全强告警保持原 console+log 双写不加 echo（避免双打）。
  - **验证**：selftest 新增 #89（echo:true 才回显/未标注零回显/同条落盘/=0 静默仍落盘）——**338 过/0 warn/0 fail**；五命令 10 份输出字节级零 diff 复验（echo 默认关对 help/usage 路径零影响的契约证明）；回显实证=lib/screenshot 真实标注点 on/off 对照（stderr 有/无该行、log 恒落盘）。
  - **console.* 归位线全部闭环**：归位批（28 迁/270 留/1 例外）+回显批（24 恢复可见性）——三层口径固化为 TODO 口径单源条目，新增代码按此执行。

## V20261031006 — 2026-10-31 [refactor]

- **console.* 按业务语义归位 + 单源绕过审计（用户 2026-10-31 提出，复查批执行）**：全量 299 处台账三层分类——**①迁移 28 处**（lib/scroll-shot 19（含 #86③ 安全契约 console+log 双写保护）/lib/screenshot 8（3 处与既有 log.warn 合并去重）/lib/record 1）→ log 模块（tag+info/warn/error 分级，落 `log/chromeuse.log` 日轮转）；**②保留 270 处**（CLI stdout/stderr 程序输出接口：cdp.js 215/record 长驻前台 32/events 13/cdp-core 4/collector 3/install 2/scroll-shot 安全契约 1——record 前台 15 行经裁定归②：实时操作反馈=CLI 界面语义，多数已 log 双写）；**③例外 1 处**（lib/paths.js:34 补注释：log→paths 单向依赖不能反向 require，模块加载期一次性 stderr）。log 能力盘点=info/warn/error/debug+tag+CHROMEUSE_LOG_DEBUG+日轮转，覆盖所需零扩展。
  - **同类单源绕过当场修 11 处**：lib/time.js 新增 `sleep(ms)` 通用延迟单源（原 7 文件各自复制 setTimeout 包装——8 处换用+record 内联 300ms 延迟 1 处）；paths 单源 2 处（record RECORDER_SRC、cdp.js webapps 路径改 `paths.SKILL_ROOT`）；config 直读审计=零绕过。
  - **登记不修 6 项**（低价值/行为变更类，TODO 独立条目）：install.js ts() 时间戳（行为变更待裁定）/num、pad2、ts 适配器重复（无既有单源或可接受）/log 终端回显（独立待裁定）/config.js 自身路径（非绕过，关闭）。
  - **⚠ 行为变化如实声明**：lib 层长任务逐段进度（scroll-shot 逐段截图等）原 stderr 实时可见→现仅落日志文件+最终 CLI 摘要（终端运行期静默）；CLI 契约零 diff 证明覆盖 help/usage 类 5 命令 10 份输出字节级一致+退出码一致，**实跑过程输出属预期变化**——「log.echo 终端回显」已立条目待用户裁定 A（恢复实时 stderr）/B（维持）。
  - **验证**：selftest 迁移前后均 **337 过/0 warn/0 fail**（中途 #86 一次失败=stderr 安全契约断言命中，恢复双写后全绿——契约保护生效实证）；`node --check` 11 文件过；log 实写烟测+selftest 实跑已在 log/chromeuse.log 产生 INFO/WARN 行（迁移生效实证）。

## V20261031005 — 2026-10-31 [feat]

- **【cdp.js 最小交互命令集】一期落地（cdp 主通道战略首个落地批）**：新增 `lib/drive.js`（507 行实现单源，零依赖零 console.*）+ `cdp.js` 7 子命令——`click`（--text 复用 locator 文本查找/--selector/--point 三定位，多候选 ambiguous 不猜+`--nth`）/`click-at`/`type`（默认 Ctrl+A+Delete+insertText 覆盖，--append）/`key`（KEY_TABLE 键码单源+组合键）/`hover`/`wait --text`（节距/超时参数化）/`console`（**方案 A=短连接监听窗口**：Runtime+Log 双源、±50ms 去重、`--listen 0` 回放连接前缓存（Chrome 153 实测）、报告恒落 `tmpdata/events/console-*.json` chromeuse-console/1；否决 watch 集成=双死看门狗生命周期耦合）。全部走 Input/Runtime/Log 域真实事件（isTrusted 红线），`--uid` 在 raw CDP 不可解析→显式拒绝并指路 --selector/--text。
  - **顺手修假绿缺陷（实弹发现）**：`lib/locator.js` hitOk 是 iframe 帧内 elementFromPoint 判定——iframe 仅上沿可见时候选绝对坐标落顶层视口外，点击**静默无效**；drive 层 `locate()` 加顶层视口闸门（viewportInfo+pointInViewport）+越界 scrollIntoView 一次+重采+仍外报 `out-of-viewport` 不盲点。
  - **文档**：SKILL.md 通道结论改写（L85「cdp 为主通道、MCP 只作 fallback——通道互相兜底而非二选一」，2026-10-31 用户裁定）+工具面新行；红线 #1 表述扩为「cdp.js Input 域或 MCP 原生工具」；install.md 快速上手补交互命令（217/320、132/260）。
  - **验证**：selftest 新增 **#88 六组**（键码表/参数归一/多候选+视口闸门纯函数/console 归集器/fake-CDP 动作序列/CLI+文档+红线源码锚点）——**337 过/0 warn/0 fail**；NAS chrome-browser（Chrome 153）实弹链全通：click --text→wait（真轮询 1238ms/5 次）→type（焦点复核）→key Enter→hover（mouseenter 真实事件）→console（缓存回放+窗口内新增 7 条）→跨 iframe 命中→多候选不猜→双击；targets 计数复原（证据=tmpdata/drive-live/live-*.log 6 份）。
  - **88 分叉结论（成本裁定执行）**：**无代码分叉**（全 Input/Runtime 域，蓝本同款已在 88 验证 8 批）；唯一待验证=console 历史回放在 88 是否可用（不行则 --listen 先开窗口；长历史走长驻 hook 属后续）——已记条目，随 Windows 端机会验证。

## V20261031004 — 2026-10-31 [doc]

- **Chrome 88 兼容分组补充裁定落 TODO**（修订 V20261031003 的「后续补充级」表述）：88 兼容=**成本决定分组**（用户 2026-10-31 补充裁定）——【cdp.js 最小交互命令集】实现时评估，兼容简单→并入一期落地（一期交互类走 Input/Runtime/Page 域，gq-drive 已在 88 上 8 批验证，成本预计低），分叉麻烦→剥离至【旧版 Chrome（88）】条目后续做（该条目重新定位=88 专属分叉承接位，非无条件后续）；两条目+焦点行同步。
- 验证：selftest 336 过/0 warn/0 fail；TODO 126/300。

## V20261031003 — 2026-10-31 [doc]

- **通道战略与 Chrome 88 双裁定落 TODO**：①用户裁定确立「**cdp 为主、MCP 只作 fallback**」长期通道战略——【cdp.js 最小交互命令集】中→**高**（提级依据=用户裁定显式；SKILL.md 通道结论随一期落地同步改写），分两期=一期交互类（click/type/key/hover/wait）+console 取证、二期标签/感知/视口/录屏低频类；②Chrome 88=公司工具套件内置浏览器，需兼容但非当前重点——【旧版 Chrome（88）MCP 不可用】条目标注「后续补充级」（主线按 NAS chrome-browser 快速实现，88 兼容不阻塞）；焦点行同步（下一 agent 主线=最小命令集一期）。
- 验证：selftest 336 过/0 warn/0 fail；TODO 126/300。

## V20261031002 — 2026-10-31 [doc]

- **补投材料第二轮提取（chromeuse-issues.md GQ-001~011 + tmpdata/test-tools/ 工具集，同 fixer 会话第三轮）**：
  - **TODO（110→126 行）新开 4 条 + 并入 1 条 + 互证 2 条**：新=【cdp.js 最小交互命令集（去 MCP 主通道）】（承接 GQ-009/010/011——GQ-010 六类缺口 A 交互/B 感知/C 标签/D 取证/E 视口/F 录屏逐类收录+P0/P1/P2 排期结论；参考实现锚 `tmpdata/test-tools/gq-drive.mjs` 234 行实测）／【cdp.js probe 对 chrome://newtab 合成器误报超时】（GQ-003）／【Windows 实例 config.jsonc 默认 browserUrl 指向 NAS 服务名】（GQ-004）／【cdp.js exec 在 PowerShell 下 JSON 传参易失败】（GQ-008，`--params-file` 方向）；并入=【旧版 Chrome（88）MCP 不可用】扩写（GQ-001/002/005/006/007 同族失效细节：WebCodecs 94+ 门槛、layui iframe a11y 10s 超时、Chrome 88 screencast 仅变化时推帧时间轴不可信；绕过=screen-rec.ps1/chrome-cast.mjs/gq-drive.mjs）；互证=【虚拟化网格】←GQ-011.1、【disabled 诊断】←GQ-011.4。优先级校准：MCP 失效族/最小命令集维持**中**（有 raw-CDP 绕行，未照抄材料 GQ-006「最严重」升格——符合 TODO 头注「高=无绕行」规则）。
  - **webapp.md（143→144 行）**：+标准布局行（顶部 tab→工具条→状态 Radio→上表双击行→下表→底栏状态机）；环境行扩展（共享 cookie 登录态/Ctrl+- 缩放绕过窄窗遮挡）；+成分区独立面板行（23 元素 `input#input60299~60321`、非网格列、≤1600 待复核）。
  - **材料口径差异（不采纳，留档）**：HOWTO 称应用面板入口「Dock 第 3 个蓝色 2×2 图标」与 webapp 既有 `#showAppList` 第二项（2026-10-19 用户裁定+实测，红线级）不一致；HOWTO「单域同名 app 可用桌面图标」与既有「必须走面板路径」适用范围不同——以 webapp 既有口径为准，HOWTO 为测试期临时手册不升格。
  - **reference 补充建议（留档待实施批裁定，本轮未动 references）**：①install.md：Windows `--init-config windows` 提示（GQ-004）/Chrome<96+MCP 改 cdp.js（GQ-002）/Chrome<94 录屏改 ffmpeg gdigrab（GQ-001）；②playbook：raw-CDP 驱动手法（`/json/list` 稳定 target/Input 域真实事件/跨 iframe 递归+逐级偏移/空白单元格 keyin/zoom 绕过）+虚拟化网格取证纪律；③facts.md：Chrome 88 实测命令矩阵/MCP 1.12 pageId 漂移/WebCodecs 94+/newtab 误报；④SKILL.md：通道选择结论「cdp 为主、MCP fallback」（GQ-010 首注）。
  - **材料事实勘误**：GQ-010 记 gq-drive「约 300 行」实测 234 行，TODO 采用实测值。
- 验证：selftest **336 过/0 warn/0 fail**（#21 应用台账全绿）；行数守门 TODO 126/300、webapp 144/150；tmpdata 材料（含新投 chromeuse-issues.md 与 test-tools/）零改动。

## V20261031001 — 2026-10-31 [doc]

- **2026-10-29 示例ERP实测批（T20261027001）材料整理入册**（材料=用户投递 `tmpdata/test-runs/2026-10-29/`，591 文件/210MB；执行模式=用户指令子代理实施+编排方只做规划调度与验收）：
  - **chromeuse 待优化项 → TODO**（103→110 行）：新增 3 条正式条目（均带材料锚点+修复方向）——【旧版 Chrome（88）MCP 不可用：版本闸与 raw-CDP 降级】（list_pages 恒空/pageId 漂移 8 批稳定复现；raw-CDP 逃生舱 gq-drive.mjs 8 批约 90 用例有效性实证；方向=Browser.getVersion 版本闸+cdp.js 最小命令集+install.md Chrome 88 矩阵）／【虚拟化网格（react-data-grid）读数与定位支持】（离屏列空串≠空值、header DOM 序≠视觉序、首屏 50 行；方向=grid 观察/定位模式+取证纪律标注）／【候选/失败诊断补 disabled·readOnly·aria-disabled】（枚举下拉 0×0 误诊链实证；方向=collectCandidates 增可编辑性字段）；既有【CDP 通道失效】条目补进度行（Chrome 88=独立失效面，与随机失效不同源）。
  - **erp_demo 通用知识 → webapps/erp_demo_test/webapp.md**（106→143/150 行）：新增五节「网格与控件交互／虚拟化网格取证／状态机·提示与弹层／查询·报表画面／数字域日志（域管理）」，全部标注「2026-10-29 实测（B 批）」证据等级（本方实弹，高于既有「观察性」）；既有行细化 7 处（last-verified→2026-10-30、环境差异 1820×1046、前置条件链④disabled、Dock 坐标禁写死、lookup 7×12▼/双击行/只读过滤框、采购提取前置、属性选择器引号纪律）；已知坑 +2（ISSUE-15 成分 0 值被当空值／ISSUE-16 物料过滤四路失效，均标「版本相关」+互指应用 TODO INBOX）。
  - **16 条业务/产品缺陷 → webapps/erp_demo_test/TODO.md INBOX**（28→45 行）：T20261027001 台账逐条**自足**归档（现象/关键数值/状态，防 tmpdata 清理后失证）；状态口径忠实原文不升格（ISSUE-15 P1/P0 双记；ISSUE-04/12 已澄清关闭；ISSUE-01 复核更正为控件 disabled 只读）。
  - **边界与筛除（如实）**：按「通用 erp_demo」口径未写入的应用细节=成分区 23 元素面板/应收报表 27 列列序/提取对账单同名按钮坐标（如需再议提额）；**材料缺口**=SUMMARY §七 引用的 `chromeuse-issues.md`（chromeuse/MCP 专项 10 条+能力缺口表）未随材料提供（.work 为空）——用户已裁定补投后整理，到位后开第二轮提取；tmpdata 材料本轮**保留**（在册条目证据锚点依赖，随条目闭环再清）。
- 验证：selftest 336 过/0 warn/0 fail（#21 应用级台账断言全绿）；行数守门 TODO 110/300、webapp 143/150；材料零改动（git status 三文件=授权集）。

## V202610280006 — 2026-10-28 [fix]

- **ISSUE×4 自主推进批（用户令「从易到难自主推进」；承接 V202610280004 上报批，①②④闭环、③NAS 端落地）**：
  - **ISSUE-1 修复：CRLF 致 matchers 提取恒 null**：`lib/matchers.js` 正则 `\n`→`\r?\n`（附原因+「JSON.parse 允许尾随 \r 已实测」注释）；断言账本逐行 `split(/\r?\n/)`。**同类假阴性 15 处同批归一**（selftest/main.js 内 VERSION/TODO/install.md 逐行、webapps TODO 与 webapp.md 表格解析、JSONL 日志、lib/screenshot.js 与 lib/scroll-shot.js 结构断言切片前 `\r\n`→`\n` 归一——修 `indexOf('\n…')` CRLF 恒 -1 断言永过）；「取首行当错误消息」类容错 `split('\n')[0]` 约 47 处保留不动。#22 补 CRLF 回归闸（测试 md `\n`→`\r\n` 后提取非 null 且 urlPatterns 与 LF 全等；旧正则同输入命中=false 证明闸有效）。`references/facts.md` 新增「跨平台行尾口径」节（119/200）。残留（低风险未动）：`tools/cdp.js` 3 处解析未归一但无假阴性（下批顺手统一）。
  - **ISSUE-4 修复：ffmpegAvailable 误判 + #84 守卫**：`ffmpegBins()` 平台后缀（win32 `.exe`，仍 bin/ 单点真源——**不做 PATH 回退=2026-10-28 用户裁定**，注释入码）；`ffmpegAvailable()`=existsSync AND `spawnSync(bin,['-version'],{timeout:5000})` 探活、进程级缓存；#84 加 `!r.checked → warn(reason)+return` 守卫（try/finally 保清理）。探针实证：假 ffmpeg（existsSync=true 探活败）判不可用且 reason 不被吞（旧写法 TypeError 已复现对照）。
  - **ISSUE-3 修复：TMPDATA_DIR env 覆盖（watcher 风暴根治前提）**：`lib/paths.js` `CHROMEUSE_TMPDATA_DIR`（绝对路径生效/空未设=默认/非绝对=回退+stderr 一行 warn；9 派生目录 15 处消费方自动跟随；LOG_DIR 独立根不随覆盖——低频追加可接受）；selftest 11 点同源化（7 处写盘 `DIR/'tmpdata'`→`paths.TMPDATA_DIR`+3 处存量 flow 扫描+1 处 VIDEO_DIR 断言，grep 复核硬编码清零）；install.md 补覆盖用法+风暴数据（131/260）。验证：env 模式全量 336/0/0 且骨架 tmpdata **快照零新增**、覆盖目录有真实产出（含子进程产物=env 自动透传实证）；默认模式全量 336/0/0 不回归；非法值探针回退+warn 恰一行。**边界**：env 模式下 selftest 不扫骨架存量 tmpdata diagnostic flow（同源化直接语义后果，合理）；风暴抑制端到端效果待 Windows 端/live 实测（本环境骨架不在监视根，未复现风暴本体=上报端 L2）。
  - **ISSUE-2 NAS 端落地（用户裁定=两行全加）**：根 `.gitattributes` +`*.js text eol=lf`/`*.md text eol=lf`+`mihomo/ui/** -text` 排除（实测 i/none=74=mihomo 73+nginx/READMD.md 单行 no-op 未排除）；`git add --renormalize` **零 eol diff**、crlf/mixed blob=0、排除 attr 生效。**剩 Windows 端归位**（pull 后 `git ls-files --eol` 筛 `w/crlf` 定向重检出+#7 零 WARN 验证）——TODO 条目保留至 Windows 端闭环。
  - **两裁定落地记录**：裁定一（ffmpeg 不回退 PATH）=真源单点，注释入码；裁定二（行尾两行全加）=属性落地+排除规则。
- 验证：骨架 selftest 三轮（lane 验收+env 模式+默认模式）均 **336 过/0 warn/0 fail**；行数守门 facts 119/200、install 131/260、TODO 103/300。live 同步：`node install.js` copy（65 文件，V202610280006）→ live 以 `CHROMEUSE_TMPDATA_DIR=/tmp/opencode/cu-live-tmp`（监视根外，本修复自身应用）跑 selftest **335 过/1 warn/0 fail**（warn=#19 git SKIP 预期位）且 **live tmpdata 1318→1318 零新增**——env 覆盖在监视根内环境生效实证。
- 执行方式：lane-A fixer（①+②）+ lane-B fixer（④）+ orchestrator（③与收口）；lane-B 行号漂移风险以 grep 语义定位规避。

## V202610280005 — 2026-10-28 [feat+doc]

- **F15 scroll-shot 切点吸附空白带落地（TODO 最高优先；设计=V202610220001 §② + 语义锚点 webapps/wechat-mp/webapp.md L77 他方实测）**：固定 step 硬切把标题栏/产品卡拦腰截断 → 切点吸附图文间空白带，两级：
  - **DOM 法（默认开）**：分段前**一次只读 evaluate** 取元素 rect → `blankBands()`（rect 并集的补集=空白带）/`snapPoint()`（窗口 ±`--snap-window` 默认 180 CSS px 内取**距原切点最近**合格带中点，最小带宽 12px）→ `snapCuts()` 顺序推进（`max=Math.min(prev+chunkCss, doc−lastMin)` 构造式保证约束）。
  - **像素法兜底（`--snap-px` 显式开）**：DOM 无合格带的切点，对已落盘段图**复用 F13 行剖面管线**（`scale=1:H:flags=area,format=gray`）在段尾找连续 ≥12 行亮度 ≥247 带 → 滚动推进重排尾部（`applyPxCut` 纯函数不改入参）；ffmpeg 缺失/失败 fail-soft 回原切点。
  - **三条 clamp 硬约束（中途补强定稿：①段高 ≤ chunkCss ②相邻段 ≥ viewport/4（退化配置 min(viewport/4, step)）③切点 ∈ (0, docHeight)）**：语义依据=L77「只向短方向吸附（不为吸附把段拉长），终点 clamp 到文档高」；①的落地解读=**段高不超 max-chunk 计划值**——`step==chunkCss` 时等价只能上移，`step<chunkCss`（视口小于 max-chunk，常态）允许段在 step→chunkCss 间增长（若应收严为 ≤step 待用户复核，fixer 断言台账已标）。违反即抛错，主流程 try/catch **fail-soft 回原切点**（吸附是增强，绝不阻断截图）；同口径四处单源同步：SKILL.md L26 旗标摘要 / install.md L42 / SUB_HELP ⑪（`--help` 不漂移）/ 模块头注释。
  - **旗标与清单**：默认开（`--no-snap-cuts` 关）/ `--snap-window`（32~512 整数校验）/ `--snap-px`；`--dry-run` DOM 法照常展示吸附计划（像素法无图不跑如实记）；段级 `snap:{from,to,shift,method:dom|px|none}`（形状恒定）+ 顶层 `snapConfig:{enabled,windowPx,pxFallback}`。
  - **验证**：selftest 新增 **#87 六用例组**（①blankBands/snapPoint 纯函数 8 场景 ②snapCuts 顺序推进 12 场景含三约束 `inv()` 全量断言 ③px 纯函数/真实 PPM 行剖面/fail-soft ④runScrollShot 集成 dry-run+实跑+旗标 ⑤CLI 非法值建连前报错 ⑥红线：只读 evaluate/恰一次 rects/默认开/零依赖/L77 源码与文档锚点）——全量 **336 过/0 warn/0 fail**；实弹：DOM 页 3000px 4 段 `ΣcssH=docH`、段1 `snap{from:900,to:960,shift:31,method:'dom'}`、末段 method:none（tmpdata/f15-live/f15-live2.json）；像素页 1100px 段1 `shift:-139, method:'px'`（上移=只向短方向实证，tmpdata/f15-px/f15-px2.json）；target 用后关闭、targets 计数复原。
  - **边界（如实）**：真实公众号长文吸附命中率仅合成页验证（他方 140 篇结论未替我方复跑，webapp.md 待复验清单在案）；吸附期间文档高度若变化，doc-clamp 以跑前测量为准（懒加载场景由预热稳定高度兜底）。
- **F17/F18 wechat-mp 手册快赢（纯文档，他方 2026-10-23 第三轮复盘实测入册）**：webapp.md 新增两节——「元数据提取兜底链（F17）」：标题链 `#activity-name`→`meta[property="og:title"]`→`document.title`、账号名链 `#js_name`→`og:article:author`→页面他处、批量修复=逐篇读 og:title 回填（实证 8/48 篇标题落「微信公众平台」）；「日期规范化纪律（F18）」：`^\d{1,2}月\d{1,2}日$`→按抓取年补全、`^(昨天|今天)\sHH:mm$`→按抓取日折算、纪律「规范化前不做日期比较」（实测直接比较解析成「0年0月0日」）。全部标注证据等级「他方 2026-10-23 实测」未升格为我方结论；待复验清单 +2 行；头部沿革行同步；F15 工具面指针从「尚未内置」更新为已内置（92→119 行，150 warn 线内）。
- **Windows 端 ISSUE×4 评估处置（承接 V202610280004 上报批）**：4 项逐条评估**均定性为真实待修复**，已转 TODO「agent 遗留项」正式条目（按收益排序：CRLF matchers 1 行修复【简单|bug|高】→ TMPDATA_DIR watcher 风暴【复杂|bug|高】→ ffmpegAvailable 误判+#84 守卫【简单|bug|中】→ 行尾治理【简单|增强|中】），ISSUE 栏**整节清空**（原始六段分析由本批与 git 4042abd 留痕）；ISSUE-2 方案二选一按上报端定量采纳「两行全加+mihomo `-text` 排除」为推荐（blob 已全 LF 零内容 diff，实施时若有异议再收）；ISSUE-4 可选增强（Windows 回退系统 ffmpeg）**待用户裁定**未动。
- **TODO 对账**：F15/F17/F18 三条目完成删除（本批交付）；「当前焦点」改版为**条目指向式**（每行指向分区条目标题+状态分类：agent 最高优先/人工等待·ERP 捆/人工等待·分散/agent 挂账/环境注记；2026-10-28 用户要求「可观察到焦点对应哪些遗留项」，之后批次沿用）；chatgpt 定位符修复条移出焦点（已稳定）；V202610280003 收口复核=无遗留（state.md/TODO.md.bak/四问视图零残留、git c4599c1）。
- 验证：`node selftest.js` **336/0/0**；行数守门 SKILL 214/320、playbook 554/560、facts 112/200、install 129/260、TODO 108/300（含 ISSUE×4 转入条目）、wechat-mp webapp 119/150。live 同步：`node install.js`（默认 copy 模式）→ live selftest 复跑 **335 过/1 warn/0 fail**（warn=#19 仓库 .gitignore 检查 SKIP，live 非 git 仓预期位）。

## V202610280004 — 2026-10-28 [doc]

- **新增 TODO「ISSUE」栏（Windows 端跨环境/部署缺陷归档，4 项带六段分析）**：用户裁定"当前端一般只读，遇问题才写 TODO/issue，TODO 实质改动在 NAS 端"——本批为一次性上报批，不改任何运行代码。
  - **ISSUE-1 CRLF 致 `extractMatchersMd` 恒 null（bug/高）**：`lib/matchers.js:118` 正则 ``/```jsonc\n([\s\S]*?)```/g`` 硬编码 LF，CRLF 文件恒不命中 → 全部 `webapp.md` matchers=null；生产面波及 `flow-engine.js:1529-1536` tabHygieneWarning 与 `:1620/:1621` runner.appMatchers（回放安全阀退化为"缺失即跳过"）；自检连带 #14/#61。触发面实测量化=`webapps/erp_demo_test/webapp.md` CRLF 106 / 裸 LF 0；#22 用内联 LF 字符串故长期不红。修复 1 行 `\r?\n` + #22 补 CRLF 变体回归闸；另登记 `selftest/main.js:7718` 同类假阴性隐患（`indexOf('\n  }\n}')` 在 CRLF 下恒 -1 → 断言永过）。
  - **ISSUE-2 行尾治理（增强/中）**：核实 `.gitattributes:6` 已有 skills/** `eol=lf`，且**233 个 `.js`/`.md` 全部 LF 入库（CRLF blob = 0）**——故"新增 `*.js`/`*.md text eol=lf`"是零内容 diff 的安全动作；真实缺口是工作区存量（skills 内 5 个文件 + 根文档/webui-ext js 未覆盖），属性只影响后续检出。风险定量：`coding-envs/mihomo/ui/**` 73 个 minified js 为 `i/none`，须显式 `-text` 排除，否则 renormalize 会按文本重写 index。本机只 pull 不 commit 行尾变更。
  - **ISSUE-3 TMPDATA_DIR 触发 opencode watcher 风暴（bug/高，含事故记录）**：2026-10-28 本机两次事故——写 `skills/**` + selftest 写 `skills/chromeuse/tmpdata/`（同一监视根）形成 watch→rescan→omo-slim 重注册 11 skill 的正反馈，实测 40–187 次重注册/秒、单分钟 1276 行日志、请求 span 300s+，serve 事件循环饱和需 taskkill 重启（日志硬截断、零 shutdown/OOM 记录）。根因=`paths.js:19` 单根 + 自检 7 处 `DIR/'tmpdata'` 硬编码；修复设计=env `CHROMEUSE_TMPDATA_DIR` 覆盖 + `selftest:994` 改同源断言 + 7 处改 `paths.TMPDATA_DIR`；落地须**定向**验证（勿首跑全量）。现状规避=复制到 `%TEMP%` 跑（本机 129 项即此法）。
  - **ISSUE-4 Windows 端 selftest 6 fail 分类（bug/中）**：本机 129 项/6 warn/6 fail（NAS 同版 334/0/0）逐条定性；其中 **#84 ×2 为环境噪声但暴露两处真缺陷**——`%TEMP%` 副本带 NAS 的 **Linux ELF `bin/ffmpeg`/`ffprobe`**（各约 80MB，`bin/` 不入库），`scroll-shot.js:739-748` 的 `ffmpegAvailable()` 只判 `existsSync` 误判可用 → `blankCheckImage()` fail-soft 返回无 `blank` 字段 → `selftest:8163` 读 `r.blank.suspect` TypeError（已实机复现 spawnSync ENOENT 而 `ffmpegAvailable()===true`）。真缺陷 A=`ffmpegAvailable()` 加缓存探活（win32 只认 `.exe`）；B=selftest:8158 守卫 + `!r.checked` 时 warn 带 reason；可选增强（Windows 回退系统 ffmpeg）待用户裁定。
  - **边界**：未改 `lib/`、`selftest/`、`config-template`；本批仅 TODO.md + CHANGELOG.md + VERSION.md。**未跑 selftest**（有 watcher 风暴风险；本机验证数据取自 `%TEMP%` 副本，见 ISSUE-3/4）。证据锚点=本机 `git ls-files --eol` 快照、`git cat-file --batch` blob 字节核对、`node -e` 探活复现、explorer 树内取证（`lib/scroll-shot.js:739-748/885-893`、`selftest/main.js:8158-8172/8313-8320/7718/3983-3996`、`lib/matchers.js:118`、`lib/paths.js:18-53`、`.gitattributes:1-6`）。

## V202610280003 — 2026-10-28 [doc]

- **台账三件套重构（用户裁定 7 项全落地，chromeuse 为全仓参考实现）**：TODO.md=**唯一活台账**（条目+`  - 进度（日期）：事实；证据=…；下一步=…` 时间线，完成即删）/ CHANGELOG.md=批次史 / VERSION.md=版本真源；**state.md、TODO.md.bak、四问速查视图全部废止**（历史走 CHANGELOG + git：`git log -p -- TODO.md`）。旧 `[x]` 已完成条目 27 条删除（CHANGELOG 各版本已有对应叙述）；INBOX 办结/已裁定/已澄清/已吸收行清理（删除行均由 git 留痕）。
  - **用户裁定 7 项**：①TODO.md.bak 废除（git 替代归档）②四问速查视图废除（100% 派生投影）③环境状态→TODO 头部「当前焦点」④TODO.md ≤300 行 warn ⑤INBOX 对账批删（办结/吸收行）⑥旧结构化条目全转新格式 ⑦立即全仓推广（chromeuse 为参考实现）。
  - **state.md 迁移映射**：§0/§2 批次史与质量基线删除（CHANGELOG 冗余）；§3 协助表并入 TODO 人工区（3 条人工条目吸收「需用户：…；完成后 agent：…」结构；已完成项删除；第二应用/多分辨率的环境需求写入对应 agent 条目「需用户」子句）；§4 开放项去重并入 TODO（CDP/settle/focus emulation/索引 POC/录制帧率/drag/容器同名/diag-O/delivery#31/网络弹窗/素材实弹核对均有承接）；§1 指针并入 TODO「指针」一行式；§3.4 环境状态压缩为 TODO「当前焦点」环境注记（≤3 行）。
  - **§5.4 十七条工程/流程坑逐条核对**：**14 条已迁**（MCP 截图能力边界→CHANGELOG V202610210002/003；引擎 ✓≠事件发生→playbook §前置操作条件与假绿治理；objectId 同会话→facts.md；多 ERP 标签并存→playbook §标签卫生与运行节奏；assert 轮询/收尾挂起、X4 gone-persist 误判面、container domPath 首匹配、count 不验可见性、服务端慢注入签名、按钮组子串歧义、视觉优先、失败报告字段判读、CHANGELOG #3 断言→对应 CHANGELOG/webapp.md/playbook 已有叙述）；**2 条独有迁入 `references/facts.md`**（跨 iframe recon 的 `indexOf===0` 陷阱；多 agent 协作事实=精确路径 add / oracle 无写权限 / council 综合席 / TODO.md.bak 历史规则并标注废止）；**1 条随本批废除**（selftest #6 断言 B 四问同步——四问视图已废）。未改 playbook（**554/560**）、未新增文件。
  - **TODO 新结构**：原 19 条行式开放条目（人工 3 + agent 16）＋旧 TODO-NNN **open/pending 14 条全量转新格式**＋state §4.1 独有开放项【录制定位素材实弹核对】1 条 ⇒ **34 条开放（人工 3 + agent 31）**；每条均有标准进度行（由条目内「进展（日期）」与 state §3/§4 改写，信息不丢）；**TODO-001~017 处置=14 转 / 2 删（007 resolved→V202609120002、017 wontfix→V202609080010，均有 CHANGELOG 叙述）/ 008 空号不建**；旧「结构化条目」区整节删除（含 backlog 注记，git 留痕）。INBOX 保留 5 条未办结观察（视口宽度截断/E6×2/网络弹窗采集/delivery#31 阻塞）。
  - **锚点改写（全仓 TODO-NNN → 【标题】式）**：`references/playbook.md`（190/234/239/308/309/338/339/340/554）、`references/install.md`（19/37/128）、`references/facts.md`（29/60）、`SKILL.md`（87）、`install.js`（200）、`tools/cdp.js`（169/1751）、`lib/cdp-core.js`（8）；`selftest #10` 固定标记串同步为 `状态：未启用（gate：【Playwright MCP 并存实测（事件竞争+超时调优）】）`（install.md/playbook/selftest 三处一致）。
  - **selftest 改动**：①#6 删除旧结构化条目检查（`### TODO-NNN` 计数/resolved 字段/编号去重）与断言 B（四问视图一致性，含 grab/l1-l4 辅助），保留断言 A（标签格式）与 C（高优先占比 warn——现 31 条 agent 高优先 3 条=10%）；②#4 新增 `TODO.md ≤300 行` warn（与 webapp.md 150 行 warn 同级）；③全仓 `TODO-`/`四问` 引用已逐处处置（#21 webapp 下级台账检查未动）。
  - **README**：目录树行改「待办与进度台账（唯一活台账，完成即删）/ 批次史 / 版本真源」；「勘误史完整保留在 TODO/CHANGELOG」改为「CHANGELOG 与 git 历史」；全文无 state.md/TODO.md.bak 引用。
  - **验证**：本地 `node selftest.js` **335 过 / 0 warn / 0 fail**（354→335：删旧结构化 16 条目逐条 pass+结构化计数/编号去重/四问节存在/断言 B 共 20 项，新增 TODO 行数 1 项）；TODO **103/300 行**、facts **112/200**、playbook **554/560**。live 同步：`node install.js` copy（65 文件）→ live 残留 state.md/TODO.md.bak 清理（manifest 外）→ live `node selftest.js` 复跑 **334 过 / 1 warn / 0 fail**（warn=#19 仓库 .gitignore 检查 SKIP，live 非 git 仓的预期位）。

## V202610280002 — 2026-10-28 [doc]

- **台账整理批（他批补记 + 第三轮复盘登记 + 勘误）**：
  - **补记他批 V202610280001 进 state.md**：他批（2026-10-28 上午会话，commit 9723c35）只改了 SKILL/playbook/wechat.md/selftest 守门，**state.md 与 TODO.md 未同步**——本批补 §0 快照/§2.2 批表行/§2.3 git 链路/§3.4 环境周边（opencode 2.0.32→2.1.4 + omo-slim 3.0.6（v86）、HUD 0.4.41（v92）、README v87 Windows npm 章节——平台层变更对 chromeuse 零影响）/§4.1 补记。
  - **TODO 10-23 第三轮复盘批登记入册**（F17 元数据兜底链 / F18 日期规范化；此前仅在工作区未提交）。
  - **playbook §多标签管理 F10 条补再证**：2026-10-23 补充品牌批 4 路并行 48/48 零失败·约 7 分钟（同日修一处编辑造成的行尾残片）。
  - **wechat.md 勘误**：promote 起始版本号 V202610210003 → **V202610220001**（promote 实为第二轮复盘批落地）。
  - **开放条目核对结论（用户问询项）**：V202610220003 之后 chromeuse 代码层**零改动**（他批纯文档；HUD/opencode/openeyes/subagent-ops 各会话不触及 chromeuse 代码）——**TODO 开放条目无一被其他会话直接修复**，F15/F17/F18 等仍开放。
  - 验证：selftest **354/0/0**；live install.js 同步（65 文件，353+1 预期 warn）。

## V202610280001 — 2026-10-28 [doc]

- **记忆重构配套批（conventions 升 skill，来源=task-preview 报告 `reports/20261028-记忆重构计划（conventions升skill方案）.md` §3.2）**：
  - `SKILL.md` §三 红线区新增 **#13 拟人化总则**：抓数据/逛电商一律模拟人类 UI 操作，**禁接口直查**三手段（JSONP / fetch 后台 API / cookie 重放）；与 #1（事件层 `isTrusted`）、#2（路径层业务语义）合称**拟人化三层**；写明与专题一「Cookie 重放接口」的边界区分（**只读取证可用，采集不可**），防误读。§〇 文件地图增 `webapps/wechat.md` 行。
  - `references/playbook.md` 新增两节：**§拟人化六条**（2026-10-09 用户裁定全量迁移+展开，六条硬纪律逐条对应，含实证细节：Escape 不生效、目测坐标偏差 64px、未确认连做 3 步全军覆没）+ **§页签礼仪**（2026-10-09 用户裁定：`new_page` 专属页签 / 绝不复用·导航·刷新用户页签 / 结束关闭还原）。
  - 新增 `webapps/wechat.md`：微信长截图懒加载专项（`data:svg` 占位但 `complete===true` 误判 / 强制 `img.src=data-src` + `naturalWidth>1` / GIF 1.8s / 并行禁共享 tab `--reuse` 冲突），应用入口仍指 `webapps/wechat-mp/webapp.md`。
  - 守门调整：`selftest/main.js` playbook 行数守门 540→**560**（新增两节为记忆重构必需内容；实测 playbook **554/560**、SKILL **214/320**）。
  - 记忆侧对应 conventions 条目改为指针（记忆重写由 orchestrator 执行，不在本批）。

## V202610220003 — 2026-10-22 [fix+doc]

- **scroll-shot 前台保障（修「后台页签静默错图」）**：环境事实——raw CDP `Page.captureScreenshot` 在**后台页签**会 30s 级超时，甚至**返回旧帧**（同页同位置实测：后台 30015ms 超时 / `Page.bringToFront` 后 592ms 且内容正确；`clip+captureBeyondViewport` 第二次后台返回 y=0 内容而页面在 y=665）。修复：
  - `lib/scroll-shot.js` 新增 `readVisibility()`（单源 `document.visibilityState` 表达式，失败 fail-soft）与 **`ensureForeground()`**——**开工前**（早于首次测量/预热/截图）：原本 `visible` → `bringToFront:'not-needed'` 不做任何多余动作（不打扰用户）；`hidden` 或读取失败（按不可信处理）→ `Page.bringToFront` + **复核** `visibilityState`；`--no-foreground` → `skipped` 且在 hidden 时打**强告警**（静默错图比报错更危险）；`bringToFront` 失败/未生效 → 如实记 note，**fail-soft 不中断截图**。
  - 清单新增 `foreground:{enabled,beforeVisibility,afterVisibility,broughtToFront,bringToFront,userWasOnOtherTab,note}`（形状恒定）；stdout 摘要仅在「曾置前」或「hidden/读取失败」时打一行。
  - **取舍：默认不自动还原前台**（`--restore-focus` 未做）——Chrome 无「查询上一活跃 target」的稳定 API，`Target.getTargets` 只有 `attached/type/url` 弱信号，猜测着切回候选在概率上就是把用户正在看的页签切走，比不还原更糟；因此只如实记录 `broughtToFront`/`userWasOnOtherTab` 并明示可能已切走用户前台。`--no-foreground` 提供反向选择（宁可不打扰，承担超时/旧帧风险并强告警）。
  - 文档：`references/playbook.md` §逃生舱 增「截图通道环境事实」（净增 2 行，530→**532**）：raw CDP 截图前必须 `Page.bringToFront`（`lib/screenshot.js` 早已内置；`scroll-shot` 自本批内置）；并行多页签截图每页签各自置前。`references/install.md` scroll-shot 条目补一句（128 行不变）。`SUB_HELP`/`helpMain` 补 `--no-foreground`。
  - **实弹（他方+f我方双证）**：`--no-foreground` 后台跑 → **94.6s**、`status=partial`、段 2 链式 30s 超时失败；默认跑 → **4.4s**、2/2 全过。**orchestrator 独立复验**：自建红/绿双段页 + 另开页置于前台 → `beforeVisibility:"hidden" → afterVisibility:"visible"`、`broughtToFront:true`、耗时 **4.4s**、两段 RGB 均值 `[255,1,0]`/`[0,252,1]`（内容正确）、页签自闭零残留。
  - selftest **#86** 5 用例（visible 不置前 / hidden 置前且**早于**预热与截图·调用序 vis→front→vis / `--no-foreground` 绝不置前 + 强告警 / 字段形状+stdout+帮助面+源码闸门 / bringToFront 失败 fail-soft）。
  - 验证：`node selftest.js` **354 过 / 0 warn / 0 fail**。
  - 边界如实：①只开工前置前一次，长图取图中途用户切走仍可能超时/旧帧（未做逐段前置，避免每段多一次副作用与往返）；②`userWasOnOtherTab` 是启发式（`beforeVisibility==='hidden'`），无法区分「用户在看」与「另一 agent 的页签在看」。

## V202610220002 — 2026-10-22 [fix+enhance]

- **第二轮复盘批续（空白段自检 + 重试未重落位修复）**：
  - **① 空白段自检（F13，默认开）**：每段落盘后 `ffprobe` 取高 + `ffmpeg -vf "scale=1:H:flags=area,format=gray"` 取**每行平均亮度**（实测 `scale=1:-1/-2` 报 -22，必须显式给高）→ `blankRuns()` 归并连续高亮游程（`from` 含/`to` 不含，只留 `rows>=minPx`）→ `analyzeBlankSections()` 出 `{suspect,ratio,runs≤5,runsTotal,rows}`；段字段 `blank{}`、顶层 `blankSummary{segments,suspect,suspectIndexes,minPx,threshold,ffmpeg,elapsedMs,strictFail}`。旗标：`--blank-check`（默认开）/`--no-blank-check`、`--blank-min-px`（默认 **800** 物理 px）、`--blank-threshold`（默认 **247**，容 JPEG q90 纯白 ±1 抖动）、`--blank-strict`（默认关）。**默认 advisory 只报告不改退出码**——依据=他方 140 篇复检残留 3 篇空白经 DOM 逐篇复验 `remaining=0` 且截图高=文档高，属原文设计留白；见白即失败会把正常排版判成缺陷，且会污染 `status` 的诊断价值（strict 时 `status` 仍记 ok，另置 `strictFail=true`）。ffmpeg 缺失 fail-soft 跳过（旁路诊断不升级为截图失败）。**我方实测**：6000px 页 + 1200px 白块 → 段 2 `runs=[{from:400,to:1600,rows:1200}] ratio=0.75`（零误差）、4 段检测 **152ms**；`--blank-strict` → exit 1 且 `status=ok/strictFail=true`；正/负样本与「promote 组不可疑 vs `--no-img-promote` 组检出」互为验证。selftest **#84** 6 用例。
  - **②【静默错图 bug】重试/降级前未重新落位滚动**：`captureSlice()` 的 `shotScopedScroll` 原先只在重试循环**外**调用一次——`Page.captureScreenshot` 超时（重负载实测 30~90s 级）会扰动滚动位置，第 2 次尝试与 `tryJpegFallback` 都不重新 `scrollTo`，于是"重试成功"却拍到别处内容且记 `via:'A'`（实测段 2/3 内容重复，都拍到同一块白）。修复=新增 `repositionForRetry()`（复用 `shotScopedScroll`：settle + scrollY 读回校验 + `scrollMismatches`），**每次重试前与 jpeg 降级前都重新落位**；次数双记 `state.repositions`（段）/ `ctx.scrollRedone`（顶层 `scrollRepositions`）；断链（`kind==='disconnect'`）**不额外滚动**、保持止损/降级语义；落位本身失败记 `A#<n> reposition …` 并 break（不空拍）。**实弹自然复现超时**：`--viewport-max-chunk --max-chunk 1600` 下段 1/2 均 `attempts=2 / repositions=1`，重试后内容正确（红/绿段 RGB 均值相邻差 254）、`scrollRepositions=2`、`status=ok`、scrollY 还原。selftest **#85** 5 用例（含**调用序断言** `scroll→capture(败)→scroll→capture(成)`，非字符串断言）。
  - **③【环境事实，重要】Chrome 后台页签 `Page.captureScreenshot` 不可靠**：同一页签同一位置（DOM 探针确认可见）**后台取图 30s 超时，`Page.bringToFront` 后 0.59s 且内容正确**；另有后台 `clip+beyond` 第二次返回**旧帧**（页面在 y=665 却返回 y=0 的红色内容，`mean=[253,0,1]`）——即后台页签会**静默产出错图**，不只是慢。影响面=共享浏览器多页签并发截图/并行采集；`lib/screenshot.js` 的 `screenshotHardened` 早已内置 bringToFront 前置（正确），**scroll-shot 尚未**（已登记 TODO，下批修）。证据=`tmpdata/realshot-fix/diag{,-2,-3}-result.json`。
  - 验证：`node selftest.js` **353 过 / 0 warn / 0 fail**（#84/#85 新增）；SKILL 212/320、playbook 530/540、install 128/260 守门内。

## V202610220001 — 2026-10-22 [fix+doc]

- **竞品采集第二轮复盘批（5 条登记，本轮落地 3 条；来源=task-preview 报告 2026-10-22 更新版 §2.10 F 类 + 执行日志「140 篇全量收集 + 截图空白根因修复」）**：
  - **①【bug，命中我方现网判据】scroll-shot 懒加载就绪判据把占位符当已加载**：旧 `PAGE_EXPR` 用 `im.complete && im.naturalWidth > 0` —— 微信占位图 `<img class="rich_pages wxw-img js_img_placeholder" src="data:image/svg+xml,...">` 的 **`complete=true` 且 `naturalWidth=1`**，`>0` 判据天然放过 → 长图成段纯白（他方 140 篇里 31 篇 ≥2000px 空白）。修复=①新增纯函数 `classifyImg()` 三态真源（placeholder/pending/loaded），经 `toString()` 内嵌页面表达式（Node 与页内同一份源码，不可漂移）；②就绪判据改 **`naturalWidth > 1`** + 占位符识别（`src` data:image/svg / class `js_img_placeholder` / data: 且 nw≤1）；③**promote 后必须归 pending 不归 placeholder**（真源赋值后 src 变真、class 仍留、nw 先归 0——判错会二次提前退出复现白段）。**新增 `--img-promote`（默认开）**：纯属性赋值 `img.src = data-src`（优先级 `data-src→data-original→data-lazy-src→data-actualsrc→data-backsrc`，**不 dispatchEvent/不合成点击**，红线 #1 不破）+ 打标 `data-cu-promoted="1"` 幂等 + 先只读统计再赋值；`--no-img-promote` 关闭并明示"可能出现占位空白"。**新增 `--img-settle`（默认 1800ms）**：promote 后等首帧解码（GIF 必要），`0` 可关。清单增 `images:{total,promoted,failed,placeholder,pending,loaded}` + `prewarm.imgPromote` + 五条如实 notes。**顺带修既存缺陷**：`runScrollShot` 二次归一 options 只读原始键名 → CLI 的 `--settle`/`--image-timeout` 一直被默认值静默覆盖（**语义变化：以前"设了没效果"的调用现在生效**），已改 `pick(原始键, 已归一键)` 幂等。
  - **② 空白段自检 / ③ 切点吸附未实施**：前者待做（设计见 TODO）；后者已写可执行设计草案（`ffprobe` 取高 → `ffmpeg -vf "scale=1:H:flags=area" -pix_fmt gray -f rawvideo` 得行亮度；实测 `scale=1:-1/-2` 报 -22 不可用，必须显式给高）。
  - **④【doc】并行采集禁止同页签复用（F10）**：`references/playbook.md` 多标签管理节 +`snippets/tab-helper.js` 头注 + `SKILL.md` 一句——多 worker 各自 `openTab`（独立 targetId）；同页签并发驱动 = navigate/close 竞态（`Inspected target navigated or closed` / `Not attached to an active page`；实证 `--reuse` 4 worker 21/140 失败 → 独立页签 140/140），锁只保 pageId 获取。playbook 530/540。
  - **⑤【doc】wechat-mp 手册补第二轮实证**：新增「懒加载与长图实证（2026-10-21 全量 140 篇）」节（F8 占位陷阱/F8 强制赋值解法/F9 滚动不可靠/F14 GIF 首帧 1.5~2s/F15 切段吸附空白带阈值）+ 待复验清单 5→10 项（4 条标"他方实测已复现"、我方实弹复跑仍待）；状态仍 `stale`；并如实标注"切点吸附尚未内置（当前硬切）"。
  - **orchestrator 独立复验（真机 A/B，不采信自述）**：自建"微信同款"页（6200px、4 个 `js_img_placeholder` + `data-src` 真 PNG、**无 IntersectionObserver 故永不替换**）——`--no-img-promote` 组 4 个图位灰度均值 **255（纯白）**、`promote=0/0 placeholder=4`；默认组同 4 个图位 **105（绿色真图）**、`promote=4/4 placeholder=0 pending=0`；`--img-settle 0` 实测被尊重（`imgSettleMs=0`，旧版会被重置 1800）；`emulation.restore.ok=true` / `scrollY` 还原 / 页签自闭零残留。
  - **如实边界**：①promote 只覆盖顶层 `document.images`（iframe 内图与 CSS `background-image` 不在范围，背景图仍靠滚动兜底）；②**`data-src` 自身是 `data:image/svg` 的候选会被跳过**（防"提到另一个占位符"被记失败）——顺带发现我方测试页若用 SVG 当真图会 promote=0，改用 PNG 才验证到；③内在宽度恰 1px 的真实图会被判 placeholder（实际不可用）；④`data-cu-promoted="1"` 标记留在页面 DOM（未清理）。
  - 验证：`node selftest.js` **351 过 / 0 warn / 0 fail**（新增 #83 组 6 用例：classifyImg 三态 / PAGE_EXPR 源断言+fake DOM 真跑 / promote 优先级链+纯属性赋值+幂等 / manifest+print+旗标+帮助面+二次归一幂等 / 等待与 settle 端到端 / CLI 端到端）。

## V202610210003 — 2026-10-21 [feature+doc]

- **scroll-shot 参数体系（用户裁定五条，口径全落）+ screenshot jpeg 默认质量**——承接 V202610210002 的四个待裁定口径：
  - **① `--max-chunk` 双单位 / 默认改物理像素**：新增 `--max-chunk-unit px|css`，**默认 `px`**；内部几何统一 CSS px（`chunkCss = px ? floor(maxChunk/dpr) : maxChunk`），不变量=px 模式下**每段物理高 ≤ maxChunk（硬保证）**。⚠ 默认单位变更 → **dpr>1 时与旧行为不同**（旧=CSS px），帮助/文档已显式注明。selftest 断言 `resolveChunkGeometry` 四态。
  - **② `--overlap <css px>`（默认 0）**：**不改变切段位置**（y 仍按 step 递增），非末段每张向下多拍 overlap（`captureHeight = cssH + overlap`，末段恒 0，须 < chunkCss），清单逐段记 `overlapPx`。定位=0 几何精确可拼接（机器消费）/ 人工阅读长文用 8 左右避免文字被 4600px 切点劈开。
  - **③ PNG 断链降级（默认开，`--no-format-fallback` 关）**：a) **预防性告警**——开跑前按 `width×dpr × cssH×dpr` 估算，单段 > `PNG_SAFE_PIXELS=3,000,000` 且 format=png → 明确告警+建议（改 jpeg / 减小 max-chunk），**不改用户格式**（实测依据：1100×4600=5.06M px 打挂 WS、1100×2000=2.2M px 正常）；b) **逐段降级**——某段 PNG 两连败 → 该段改 jpeg q90 重试一次，成功则清单记 `format=jpeg` + `formatFallback=png-fail`；整轮仍中断 → 保持 `failed/partial` + `missingSlices` 如实不假装成功。
  - **④ `--viewport-max-chunk`（显式布尔，不默认抬视口）**：把运行期视口**高**覆盖为 `chunkCss`（宽取 `--viewport` 的 W，未给则当前 `innerWidth`；DPR 取 `--dpr`），与 `--viewport` 同给时高度以本旗标为准并打印覆盖关系；隐含显式 Emulation → `finally` 还原，**不给旗标时依旧零 Emulation 命令**。红利 = `step == viewportH`（等价视口截图，规避 beyond-viewport 大 clip），已加 `step ≤ viewportH` 机检断言防回退。
  - **⑤ screenshot jpeg 缺省质量显式 90**：`formatPlan` 解析顺序 `--quality > env CHROMEUSE_JPEG_QUALITY > 90`（env 非法值忽略回落；`--quality 0` 按合法值处理，不被 falsy 吞）。扩展名「改写+告警」与「png+quality 忽略+告警」**维持原策略**——取证优先，绝不因参数风格失败。
  - **orchestrator 独立复验（真机，不采信子代理自述）**：`--dpr 2 --max-chunk 4600`（px）→ 段物理高 **1330**（视口 665×2，≤4600 ✓）；`--viewport-max-chunk --dpr 2` → 视口自动 1706×**2300**、段物理高 **4600**、跑完还原 665/dpr1；`--max-chunk-unit css --viewport-max-chunk --dpr 2` → 段物理高 **9200**（显式选择语义正确）；`--overlap 8` → 非末段 4608、末段 1600、清单 `overlapPx=[8,8,8,8,0]`；screenshot `--format jpeg` 缺省与 `--quality 90` **md5 完全相同**、`CHROMEUSE_JPEG_QUALITY=60` 生效（15734B→11522B）；页面/页签零残留（自开自闭）。
  - **如实边界**：①**逐段 jpeg 降级在真实 WS 断链下不生效**——连接已死，按「不做自动重连」边界止损（该路径目前仅单测覆盖；真实断链复现时 status=failed + missingSlices 如实 + 新连接兜底还原视口成功）；②PNG 断链复现后浏览器有短暂迟滞（首跑一次 ~300s 只落 1 段，重跑正常），判断为 ~22MB 截图恢复期，非代码死循环，未做第三次尝试。
  - 验证：`node selftest.js` **350 过 / 0 warn / 0 fail**（#81/#82 用例内容扩写，条数不变）；SKILL.md 212/320、install.md 126/260、playbook 529/540 守门内。

## V202610210002 — 2026-10-21 [feature+fix+doc]

- **竞品采集复盘批实施（5 条 TODO 全清，全自主夜间批）**——来源=task-preview 会话 ses_ea7cdc9e 复盘（登记批 V202610210001），本轮实施：
  - **① screenshot 增强 `--dpr/--viewport/--format/--quality`**：`lib/screenshot.js` 新增纯函数层（`parseViewport`/`metricsPlan`/`materializePlan`/`formatPlan`/`planOutPath`）+ 运行期 `readMetrics`/`beginEmulation`/`endEmulation`；`screenshotHardened` 改为「格式计划 → beginEmulation → 整条加固链（失败矩阵/fromSurface 降级/冷启动退避逐字保留）→ finally endEmulation」包装层，覆盖一次贯穿全链路不中途 clear。**默认零改变**（无旗标零 Emulation 命令、不读视口——V202609080010 红线不破）。派发参数透传 format/quality（png+quality 忽略并告警）；扩展名按 format 决定（`--out` 不一致→改写+告警）。set 后读回 `innerWidth/innerHeight/devicePixelRatio` 校验，mismatch 走 advisory 如实打印（不中断、不谎报）。**实测踩坑并修**：截图期 WS 断开时 finally 的 clear 送不出去 → 覆盖残留（日志实证「视口覆盖还原失败：连接不可用」）→ `tools/cdp.js` 加 `retryClearEmulation`（新连接再清 + 读回）与 `ensureEmulationRestored`（失败打印手工恢复命令）。**实弹**（Chrome 153）：`--viewport 750x900 --dpr 3` → `ffprobe` 2250×2700、页内 750/900/dpr=3 ✓；jpeg q90 vs 同视口 png **−44.1%**（1.10MB→0.62MB，`mjpeg` 实测）；默认截图前后 `innerWidth/DPR` 不变且 before/after 字节完全相同；`--dpr 2` 单参 1706×665→3412×1330。selftest **#81** 5 用例。
  - **② 反爬/验证码处置纪律**：`SKILL.md` 新增 **红线 #12**（处置序=截图取证→最多一次点「去验证」→转人工如实报告；**严禁硬刷**/换 UA/IP 反复试探=第 4 次违令，与 #10 同源；出口 IP 语义=数据中心 IP 打 mp.weixin 文章页全量弹码→改真实浏览器出口或转人工）+ 红线 #10 尾部互引；`references/playbook.md` §MCP 交互模式纪律 并入「反爬/验证码处置」细则条（+1 行，529/540 守门内）。
  - **③ wechat-mp webapp 建档**：新增 `webapps/wechat-mp/webapp.md`（77 行，**状态 stale** 待实弹复验）——matchers（`mp.weixin.qq.com` + `mmbiz.qpic.cn`）/ A5 只能按文章链接不能按号枚举 / A8 短链打开后读 `location.href` 拿 `__biz`（并给「同号 `__biz` 固定」去重键用法）/ A10 数据中心 IP 全量验证 + A7 一次放行 / C5 尾部杂质裁除 / A6「上一篇下一篇」仅合集内有 / C7 配图原图 1080px 是平台天花板 / 合规边界（`robots.txt = Disallow: /`，仅内网留存不二次公开）/ 长文节指针 scroll-shot / 待复验清单 5 项（选择器一律「需现场探针确认」，无脑补）。
  - **④ chatgpt 补条**：`webapps/chatgpt/webapp.md` 已知坑补「浏览器检查未完成」→ 输入框消失，**刷新一次**（不重开新页，避免丢当前会话）即恢复；刷新后仍无再走登录态/反爬路径（来源附带、未多轮复现）。
  - **⑤ scroll-shot 长图拼接子命令**（复杂新功能）：新增 `lib/scroll-shot.js`（653 行）+ `tools/cdp.js scroll-shot` 接线（helpMain/SUB_HELP/dispatch）。链路=预热（逐屏下滚→`min(y,maxScrollY)` 夹到底→文档高连续 3 次稳定→回顶→等图 `imagesPending`）→ `planSlices` 分段（末段防重叠 C4）→ **A 路径**（整段 clip + `captureBeyondViewport`）**重试 1 次 → B 路径**（视口切片 + `bin/ffmpeg` vstack，按实测 scrollY 求交裁剪丢弃 clamp 重复帧；无 ffmpeg 如实失败不产错图）→ ≤`--max-chunk`（默认 4600 CSS px，D1）物理切段 → jpeg q90 默认（C6）→ 单段超时预算（默认 30s，段数×超时总帽，超帽标 `partial`）+ 断链止损（`missingSlices` 如实）+ finally 还原视口与 scrollY + **不关解析出的页签**。清单 `<name>.json`（`chromeuse-scroll-shot/1`）逐段 y/高度/字节/via。**实弹**：20200px 页 5 段（4600×4+1800）5.84s jpeg 840KB；**50320px 页 11 段** 13.91s 2.13MB；**懒加载对照实证**（未预热区域 YAVG=239.8 空白 vs 预热后 97.9 已渲染；manifest `imagesPending=0`）；**B vs A 末段 `difference` YAVG=0.33/YMAX=145**=仅重编码噪声，证 clamp 裁剪几何正确；默认无旗标 `step=665` 零 Emulation 命令。selftest **#82** 6 用例。**已知边界如实**：sticky/fixed 逐段重复、内部滚动容器无效（scrollMismatches 暴露）、canvas 虚拟列表缺块、iframe 内懒加载不驱动、CSS transform/zoom 与 CSS px 假设冲突、背景图/picture 不在 `document.images` 判据内、1100×4600 噪声 PNG 会打挂 WS（jpeg 安全档）。**四个待裁定口径入 TODO INBOX**（max-chunk 单位 CSS vs 物理 / 段间 overlap / 超大 PNG 是否自动降级 / 是否默认抬视口）。
  - 验证：`node selftest.js` **350 过 / 0 warn / 0 fail**（349→350：#82 组 +1；#81 组与既有 #75/#66 零回归）；orchestrator 侧独立复验=真机三段几何（1100×4600×3 段精确高度）+ 逐段像素色差（分段内容各不同）+ 页签零污染（自开自闭）+ 临时产物清理。

## V202610210001 — 2026-10-21 [doc]

- **竞品采集会话复盘批（TODO 登记，未实施）**：复盘 task-preview「竞品广宣收集与PPT整理可行性分析」会话（ses_ea7cdc9e，555 消息/434 工具调用，**浏览器工具零报错**——问题全在能力/质量层），筛出 5 条可完善项入 TODO：①【scroll-shot 长图拼接子命令】（C1 23805 CSS px 整页截图失败 / D1 47610px 超长被查看端降采样 / C2 懒加载不滚截空白 / C4 末段重叠 / C6 16MB 体积 / B4 单页 120s 超时）②【screenshot 增强 --dpr/--viewport/--format/--quality】（B2/B3：MCP DPR 不生效+resize_page 无效→raw CDP Emulation 显式覆盖）③【反爬/验证码处置纪律】（A7 滑块一次放行勿硬刷 / A10 数据中心 IP 全量验证）④【wechat-mp webapp 建档】（A5/A8/C5/C7）⑤【chatgpt 补条】（B5）。state.md §2.2/§4.1/§5.4 同步（含「MCP 截图能力边界」教训条）。

## V202610200003 — 2026-10-20 [fix]

- **Windows 端安装/自检管线兼容批（上游改动建议评审采纳，来源 skill-handover-20261016）**：
  ① **install.js manifest 补 snippets**：`DIR_RULES` 加 `snippets: '.js'`（copy 安装形态长期缺 snippets——NAS `--link` 掩盖；`--prune` 误删风险同除）+注释/docstring 同步；验证=copy 安装收录 3 snippet（eval-helper/popup-close-scanner/tab-helper）+目标侧 selftest ALL PASS。
  ② **open-app.flow.json 入库**（erp_demo_dev，2026-09-24 Windows 实测蒸馏 15 步，实弹 15/15；参数化 vars=osUrl/domainId/appName；应用面板三步红线=xiaoxin 部署头→域抽屉 .menu-item→域容器 #appList-<域ID> app-item，锚点全 DOM 化零坐标）+ 同批 restored 恢复件：webapp.md 增强（本机直连 127.0.0.1:40000 / 域 ID=项目目录名 / 三步红线最高严肃级 / 码头仓库统计核对知识卡）、TODO INBOX 1 条。
  ③ **selftest M1_BASELINE 补 open-app 4 条**（#6/#8/#9/#11，理由注释齐全）+ **标签计数修正**（M1 15→22 实际条数、M2 4→5 实际——历史标签失真）。
  ④ **selftest #66 fake-CDP 补 else**：all-green/ws-hang/single-eval-dead 的 HTTP 面同 fake（原仅 http502 patch→无浏览器主机 all-green 首场景 throw 后场景 2-4 短路少跑；与「零真实连接」注释原意对齐）。
  ⑤ **根 .gitattributes 追加 skills 子树 `text=auto eol=lf`**（Windows autocrlf 检出→copy 安装 CRLF 进 live→#7 WARN+#14/#61 误报）。
  验证：selftest **340/0/0**；open-app flow lint 4 条=基线精确相等；`git check-attr` text:auto/eol:lf；copy 安装端到端 PASS。**② 遗留**：open-app 的 `_meta.viewport` 为旧固定视口形态（1919×1081，实测通过未动）——后续可评估迁移 viewportMin。

## V202610200002 — 2026-10-20 [fix]

- **popup-guard 真实拦截实弹完成（T1-T3）+ 两处修复**：
  - **注入修复（关键）**：`Page.addScriptToEvaluateOnNewDocument` 在**未调 `Page.enable`** 时注册成功但**脚本不执行**（最小复现实证：有 enable→`window.__t` 生效/无 enable→不执行）——`popupGuardInit` 前置 `Page.enable`（fail-soft 包裹）。
  - **去重**：同一元素被 observer 多批次重复记录 → `act` 首行跳过已标记 `data-cu-pg-hidden` 元素（拦截计数 4→2 精确对应测试页 2 个广告层）。
  - **实弹证据**：本地测试页（`opencode:8899`：overlay-backdrop + 800×600@z3000 + 业务小弹窗对照）——带 guard=**2 条精确拦截**（两个广告层 hide、业务弹窗保留）；**对照组无 guard=弹层正常显示**（差异实证）；taobao 7/7、jd 9/9 零拦截（无误杀）。
  - 已知小瑕疵：record 伴跑时 1 次 `getTargetInfo -32602`（记录侧 navigate 兜底存档，不影响）。
- **record/replay 互斥解除（V202610200001）实弹**：默认无锁——replay 在 record 运行时正常启动（不再被「另一动作正持锁」拒绝）；**伴跑实测 2 轮=1 次步骤 2 偶发超时/1 次 9/9 全过 + 单跑对照 9/9 全过**——无稳定干扰证据；`--lock` 可选显式互斥保留（兼容旧脚本）。

## V202610200001 — 2026-10-20 [feature]

**record / flow replay 互斥锁解除（2026-10-19 用户裁定落地）**——用户原话「我不希望加互斥锁，只希望打开页签并获取 pageid 这个方法加锁」：**锁只保留在「打开页签并获取 pageId」层**（`snippets/tab-helper.js` 锁页 window-CAS，V202610140003，独立一层），**record 与 flow replay 默认不互斥**；`.chromeuse.lock`（V202609080007 时代机制）降级为**可选 `--lock` 显式互斥**，`lib/lock.js` 保留不删。

- **`tools/cdp.js`**：新增 `maybeLock(enabled, owner, fn)` 单点开关（默认直通 = 无锁、`--lock` 才走既有 `withLock`）；`flow replay` 调用点 `withLock('flow-replay', …)` → `maybeLock(!!flags.lock, 'flow-replay', …)`——**默认路径零锁文件、零 acquire 调用**。`withLock` 实现保留供 `--lock` 分支（旧脚本语义兼容），持锁报错文案补「不加 --lock 即默认无互斥」。SUB_HELP `flow`/`record` 与主帮助面同步 `--lock` 说明。
- **`lib/record.js`**：record 入口 `lock.acquire('record')`/`lock.hold(5000)` 全部按 `lockOn = !!flags.lock` 门控——无锁路径**零副作用**（不建 `tmpdata/locks/`、不写锁文件、不起 heartbeat 定时器），`flushToDisk` 的 `lock.release()` 与 `stopAll` 的 `clearInterval(heartbeat)` 同门控（无孤儿锁 / 无孤儿 timer；`clearInterval(null)` 本身无害）。
- **`lib/lock.js` 保留（不删）**：未来可选能力 + `doctor`/`doctor-forensics` 仍读 `lockHolder` 取证；本批**不做任何改动**。
- **文档**：`references/playbook.md` §逃生舱「双端并发」条改写——「record / flow replay 默认无互斥（2026-10-19 用户裁定，锁只留 tab-helper 页签层）；`--lock` 可选显式互斥；多客户端共连干扰风险由纪律兜底（V202609130003 归因遗留观察）」+ 避免同期双长动作/record 伴跑 replay 前确认无 MCP 重操作的纪律提示。
- **selftest #80 新组 4 用例**：①默认路径无 withLock（源断言：`maybeLock(!!flags.lock, …)` 在位 + 无 `withLock('flow-replay')` + record 四处 lockOn 门控）②`--lock` 旗标接线（SUB_HELP 双处 + 主帮助面 + playbook 改写 + 旧「入口有互斥」表述零残留）③`lib/lock.js` 保留 + API 齐备（六导出 + STALE_MS=15000 + LOCK_PATH 单源）④CLI 真进程行为：预置他进程 fresh 锁 → 默认 replay **越过锁**（失败于 CDP 探活而非「持锁」）且不改动他人锁文件；`--lock` → 「另一动作正持锁（selftest-holder）」；无锁时 `--lock` 跑完自行释放（**无孤儿锁文件**）；存在活跃外部锁时该用例自动跳过并 warn（并发 record 保护）。**selftest 339 过 / 0 warn / 0 fail（ALL PASS；338→339，新增 #80 组）。**
- **边界（如实标注）**：浏览器实弹（`record -v` 伴跑 `flow replay`：事件流完整性 / 视频完整 / 无竞态 / replay 结果正确，并据此满足「replay 需过程录屏」需求）由 orchestrator 执行；若伴跑证实不稳，按 TODO 条目预案回退「默认不互斥 + `--lock` 可选」的显式互斥并报用户再裁（当前实现即该形态）。`references/openclaw.md` 仍有一句「长动作依赖 .chromeuse.lock 互斥」的旧表述，本批按「只改指定文件」约束未动，留待文档批修正。

## V202610190003 — 2026-10-19 [fix]

- **销售订单现货锁定 flow 修正（用户审阅视频指出两处，全自主修复+两连过）**：①**路径改完整人类链路**=应用面板入口(`#showAppList` winui 竖栏 y≈95)→物料域（默认已激活，可见性断言保真）→销售管理应用(`div.app-item[app-id='gongqi.df.sales']` 稳定属性锚)→应用壳业务地图(#searchInput 同款结构)→销售订单模块——**替代桌面图标双击路径**（违反操作路径红线：人类从应用面板逐级进入）；②**补菜单项点击→领料锁定页面打开**（原版截断在菜单展开）：`target={text:"现货锁定",match:"exact",container:{domPath:"ul.dropdown-menu > li:nth-of-type(2)"}}`——**flow-engine container domPath 跨 frame 实测生效**（li 容器内唯一 a，解与主按钮同文本歧义）；收单断言=「领料锁定」tab 可见。**两连过 27/27×2**（带 -v 视频）。**实测新知识（已入 webapp.md）**：domPath 属性选择器值含点号**必须加引号**（`[app-id=gongqi.df.sales]` 被解析为 `[app-id=gongqi.df]`+`.sales`→querySelectorAll 语法错误→候选 0）；菜单项点击打开 tab=**「领料锁定」**（此前误记为「库存锁定查询」）；域项 `div.menu-item[domainid=Item]` 在隐藏 subwrap 内（X1 拒）。
- **popup-guard 实弹 T1/T2**：taobao 7/7+jd 9/9 全过；规则加载 **app 级整体生效**（taobao 6 条/jd 2 条，source=app）；**零拦截=无误杀**；真实弹窗拦截待弹窗偶发出现时验证（如实标注）。
- **locator 实弹两处修复**（用户「元素捕获」专项）：①suggest 祖先文本取到 `<script>` 源码→container-not-found → **container 改 domPath 优先**（cssPath 精确、同文档唯一）；②共同祖先无区分度（主按钮与菜单项分属不同子树→共同祖先仅 body/html）→ **新增策略二：逐候选祖先链扫描**（实测对「现货锁定」给出唯一收窄 `#ButtonGroup > div:nth-of-type(6)`）；verify 高亮+截图视觉确认实测通过（高亮框正确落主按钮）。
- 台账：#10 click 诊断增强（随 V202610130003 落地）/录制帧率 v1（已参数化默认 6）核实入 INBOX 澄清与条目进展；selftest 338/0/0（#77 popup-guard/#78 locator/#79 视口高度地板 三组）。

## V202610190002 — 2026-10-19 [feature]

**视口高度地板（viewportMinHeight 三态视口策略高度维度扩展）**——消化 TODO INBOX 2026-09-30【矮窗口高度地板】：`_meta.viewportMin` 此前仅宽度维度，矮窗口（1705×664 实测）下底栏下拉菜单开在表单文档视口外（`elementFromPoint` null → effect 永假），需高度维度 schema 扩展。

- **schema 扩展（向后兼容硬约束）**：flow `_meta` 新增可选 **`_meta.viewportMinHeight`**（数字=最小布局高度地板，独立字段与 `viewportMin` 宽度地板并列）——**选独立字段而非 `viewportMin:{w,h}` 形态**，以保既有 `viewportMin` 数值语义/校验/返回形状**逐字不变**（`{w,h}` 会改既有字段类型，风险面更大）。两维**独立可只声明其一**；未声明 = 高度行为与现状完全一致（零回归）。`validateFlow` 新字段校验（有限正数且 ≤4096，非法红+文案指路「最小布局高度」）。
- **`lib/flow-engine.js`**：
  - `viewportMinPlan(vmin, otherPageCount, actualW, vminH, actualH)` 扩参（尾参可选）——`vminH` 非法/缺失 → **存量宽度返回形状逐字不变**（`{mode,width,height:'live'}` 族，width-only flow 零回归）；`vminH` 合法 → 扩展形状 `{mode, declared:{width,height}, actual:{width,height}, override:{width,height}[, probePartial]}`（skip 追加 `below` 各维越界诊断，无 `override`）。三态语义逐维独立：在场永不 emulate（越界维 advisory）/缺席只托底不缩小（override 各维=需托底取该维 min，否则 0=该维跟随实际）/各维达标纯跟随。
  - runFlow 接线：读取 `viewportMinHeight`；高度声明时消费扩展形状（floor 施加 `{width:override.width, height:override.height}`，0=禁用该维 override 同 dsf:0 先例）；宽度-only 路径原调用/日志/形状不动（存量源断言面保留）。
  - goto 重申链：新增高度维度重申门控（`viewportFloor && viewport.height>0` 才读 `innerHeight`，实际 <minH-2 才重施加——宽度-only `viewport.height=0` 恒跳过，零回归）。
  - 现场/报告：高度声明时 `runner.viewportPlan` 记 declared/actual/below/mode，失败报告挂 `targetState.viewportPlan`（仅高度声明的 flow——宽度-only 报告零变化）。
- **selftest #79 组 7 用例**（新组，纯函数/fake，不依赖浏览器）：①宽度-only 3 参返回形状逐字不变（存量零变化回归）②仅高度 floor/follow ③双维度（双托底/仅高托底=宽 override 0/双达标）④缺席托底（高度地板生效+presence 探测失败保守+实测读不到 probePartial+双缺省 null）⑤在场不施加（skip+below 各维诊断+无 override）⑥validateFlow `viewportMinHeight` 缺省零误伤/合法/与 `viewportMin` 并存/非法指路 ⑦runFlow 接线源断言（高度分支先于旧 `viewportPlan` 路径+高度重申门控+现场字段 `targetState.viewportPlan`+宽度旧路径/旧 log 零回归）。**selftest 338 过 / 0 warn / 0 fail（ALL PASS；337→338，新增 #79 组）。**
- **文档**：playbook §视口与多分辨率兼容机制行+§flow 回放守则新增「视口高度地板」条（三态语义+独立声明+零回归+现场字段）；SKILL 文件地图 playbook 行补视口三态地板指针。
- **边界（如实标注）**：浏览器实弹（矮窗口/足高窗口对照 + floor 高度 override 跨端 CDP 语义）由 orchestrator 执行；`_meta.viewport`（单值对齐）与 `viewportMin`（宽度）/`viewportMinHeight`（高度）同声明时的胜出序：宽度或高度地板任一存在即走三态分支、旧 `_meta.viewport` 忽略（沿用 V202609280001 既有口径）。

## V202610190001 — 2026-10-19 [feature]

**`cdp.js locator` 元素捕获工具（用户明确要求 CLI 化）**——解决「元素捕获歧义反复试错」：flow 定位器多候选时诚实红不猜；收窄手段在三层嵌套 iframe 下各有局限（domPath 只在所在文档解析 / container text 可能解析到元素自身 / point 随布局漂移）。2026-10-19「现货锁定」实测同时命中主按钮+菜单项→3 候选→多轮试错。四态 = **probe 看候选 / suggest 递归收窄 / verify 高亮截图 / pick 点击拾取**。

- **`lib/locator.js`（新，零依赖 CJS）**：
  - `collectCandidates(client, sessionId, spec)`：跨全部**同源** iframe 递归收集候选；每候选带 `framePath`（`main>name>…`）/`frameIndexPath`（同名 iframe 精确定位）/`tag/id/cls/role/text/rect`（顶层视口坐标）/`visible`（rect+offsetParent(+fixed 祖先豁免)+visibility）/`offsetParentOk`/`hitOk`（elementFromPoint 命中自身/后代）/`area`/`cssPath`/`ancestors`（父→祖父 ≤12 层）。不可见/未命中项也如实返回供诊断，唯一性判定由 `uniqueness()` 做 X1 过滤。语义复用 `lib/target-resolver.js` 的 `GATE4_SRC`/`CONTAINER_STRUCT_SEL`/`normTextDesc`/`validContainer`（单源，不复制阈值）。
  - `suggestNarrowing(client, sessionId, spec, {collectFn?})`：**递归收窄算法**——多候选时取可点候选共同祖先（按 cssPath 交集，最近 depth 先试），每级构造 `container:{text,match:'exact'}`（文本为空/过长才 `{domPath}`）重算，第一个唯一即返回 `{ok:true,container,remaining:1,tried:[{level,depth,container,count,unique}]}`；无共同祖先/跨 frame/仍多候选如实 `ok:false`（`reason`），**不伪造收窄、不赌排序**。`collectFn` 接缝供纯函数单测。
  - `cssPathOf`：id 优先（文档内唯一才采用）→ class + `:nth-of-type` 祖先链（只用于显示/参考；domPath 是所在文档内路径）。
  - `highlight(...)`：优先 CDP `Overlay.enable`+`Overlay.highlightNode(objectId, highlightConfig)`（绿框+showInfo）+ **同步临时 CSS outline**（Overlay 是合成器覆盖层，`Page.captureScreenshot` 不保证包含——双保险确保截图可见）；`ms`（默认 3000）后自动还原，截图走 `lib/screenshot.js` 硬化通道落 `tmpdata/events/locator-<stamp>.png`。
  - `buildPickerScript()` / `buildPickerTeardownScript()`：一次性 **capture-phase click** 拾取器，递归安装到全部同源 iframe；拾取后立即 `removeEventListener` 自摘并写 `window.top.__cu_pick_result`；默认 `preventDefault+stopPropagation`（不触发业务动作），页侧 autoTeardown 安全兜底。`toTargetSpec(picked)`：text+`match:exact`（唯一）→ role → domPath + frame 提示。
- **`tools/cdp.js locator` 四态**：`probe`（候选清单+唯一性）/`suggest`（逐级 tried+建议 target JSON）/`verify --target-json`（高亮+截图+候选信息）/`pick [--seconds 60] [--no-block]`（注入拾取器→三层描述符+唯一性复算+建议 target）；全部支持 `--target` 复用现有页面选择、`--json` 机读、人读摘要。SUB_HELP/主帮助面/子命令注册/文件头清单同步。
- **selftest #78 组 6 用例**：cssPathOf（id 优先/class+nth-of-type）、uniqueness（visible+hitOk 过滤、非唯一不给 best）、suggestNarrowing 四态（共同祖先收窄/无共同祖先如实/cross-frame 拒绝/已唯一免收窄）、toTargetSpec 三层回退+frame 提示、picker 源断言（capture=true/一次性移除/`__cu_pick_result`/preventDefault+stopPropagation）、SUB_HELP 四态+注册+帮助面。**selftest 337 过 / 0 warn / 0 fail（ALL PASS）**。
- **文档**：playbook §逃生舱新增「§元素捕获方法论（locator 工具）」+子命令表行（行数 513→527，守门 540 内）；SKILL 文件地图/专题二决策树/排障路由表补 locator（「元素捕获歧义先用 probe/suggest，不要盲试多轮」）；README 逃生舱清单补 locator。
- **边界（如实标注）**：浏览器实弹（probe/suggest/verify/pick 四态 + 多层 iframe）由 orchestrator 执行；跨域/OOPIF 不收集不注入；flow container 跨 frame 不支持；本批**不动 lib/flow-engine.js**（工具层独立），未来按需接入。

## V202610150003 — 2026-10-15 [feature]

**popup-guard P1 落地（广告/推广弹窗拦截体系，李跳跳式；TODO 条目【广告/推广弹窗拦截体系（popup-guard，2026-10-15 用户提出）】四路线之 A 主路线）**——解决「纯序列 flow 无弹窗防护、电商促销弹层遮蔽即挂」（2026-10-15 淘宝 9.9 促销弹层 y≈220 恰未遮搜索按钮才侥幸通过）。

- **`lib/popup-guard.js`（新，零依赖 CJS）**：①guard 脚本生成器 `buildGuardScript(rules[,{dryRun}])`——IIFE 文本，可直接被 `Page.addScriptToEvaluateOnNewDocument` 预埋（先于页面 JS，广告不闪现）或 `Runtime.evaluate` 对已加载页即时执行；body MutationObserver（childList+subtree）+ 存量扫描，新节点按 `match.anyOf`（`{selector}`/`{textContains}`/`{rect:{minW,minH},zIndexMin}`；单 entry 多键=与）匹配 → `remove`（el.remove()）/`hide`（style.display='none'+data-cu-pg-hidden，保留 DOM 供误杀排查）；页侧留痕 `window.__cu_pg_log`（{ruleId,action,tag,cls,text,ts}，上限 200）；`html/body/head` 永不处置。②**规则加载器双层语义（2026-10-15 用户裁定，单点实现）**：`loadRules({projectDir,appSlug})`——webapp **无** `webapps/<app>/popup-rules.jsonc` → 用全局 `config/popup-rules.jsonc`；**有** → **以 webapp 配置整体为准（不与全局合并）**；app 配置存在但坏 → 如实报错不静默回落；`--popup-rules` 显式文件走 `loadRulesFromFile` 跳过二者。③`scope` 字段复用 matchers 分段锚定语义（页侧为镜像实现，非法/缺省 scope = 不生效，宁少勿滥）；④导出 `compileRuleSummary`（scan 报告）/`summarizeLog`（留痕归并）/`filterRulesByUrl`/`collectRuleIssues`/`TEARDOWN_SRC`（现场还原单源）。**红线源断言守护：guard 零合成事件（无 dispatchEvent/MouseEvent/.click()）、零网络层拦截（B 路线属 P3）。**
- **规则库三件**：`config/popup-rules.jsonc`（全局宽松基线：overlay-backdrop 类名族 + 中央大浮层 z≥2000，均 hide 起步，注释写明「宁少勿滥 + 必过 dry-run」）；`webapps/taobao-tmall/popup-rules.jsonc`（严格集：next-overlay-backdrop 遮罩族 / 9.9 元超值好物精选促销弹层文本 / 中央促销浮层特征；scope 单值故 taobao/tmall 成对登记）；`webapps/jd/popup-rules.jsonc`（保守起步 2 条，待实弹证据回填收紧）。
- **flow replay 集成**：`flow replay <file> --popup-guard [--popup-rules <file>]`——target 选定后、首步 goto 前预埋 guard + 对当前已加载页即时执行一次（覆盖「页面已开着」）；**finally 配对清理**（页侧 `observer.disconnect()`+清窗口变量 → `Page.removeScriptToEvaluateOnNewDocument`，失败/异常路径同样走到——共享浏览器是用户资产）；成功/失败/成功 verdict 三处输出拦截摘要（读 `__cu_pg_log` 归并：条数 + 规则 id），失败路径不丢留痕。**默认关：不加旗标时零注入路径（存量零改动）。**
- **`cdp.js popup-guard` 子命令四态**：`scan`（只读扫描当前页命中规则+候选节点：ruleId/action/tag/cls/text/rect/zIndex，零动作取证）/`test`（dry-run 注入观察 `--seconds`（1~600，默认 60）只记录不动作 → 输出「将拦截清单」，上线前误杀检验；结束摘除守卫）/`on`（页侧守卫真动作——**仅页内生效，刷新/导航后失效**，故不注册新文档脚本：进程退出不留注册残留；跨导航请用 replay 旗标）/`off`（幂等摘除，现场还原）。规则来源 `--rules` > `--app`/按 URL 识别的 app 配置 > 全局。
- **机检 selftest #77 组 8 用例**：加载语义四态（app 整体为准/全局 fallback/空 app 配置仍以 app 为准/坏配置不静默回落）、scope 分段锚定过滤（含裸域段数不等与非法 scope）、guard 脚本生成（含 `__cu_pg_log`/双动作分支/页内 scope 镜像 + 零合成事件红线）、vm 伪 DOM 行为（remove/hide/越 scope 不动作/留痕字段/stop disconnect/dry-run 只记不动）、scan 只读（零 DOM 变更、不装 observer）、纯函数归并、三规则文件 JSONC 合法性、replay 旗标默认关+配对清理+子命令注册源断言。**selftest 335 过 / 0 warn / 0 fail**（334→335，组级计数口径）。
- 配套：`install.js` manifest 白名单扩 `config/*.jsonc` 与 webapps 递归 `popup-rules.jsonc`（否则 copy/link 部署漏规则文件）；SKILL 文件地图/专题三补 replay 路径能力指针；playbook §专题三深度新增 popup-guard 节（用法+双层语义+还原现场纪律，行数守门 500→540——正式能力入库带预算上调，先例 V202610120001）；README 功能特性补一条。
- **未做（如实标注）**：T1-T3 浏览器实弹（淘宝 replay+guard 全过含拦截记录 / ERP 流程零误杀 / 还原现场验证）由 orchestrator 执行；P2（scan/test 子命令已随 P1 落地；全局规则库已建）+ P3（网络层 Fetch 可选路线、证据驱动回填）待后续；guard 不点 ×（合成点击灰区，MCP 模式 scanner 已有能力）。

## V202610150002 — 2026-10-15 [doc]

- **SKILL 红线 #11 登录态失效处置纪律（用户裁定）**：遇登录墙先确认真失效再找用户——刷新一次+重进观察（实证存在渲染问题/半加载态假性掉登录）；真失效=截图取证+等人工登录（凭据禁入 skill），登录前不得继续业务步骤；严禁绕路试探或无登录态硬跑出假绿。
- **TODO 新登记【广告/推广弹窗拦截体系（popup-guard，李跳跳式）】[复杂|新功能|高]**（用户提出+催办）：电商弹窗顽疾、replay 路径零防护（2026-10-15 淘宝 9.9 促销弹层侥幸通过实证）；方案四路线对比已定稿入条目——**A. DOM 层 MutationObserver guard 主路线**（addScriptToEvaluateOnNewDocument 预埋+规则匹配 remove/hide，李跳跳式直译，replay 旗标 `--popup-guard` 挂/摘自动还原现场）+ B. 网络层 Fetch 拦截（激进可选）+ D. 失败后置补救（兜底）+ C. 点 × 维持 MCP scanner 现状（合成点击不进 replay 路径）；交付三件=`cdp.js popup-guard` 子命令（scan/test/on|off 三态）+ replay 旗标 + **双层规则库（2026-10-15 用户裁定加载语义：webapp 无配置→默认全局宽松基线（防业务弹窗误杀）；有配置→以 webapp 配置整体为准（非合并）——淘宝类高发站可单独收紧）**（全局+应用域 jsonc，anyOf 匹配+scope 复用 matchers）；风险纪律=保守匹配+scope 收窄+test 模式 dry-run 上线门槛+证据日志回填；分期 P1-P3 与测试计划 T1-T5 全在条目内。待用户排期测试实施。

## V202610150001 — 2026-10-15 [feature]

**护腰复盘批五条全落地（用户授权「按推荐顺序实施所有可自主推进项」）+ 第二应用手册化简化首步（用户裁定：京东/淘宝商品搜索 flow 化）**：

- **S1+S2+S6 eval-helper snippet**：`snippets/eval-helper.js` v1.0（267 行）——unwrapEval（剥 fence+双重 JSON.parse，null 安全，根治护腰会话 4 次 TypeError 同根因）/probeHit（{done:false} 不算命中）/waitUntil（页面侧 await setTimeout 注入间隔轮询，替代盲等 sleep）/findClickable（空恒 items:[]、面积升序、CSS 视口坐标、可见性过滤）/chatgptDoneProbe（voice-btn 主+text-stable 辅+generating 反向闸）+ find→click→verify 三段模板；验证=fixer stub 烟测 36/36+真浏览器 E2E 七项全过；SKILL 索引表同步。
- **D1+D2+D3 MCP 交互模式纪律**：SKILL 红线 #10（同一目标连续 3 次不同策略未果强制止损严禁第 4 次；同法重跑不算不同策略）+ playbook 新节 §MCP 交互模式纪律（熔断止损动作/D2 大采集阶段性落盘/D3 先探后换+换法计数与 D1 联动）。
- **S3+S5 页签生命周期成规**：playbook 多标签管理节四条成规（url→pageId 映射登记+close 作废/同 URL 双页签即关一只/Promise.allSettled 并行模板+同域客服禁并行/报错后 list_pages 复核）。
- **D4 电商调研域内豁免**：playbook §操作路径红线新增条款（查看型循环+效果等价可豁免；首入口/业务写操作不豁免；不确定回退默认红线）。
- **jd/taobao-tmall 双手册+双搜索 flow**（第二应用手册化简化首步，2026-10-15 用户裁定）：①webapps/jd/webapp.md（matchers/识别特征/新版搜索栏/客服教训）+ jd-product-search.flow.json **9/9 全过+observer 视觉验证**——京东首页已改版（React 搜索栏 `input.jd_pc_search_bar_react_search_input`+`button.jd_pc_search_bar_react_search_btn`，经典 input#key 废弃）；②webapps/taobao-tmall/webapp.md（经典 input#q 存活/旺旺 iframe/next-overlay-backdrop/断连 checklist/CTA 配置）+ taobao-product-search.flow.json **7/7 全过+编排层收单实证**——**淘宝搜索=新 tab 打开结果页（按钮与 Enter 皆然，实测 ×3）**，原 tab URL/联想面板均不变=流内无可靠收单信号（引擎单 tab 模型边界），收单=编排层 targets/findTabs 查 s.taobao.com/search 新页签（webapp.md 已记操作面）；两 flow lint M1 补闸门后 0 违例；identify --assert-app 双双通过（matchers 生效+记忆化）。
- 台账：TODO 护腰批五条 [x] 关闭+四问视图同步+第二应用条目进展注记+INBOX 办结澄清行（2026-10-11 三条纪律吸收）。

## V202610140004 — 2026-10-14 [doc]
- **开页首选 openTab 指引强化（用户要求「chromeuse 要推荐 agent 首先使用新页签助手获取 pageId」）**：三处立规范——①SKILL.md 新增「开页与多标签（首选路径）」节（置于五步循环前）+「七类工具速查」导航/标签行注「开新页/取 pageId 首选 `openTab`」；②playbook「多标签管理」节+「pageId 与坐标换算」节同步「首选路径（推荐所有会话使用，勿手写 new_page→list_pages 校准）」，跨步骤引用/校验指向 findTabs/assertTab；③`snippets/tab-helper.js` 头部使用方式首行加 ⭐ 惯例标注。selftest 315/0/0。

## V202610140003 — 2026-10-14 [feature]
- **tab-helper v3 跨会话互斥锁（用户要求「给 openTab 加锁」；根治并发残余）**：pageId 并发残余（两会话同时 new_page 的极紧交叉）用「锁页 CAS」治本——锁载体=专用锁页（title=`__chromeuse_newpage_lock__` 空白页）上的 window 变量 CAS（**页面 JS 单线程 ⇒ 检查+写入原子**；实测 Promise.all 双并发「恰好一个赢家」；⚠ about:blank 的 sessionStorage 被 opaque origin 拒绝——CAS 用 window 变量，实测依据）；持锁窗口仅覆盖 new_page 序列（几百 ms），抢锁失败 12 轮重试（间隔=list_pages 往返充当——Code Mode 无 timer）→ 超时**降级无锁执行**（差集兜底，可用性优先）；30s 死锁过期抢占；锁页自动创建/重建（**只对空白页设标记**防污染真实页）、常驻无害（可手动关闭——仅降低并发保护）。**覆盖边界如实标注**：锁只协调「同用本 helper 的调用者」（用户手动/绕过者不在锁域）——与差集互补分层：锁=防极紧交叉，差集=无协调也安全。E2E：CAS 顺序/过期抢占/双并发恰一赢家/锁页协议/单开+带锁双并发（34/35/36 三 id 全对、跨快照轮正确走证据链+warn）/清理全净。selftest 315/0/0。

## V202610140002 — 2026-10-14 [feature]
- **共享浏览器页签助手 tab-helper.js（用户裁定修复批，v2 并发加固）**：根因=pageId 是「全浏览器全局递增序号」不可预测不可记忆（用户与 agent 共用浏览器，用户开过又关的页消耗序号——实测跳号 3→6；记忆必漂移）**且多 agent 会话可并发操作同一浏览器（两个模型同时 new_page）**——落地 `snippets/tab-helper.js`：`parsePages`/`idsSnapshot`/`selectNew`（**差集选择核心**：快照后新出现 id=候选集，单候选直取；多候选按 url 唯一→`[selected]` 证据链，均不唯一**不猜**（id:null+候选清单——对齐「候选>1 诚实红」纪律））/`findTabs`（按 URL/title 现查，selected 优先→id 降序）/`openTab`（**前置快照差集**自动接线；超时抛错 fallback 同差集逻辑；快照不可用降级全列表 max(id)+warn）/`closeTab`（容错）/`assertTab`（操作前身份校验，1 次只读 evaluate）。**五轮 E2E 实测**：跳号实证/同 URL 双页 11→12、13→14/**Promise.all 真并发双发**（先完成者差集=1 直取、后完成者 `[selected]` 命中+warn 降置信，双路皆中；极紧窗口残余=warn+assertTab 兜底）/三方并行窗口用户开页 9、10 活例/清理全净。playbook「pageId 与坐标换算」节+SKILL 索引表同步；TODO【new_page 返回页签标识直用（targetId 语义澄清）】条目关闭（四问视图同步）。selftest 315/0/0。

## V202610140001 — 2026-10-14 [doc]
- **护腰会话复盘批·TODO 登记（用户裁定，待确认后统一实施）**：复盘 2026-10-13「100-300元一体式护腰坐垫选购分析」会话（chrome-devtools MCP 交互式浏览器操作 291 次调用全量分析，orchestrator 提取+oracle 复核；完整报告=task-preview/reports/chromeuse-护腰坐垫会话实战问题分析报告-20261014.md）——TODO agent 区新增 6 条+四问视图同步+state §4.1 登记（实施顺序建议 S1+D1→S2+S3→手册）：①【MCP 交互模式纪律三条（D1+D2+D3）·高】操作级循环熔断红线（同一目标连续 3 次不同策略未果强制止损）——京造转人工 7 轮由用户打断的直接教训（MCP 交互模式此前零熔断，flow 引擎已有 retry≤1 等价物）②【eval-helper snippet 批（S1+S2+S6）】unwrapEval/waitUntil（页面侧探针内 setTimeout 规避 Code Mode 无 timer）/findClickable（空数组契约）——根治 4 次 TypeError 同根因（evaluate_script 返回包装文本全程 0 程序化解析、`x[0]` 取字符串首字符 truthy 致防御失效）③【页签生命周期成规（S3+S5）】diff 登记/同 URL 去重/close 作废/报错后 list_pages 复核④【jd/taobao-tmall webapp.md 手册建档】用户裁定轻量路径（只建手册不建 flows；未来方向=「搜索商品」flow.json 只固化稳定入口段）⑤【new_page 返回页签标识直用】3 案例实测：new_page 已返回带 [selected] 的页签列表可直接解析复用（本次未利用）；慢加载站 10s 超时抛错但页面实际已创建须 list_pages diff 兜底；用户所指 targetid=MCP 层 pageId⑥【拟人化红线③电商调研豁免条款（D4）】用户裁定口径=同任务内点击效果与 URL 直达等价时为效率可豁免。selftest 315/0/0（#6 断言 B 四问视图同步过）。

## V202610130003 — 2026-10-13 [feature]
- **引擎增强三件批（INBOX 10-11 开发候选按序落地）**：①**click 前置视口校验（advisory only）+失败诊断增强**——`Runner.noteViewportAdvisory`（centerClick 定位成功拿到 best rect 后单次只读 evaluate 读视口；best.rect=absRect 顶层视口累加坐标与 innerWidth/Height 同空间可比；任一轴右/下越界或负坐标 → log.warn「元素 rect(x,y,w,h) vs 视口(iw×ih)」+处置建议；`viewportAdvisory` 挂 runner 供 EFFECT_NOT_ACHIEVED 消息追加「元素坐标 vs 视口尺寸」对照（中心/越界轴）与失败报告 `targetState.viewportDiagnostics`；⚠ 硬约束=不改派发行为、不自动 scroll/resize，selftest #75 源断言守护）；②**cdp-core evaluate awaitPromise 可选参数**——第 5 参 `opts.awaitPromise`（缺省 false 存量零改动；returnByValue 下 resolved value 仍在 result.value 不二次解包）+ **stable 帧钟边界根治**（批三 V202609300016 残留风险条）：`cond.element.stable` 页侧轮询 IIFE 改 async，帧间 `await setTimeout(50ms)` 真正让出主线程，rAF/timer 跨帧推进假稳定风险消除；Node 侧 checkCond stable 路径接线 `{awaitPromise:true}`；预算 ms 自此为真实墙钟预算；已知边界如实注明=后台 tab rAF 仍可能被节流（timer 路径可用），**真实帧推进效果需 ERP 实弹（实弹待补）**；③**`flow lint` CLI 子命令**——cmdFlow 白名单+lint 分支：读 flow → parseAmbiguousTexts（webapps/<app>/webapp.md 解析，selftest #74 同口径；app 未登记/文件缺失 → 空清单继续跑+stdout「M2 跳过」）→ engine.lintContracts → 逐条输出（rule+步号+reason）+总结行；有违例 exit 非 0（对齐 validate），SUB_HELP.flow 补用法行——lintContracts 机检从 selftest 解放给日常 authoring。
- **selftest #75 组 6 用例**（件1 fake runner 超视口/负坐标/fail-soft+消息对照+报告挂载+硬约束源断言；件2 evaluate 透传三路+value 不二次解包；件3 cmdFlow/SUB_HELP 源断言+CLI 实跑 via-search 6 M1 违例 exit 1）；#73 B 组随 stable async 化同步改写（vm 子进程 await+源断言补 async/awaitPromise 断言）。selftest **315 过/0 warn/0 fail**（314→315——组级计数口径，同 #74 组 7 用例 311→312 先例）。

## V202610130002 — 2026-10-13 [fix]
- **#19 第 4 子项无 .git 环境自适应 skip+warn**：向上查找 `.git` 失败时（live 部署位 `/root/.config/opencode/skills/chromeuse/` 等）该子项输出 `WARN SKIP 仓库 .gitignore 检查（当前环境不在 git 仓内…）` 计 warn 不计 fail——live 自检不再误报 FAIL；git 仓内（骨架）行为完全不变照常检查。selftest 骨架 314/0/0 不变、live 0 fail。

## V202610130001 — 2026-10-13 [doc]
- **三仓合并路径适配批（v3/v4/v5 统一补记，随 Stage 7 live 对齐发布）**：skill 骨架随仓库结构演进完成三轮路径适配——v3 合并仓（`/app/coding-started-projects/opencode-started`、`opencode-skills/myopenclaw` 迁入 opencode 骨架）→ v4 子项目迁入 `projects/` → v5 coding-envs 归位 `coding-envs-started/`。涉及 SKILL.md（NAS 环境标记）/references/install.md/references/playbook.md（一键取证 cd）/state.md（材料包与运行产物路径）/**selftest/main.js #19**（根 .gitignore 断言串改 `projects/opencode-started/opencode/root/.config/opencode/skills/chromeuse/tmpdata`、去尾斜杠防子串假通过，文案同步）。selftest 314/0/0 ALL PASS（v4 后与 v5 后各复验一次）。同批 live 对齐：9 项共享文件覆盖复制至 live（含本 CHANGELOG/VERSION；`diag-liliao.flow.json` 补发 live）。

## V202610120001 — 2026-10-12 [fix+doc]
- **基线修复批（4 fail→0，313→314 ALL PASS）**：①CHANGELOG V202610090001 条目 type `[doc/feature]` 分隔符不符 #3 正则口径（`[a-z+]+` 支持组合但只认 `+`）→ 改 `[doc+feature]`（06ba59b 提交时未跑 selftest 遗留）；②playbook 行数守门 470→500（弹窗专题三入库后 485 行——正式能力入库带预算上调）；③**diag-liliao.flow.json 重建入库** `webapps/erp_demo_test/flows/`——原 `tmpdata/diag-liliao.flow.json` 随 2026-10-08 tmpdata 部署纪律双清永久丢失（gitignored 从未入库），按 #67 D 镜像断言 + 5a91902 姊妹版（inventory-lock 24 步原版）结构重建（领料锁定目标族/SumLock 泛化锚/desc 标注重建背景）；#67 D 用例路径 tmpdata→webapps；#74 棘轮基线同步（M1 +3：diag-liliao#10/#14/#16 姊妹版同款已论证形态；M2 +1：#7 wait 状态闸门豁免口径）。**教训定案：selftest 依赖资产一律 git 跟踪入库，严禁放运行态 tmpdata**。
- **state.md 交接收口（2026-10-12 快照）**：§0 更新至 V202610120001 现状（复测批 V202609300018~023 定案=服务端退化/弹窗专题三 V202610090001/10-11 INBOX 两条）；下会话第一优先改写为**代码实施候选入口**（用户预告新开会话实施 chromeuse 代码）；§1 版本指针/§2 批次表+基线/git 链/§4 待办（INBOX 开发候选+gate 补条）/§5.4 count 锚假绿教训/§6 验收数字全面同步。

## V202610090001 — 2026-10-09 [doc+feature]
- **新增专题三「营销弹窗关闭按钮定位」（淘宝实测定案）**：`snippets/popup-close-scanner.js` 成品（主脚本+验证探针）——锚点文本→向上定位弹窗容器（宽 400~1100×高≥250，跳全屏层）→容器右上角 elementFromPoint 网格扫描（right-3/top+3 起 120×96，步长 12）→候选清单（cls/rect/center/hits，全量不截断）供 `click_at`；点击后验证=rect 归零(0×0)/ANCHOR_NOT_FOUND。SKILL.md 四之三专题三浓缩决策树 + 文件地图/路由表接线；playbook §专题三深度（机制：a11y interestingOnly 过滤纯视觉叶子→× 无节点；class 候选须作用域限定+不截断；目测坐标实测偏差 64px 禁用；Escape 不生效）。
- **纪律教训入册**：弹窗关闭必须鼠标点 ×（键盘不可靠）；关闭后必须视觉确认（rect 归零/截图）才算完成——未确认连做后续步骤=全军覆没（本案例实录）。
- 机制备注：take_snapshot `verbose:true` 或可带出无名称叶子（待实测补验）；evaluate_script 单 frame 场景自动切元素所在 iframe（跨 iframe 弹窗可复用）。

## V202609300023 — 2026-09-30 [doc]
- **复测挂起定案（用户裁定：平时秒见三项）**：今日菜单项注入异常（开时 2 项+「库存锁定」26s~3min 高方差注入/180s 不注入/菜单 ~4min 自灭）=**测试服务端退化**（与同日测试库被清空同源），非引擎/flow 缺陷——flow V202609300022 结构对正常/退化两态容错（180s 注入闸门=预算上限非延迟，正常态秒过），待服务端恢复后补验整体两连过。
- 两笔测试订单 SL2609300001/0002 **保留至复测完成**（用户指示），复测通过后按「先明细行后表头」删单（全程录制留证）；本复测批全程零确认/零提取/零保存操作（用户不可逆红线完好）。
- webapp.md 登记菜单注入行为知识（正常态秒开三项 vs 退化签名）+ 人工区复测条目进展更新 + state.md 下会话第一优先改写。

## V202609300022 — 2026-09-30 [fix]（复测进行中批次——注入异常未解，暂停待用户澄清）
- **有数据复测发现「库存锁定」菜单项注入异常（应用/服务端侧）**：「现货锁定」下拉开时仅 2 项（现货锁定/锁定查询），「库存锁定」注入实测 26s~2.7min 高方差（两次 keep-tab 探针实证），且 r7 180s 闸门全程未达（存在 >3min/不注入 case）；菜单另有 ~4min 自灭行为（17:44:11 探针三项齐全→17:45:01 菜单项消失）——超出 flow 层可解范围，复测暂停，待用户澄清该菜单正常态行为（人工是否秒见三项）。
- **flow 迭代史（018 单击穿透模型→019 anyOf element 锚+init 收敛垫→020 注入等待 effect→021 30s 闸门→022 180s 闸门）**：全部基于逐轮实证收敛；当前 23 步结构（收敛垫→单派发点击→180s 注入闸门→菜单项定向点击→anyOf 双出口→截图→ESC）；r2 实证 count 锚数隐藏 .gongqi-warn 模板假绿（4ms 过闸）——**count cond 不验可见性、弹窗类锚必须 element 可见性语义**的教训定案。
- **引擎 schema 补齐（已验证）**：validateFlow 的 wait/assert cond 支持 anyOf 数组形态（对齐 checkCond 运行时 L711 与 effect.cond 校验先例 V202609300016）——selftest #73 组 D4 用例；应用侧 #18 断言同步新模型；#74 M1 基线同步；selftest 313 过/0 fail。
- 复测数据：两笔测试订单 SL2609300001/0002（用户 16:30 造，已创建态）仍在账套——删单按用户指示待复测结论后执行。

## V202609300017 — 2026-09-30 [feature]
- **契约批落地（合议路线收官批；fix-1 实施+orchestrator 独立复验 312/0/0）**：`lintContracts` 纯函数机检三条铁律——**M1** 闸门-点击同描述符 lint（豁免通道：gate 字段/状态闸门 desc 标注/同身份点击链连续；ms settle 步不切断窗口）、**M2** 歧义文本登记检查（ambiguousTexts 作 target 无 container/unique 红；wait.text 状态闸门合法不查）、**M3** 盲等证据引用 lint；存量违例**冻结基线棘轮**（M1 15 条/M2 4 条精确相等，新增即红、修复可缩减——delivery#21「单据」未收窄=真实债务标注）；**M5** 候选扩散 advisory（locate ok 且 best 与次优跨 frame → log.warn+失败报告顶层 ambiguityRisk）；M4（审计⑧）盘点确认已随 V202609180003 落地不重复。selftest #74 组 7 用例（含 M4 防误删回归+存量全量棘轮+M5 fake runner），selftest 311→312。
- **合议路线六批全部收官**（批一/2.5/二/2.7/三/契约——加上 flow 批定稿与验证批）。残留风险：基线步号锚（flow 插步需同步 #74 基线）/M2 依赖 webapp.md 表格格式/M5 仅 frame 维度/lint 暂不进 CLI（`flow lint` 子命令属新范围）/状态闸门豁免依赖 desc 字面标注（存量「闸门A/B/C」措辞未走豁免，flow 定稿统一措辞后基线可缩减）。

## V202609300016 — 2026-09-30 [feature]
- **批三四原语落地（合议路线批三，oracle 报告 §3.3 规格；fix-1 实施+orchestrator 独立复验 311/0/0）**：①`click.gate: <ms>`——dispatch 前与点击完全相同描述符的定位循环（**clickTarget 单点提升**=同源机制保证，偏差①：避免 withKind 第 5 处接线破坏 #41/#48 哨兵）；②`cond.element.stable: {ms,polls}`——rect 连续相等（±1px）才算真的页侧轮询 IIFE；③`target.unique: true`——候选>1 → `TARGET_NOT_FOUND(ambiguous)` 诚实红附候选全量（仅 text 层）；④`effect.cond` anyOf 数组形态（任一达成即真、短路、单元异常不传染；centerClick effect 预检同享语义）。全部 opt-in、存量 flow 零改动（#44 全量校验零误伤实证）；schema/白名单/校验同步（gate 正整数+运行时预算裁剪 / stable ms 1-10000+polls 1-10+absent·hidden 拒收 / unique 布尔类型）。
- **selftest #73 组 11 用例**（A gate schema+fake client 控制流+接线源断言 / B stable vm 轮询四态+源断言 / C unique vm 集成+源断言 / D anyOf schema+控制流+源断言），selftest 310→311；残留风险登记 playbook（stable 同步 evaluate 帧钟边界——根治需 cdp-core awaitPromise 另立批次 / unique 仅 text 层 / gate 超时不外层重击 / anyOf 多 network 单元串行窗口）。

## V202609300015 — 2026-09-30 [doc]
- **E1 多标签 A/B 刻意实验完成（INBOX 09-18 ② 办结）**：同 flow（inventory-lock）三臂对照——基线 1 标签点击链 264~531ms/步 → 4 标签并存 5271~5521ms/步（**10~20 倍劣化**，与 09-18 天然对照 5.2s/步同签名）→ 清理后恢复轮 258~535ms/步（**立即复原**）；wait 轮询步骤全程 ~1.2s 不受影响=劣化集中在交互定位/派发链（会话互踢特征，排除服务端疲劳累积解释）——**标签卫生纪律（ERP 标签 ≤2/取证完即关/轮次间隔 ≥2min）自此有刻意实验背书**；playbook §标签卫生数字补强；state.md §4.1 #3 结项。
- **INBOX 三行**：E1 办结行 + 勘误澄清行（09-30 晨「矮窗口=唯一残余」定性部分失效——矮窗口在数据尚在时成立，午后主因切换为空网格前置）+ 阻塞行（delivery 步骤 31 重锚被空数据阻塞、与完整场景复测同捆）。
- 臂 B 顺带实弹验证 V202609300014 可观测性消息（「真实派发 2/2 次，末次派发 @828,824」——4 标签压力下引擎照常派发）。证据：tmpdata/e1-arm{A,B,C}-*.log。

## V202609300014 — 2026-09-30 [fix]
- **deepInteract.overlays 跨文档化（失败报告可见弹窗假象根治）**：docs 走查单例提顶（overlays/dropdownMenus 复用同一次走查，不再各自为政），.modal/.mloading/.layui-layer-shade 逐同源文档可见计数 + 新增 overlaysByDoc 明细层——原 TOP-only 探针数不到挂 app 文档的 .modal 弹窗（终验五轮 overlays=0 假象而 WARN 常驻可见的结构性根因，实锤=示例ERP WARN 类名 `modal gongqi-warn` 挂 layui-layer-iframe5 文档）；样式读取改 `el.ownerDocument.defaultView.getComputedStyle`（跨文档正确性）。selftest #67 12→14 用例（overlaysByDoc/走查单例/消息可观测性源断言）。
- **EFFECT_NOT_ACHIEVED 消息真实派发计数**：click case 新增 realDispatch（mouseClick 派发即替换 lastClickXY 引用——身份比对；attempts 是尝试数含 gone 跳过/合法跳过），消息改报「真实派发 N/M 次，末次派发 @x,y」+ 0 派发分叉提示（gone 跳过路径）——尝试数与真实派发数不再混同。
- **勘误（V202609300012「933 三连零派发/verifyHit 几何缺陷」系误诊）**：lastClickXY 真身在 targetState 层（V202609300004 字段），deepInteract 对象内无此键，`.get()` 读缺失键得 None 被误当零派发；实证三份失败报告全部有派发坐标（899 轮 @828,824 / 933 两轮 @828,858——+34px 与按钮帧内 rect 位移 831→865 完全同步）——引擎定位/复核/派发链两几何下均正常，verifyHit ±6px 无缺陷，不作引擎改动；终验结案结论不变且证据更强（全轮真派发+WARN 常驻）。三条 TODO 归档（verifyHit 条目以误诊勘误关闭，附「报告字段先验键存在性」教训）。

## V202609300013 — 2026-09-30 [doc]
- **回放失败视觉优先纪律硬化（TODO 条目结案归档）**：playbook §flow 回放守则新增「失败处理顺序=视觉优先」条目——回放失败后第一动作=读 flow-fail 终态截图/视频末帧，确认页面实际状态（弹窗/遮挡/空数据/走到哪步）**之后再做任何结构化分析**（日志/失败报告 JSON/引擎源码/flow 改动）；含 V202609300011/012 实锤案例（终态截图已含 WARN+空网格一眼可见，却被五层结构化分析掩盖致白跑一轮——用户裁定点名）与配套注意（deepInteract.overlays 只查通用覆盖层三选择器，应用级弹窗不在其中，overlays=0 ≠ 页面无异常）。

## V202609300012 — 2026-09-30 [doc]
- **inventory-lock 终验结案（用户裁定验收口径：原版 flow 跑至失败点，截图/视频/事件证据确认失败=没数据导致弹窗报错即算通过）**：结案证据链=final-r1（lastClickXY=(828,824) 真派发+观察者视频帧确认 WARN「请选择销售订单」+footer 共 0 条，1898×899 原版 flow）+final-r3 keep-tab 探针（WARN 可见+共 0 条+现货锁定 enabled+锁菜单 UL display:none）——失败=空网格业务前置（无选中行→点按钮直接弹 parent WARN 不开菜单，用户业务确认）；完整场景复测由用户另安排（人工区【inventory-lock 完整场景复测准备】）；主条目【销售订单模块深交互无响应】关闭归档（TODO.md.bak）。
- **verifyHit ±6px 容差致 1898×933 几何零派发（新登记 TODO ①区）**：accept-r1/r2/r3（933）步骤 16 三连零派发（lastClickXY=None 3/3）vs final-r1/r3（899）两跑全派发，步骤耗时同档排除慢轮假设——'gone'→判成功跳过派发（flow-engine.js:518，语义源自自移除目标，对持久按钮=假 gone）+effect 守卫诚实红但 retry:2 两次 attempt 仍零派发；**可观测性缺口**：_goneDetail 只走引擎内部 log（CLI stdout/失败报告均无）；修法候选=gone 时全量四层重定位/容差自适应/诊断落报告。
- 证据留档：tmpdata/inventory-lock-20260930-accept-r{1,2,3}.log + tmpdata/flow-fail/flow-fail-2026-09-30_11-0*.json/png + tmpdata/video/replay-2026-09-30_11-*。

## V202609300011 — 2026-09-30 [doc]
- **inventory-lock 终验三连跑+空网格前置定案**：1898×899 足高几何三连败（步骤 16/17 EFFECT_NOT_ACHIEVED）——「矮窗口=唯一残余」被推翻；keep-tab 只读探针（tmpdata/erp-empty-grid-probe-20260930.json）实锤=销售订单网格共 0 条→无选中行→点「现货锁定」按钮直接弹 parent WARN「请选择销售订单」不开菜单（按钮级前置语义；WARN 挂 app 文档可见+锁菜单 UL 表单文档 display:none）；引擎七层修复被反证有效（run1 lastClickXY=(828,824) 真派发+应用诚实业务响应）。
- **误诊闸门回滚**：禁用窗假说（ErpFormItemButtonMenu:not(.disabled) 解锁闸门）实弹证伪——现货锁定按钮实为 enabled（disabled=制单/检查/功能），闸门已回滚未入库。
- **视觉优先执行失守复盘（用户裁定「视觉兜底在哪里」）**：首轮失败终态截图已含 WARN 一眼可见，agent 先做结构化分析致白跑一轮——新登记四条：回放失败视觉优先纪律硬化（playbook 待补·高）/失败报告可见弹窗 advisory（overlays 只查通用覆盖层三选择器不认 .gongqi-warn·中）/EFFECT_NOT_ACHIEVED 派发计数失真（attempt 数≠真实派发数·中）/人工区【销售订单测试数据恢复】（高）。
- webapp.md（erp_demo_test）：空网格按钮级 WARN 语义+按钮 enabled 分化+锁菜单 UL 存在但 display:none+测试库数据易变登记，last-verified 2026-09-30。
> 唯一版本真源是 VERSION.md（仅一行）；bump 唯一规则：经推广流程合入 = 流水号推进 + 本文件一条 + git commit。
> INBOX 追加不 bump；语义类型（[fix]/[feature]/[doc]）由条目标签表达，不进数字。

## V202609300010 — 2026-09-30 [doc]

- **迁入骨架 skills 统一目录（repo 结构变更，功能零改动；v65）**：源码自 `opencode-skills/chromeuse/` 整体迁入 `opencode/root/.config/opencode/skills/chromeuse/`（仓库骨架 /root 种子内；git 历史随迁；live `~/.config/opencode/skills/chromeuse` 符号链接重指新位置）。同步：仓库根 `.gitignore` 六条运行态路径规则、selftest #19 仓库根定位改「向上查找 .git」、README / references/install.md / references/facts.md / references/playbook.md（doctor-forensics 命令）/ state.md 路径字样。运行态目录（tmpdata/reports/log/bin/config.jsonc）语义不变。**今后所有 skill 开发统一在此目录**（新 skill 直接建于 `opencode/root/.config/opencode/skills/<name>/`）。

## V202609300009 — 2026-09-30 [fix]

- **flow 定位精确化 + 容器陷阱移除 + 深交互根因知识定案**：①inventory-lock/diag-liliao 现货锁定 click 加 match:exact——引擎 locate 的 substring 匹配会命中**按钮组包装 div**（「现货锁定Toggle Dropdown」文本含子串且赢得候选排序，按钮本体屈居第二）；exact 后唯一候选=BUTTON 本体。②effect/gate/click 三处 container ul.dropdown-menu 全部移除——**多菜单文档 domPath 首匹配陷阱**（form doc 有制单/上下查询/锁菜单三个同名 ul，首匹配=隐藏制单菜单→「首匹配不可见即容器判失」→cond 永假；r7 实弹：点击真命中+锁菜单真创建，effect 却 12 次求值全 false）。③机检同步（#18/#67 断言去 container 判据）。④webapp.md 深交互根因定案修正版（四层机制+主次归因）。⑤**残余定案**：浏览器窗口高度不足（<~900px，当前 Selkies 1705×664）时底栏下拉开在表单文档视口外（按钮贴底 y~645/664，菜单向下开越界→gate4 elementFromPoint null）——r7/r8 实弹 lastClickXY 命中+菜单创建但 effect 永假；1898×899 高视口下完整可见（09-29 obs 图 1 实证）。终验待足高窗口复跑或 viewportMin 高度维度 schema 扩展。

## V202609300008 — 2026-09-30 [feature]

- **doctor-forensics 一键取证子命令 + CDP 失效分型取证协议 v1**：oracle 设计（reports/CDP失效分型取证协议-oracle-20260930.md）全量落地——lib/forensics.js（judgeLayers 八层纯函数 M/A1/A2/B/C/D/E/F+G+parseSymptomChannel+E_LIMITS 单源）；tools/cdp.js 新子命令（S0-S5 探测序列硬帽 120s、**通道全死也照常落盘**、对照 tab 自开自关豁免、--no-front 在场礼仪、exit 0=落盘完成/1=取证失败、绝无 exit 2）；doctor 重构共享 collectBrowserSnapshot 行为零变化；playbook §逃生舱新节（八分型速查+runbook Step0-4+分型→恢复动作映射+重启批准线三级分层：gateway restart 不杀 tab < browser-restart < 容器重启）；SKILL.md 排障路由行；selftest #66。**最高价值增量=M 层**（MCP 长连接被 gateway nginx proxy_read_timeout 1h 掐断→半开死亡，「重启浏览器治好」实为误归因；cdp.js 短连接天然免疫=判别探针；低成本恢复=restart opencode 不杀 tab）。环境勘误入账：浏览器镜像 09-28 已升 b1ee1dc8-ls55、sidecar 更名 chrome-browser-gateway、cdp-watch 命名空间孤儿化自愈语义。

## V202609300007 — 2026-09-30 [fix]

- **跨文档复核嵌套 iframe 祖先帧盲区**（V202609300002 自身缺陷，r6 实弹）：判定从「命中链到达最内层 frameElement」改为**祖先帧链集合成员检查**——depth≥2 目标 TOP 命中物理上只可能是最外层祖先 iframe，旧逻辑把祖父帧误判兄弟层→blocked-cross-doc 假阳性；集合不完整（跨域 frameElement null）保守放行；覆盖层判定与完整性无关恒有效。#72 组 6 用例+#67 mock 物理保真修正（断言语义零改动）。

## V202609300006 — 2026-09-30 [fix]

- **X1 fixed 祖先豁免 + text 零候选回退误击防线**：gate4 L2 的 offsetParent===null 判定补祖先链检查（position:fixed 祖先的子元素 offsetParent 恒 null——旧码与 display:none 同判为隐藏；GATE4_SRC+visRect 快捷两处同步）；**回退误击防线**：text 层零候选=无条件四层全败（旧码 {text,near}/{text,grid} 组合会回退到无文本约束层产生文本不符候选=误击面；存量 flow 零组合用法、爆炸半径零）。#71 组（gate4 六态+vm 集成+回退防线）。注：fixed 祖先假说对本案按钮实证不成立（offsetParent=BODY 全链 static）——保留为通用正确性补强。

## V202609300005 — 2026-09-30 [fix]

- **gone→跳过派发 effect 守卫（存量暗雷终修）**：centerClick 的 X4 'gone'→'success'→静默跳过 dispatch 路径——配 effect 的 click 步不再直接跳过：效果预检达成才合法跳过、未达成照常派发（**效果闸门=「点击已完成」语义唯一权威**）；无 effect 步存量行为零改动（自移除目标族语义保留）。verifyHit 'gone' 带诊断（重找候选数/最近Δpx/两侧 rect——假 gone 日志可见）。实证链：coords-probe 单步 click ✓ 178ms 但 lastClickXY=null（mouseClick 从未被调用）——**该按钮引擎点击自 09-07 起从未真派发**（09-10「兜底 click_at 一次命中」=手动绕开此暗雷）。#70 组四分支。

## V202609300004 — 2026-09-30 [fix]

- **mouseClick 悬停安定间隙 + 点击坐标可观测性**：mouseMoved→mousePressed 之间加 MOUSE_MOVE_SETTLE_MS=50（单点插入覆盖单击/dbl/rightClick 三路径；V202609090004 桌面图标族「零间隔连发无效」同构——当时只修 press↔release hold 漏了 move→press）。点击步成功行带 @x,y + 失败报告 targetState.lastClickXY（派发坐标从不可见变为日志直读——今晚排障关键缺口）。#69 组源断言哨兵。

## V202609300003 — 2026-09-30 [fix]

- **click 效果感知重试（gate-verify-retry 三明治引擎化）+ flow 视口现代化迁移**：click 步可选 effect={cond, timeoutMs≤10000}——派发成功后轮询效果，未达共用 retry 预算退避重击，全败抛 EFFECT_NOT_ACHIEVED（与派发失败 TARGET_NOT_FOUND 错误类型分开，消息含求值状态摘要）；inventory-lock/diag-liliao 现货锁定 click 配 effect+retry:2；_meta.viewport→viewportMin 标量 1920（三态语义：在场纯跟随/缺席托底不缩小/达标跟随）。#68 组五场景+app #18 viewportMin 口径。

## V202609300002 — 2026-09-30 [fix]

- **X4 跨文档遮挡复核**：buildVerifyExpr 目标在 iframe 内时 TOP 文档 elementFromPoint 二次复核——命中链落别的 iframe/通用覆盖层（.modal/.mloading/.layui-layer-shade，排除 pointer-events:none 装饰层）→ 'blocked-cross-doc' → TARGET_NOT_FOUND 可归因红（「✓ 但没发生」假绿结构性根治第一步；parent 文档覆盖层对同文档复核不可见的盲区补上）；链耗尽保守放行。#67 组五态+通用类名红线源断言（engine 内不出现应用专属类名）。附 buildVerifyExpr 模板字面量 \s 转义真 bug 顺修。

## V202609300001 — 2026-09-30 [fix]

- **引擎加固批（click 有界重试 + deepInteract 失败快照 + flow 闸门三明治）**：click 步 retry 字段（默认 1，1-3；clickRetryBackoff 退避 600 基距帽 3s+步预算裁剪不睡穿）；失败报告 targetState.deepInteract（TOP 覆盖层计数+最近点击 TOP 命中链+各同源文档 ul.dropdown-menu 计数——零成本把「零响应」变可归因；首战即中：无覆盖层+命中链直达+锁菜单未创建三证据）；inventory-lock 尾段改造：menu-open 闸门三明治（cond+150ms 静置+复评双查——同步 DOM 效果 <100ms 过闸非 M4 假绿）+ 库存锁定 assert 双出口（saOrderSumLock 表单或 gongqi-warn 弹窗——obs-4 实证 WARN「请选择销售订单」=业务前置未满足的诚实信号）+ 尾部 ESC 清场（WARN 点遮罩不关、退出=X/确认/ESC）；diag-liliao 镜像同步。
## V202609290002 — 2026-09-29 [fix]

- **inventory-lock/diag-liliao 末段改名链修复 + 多端在场零干预实证 + 销售订单模块深交互残余登记**：①**flow 改名修复**——物料域更新后模块底栏按钮「销售订单库存锁定」改名「现货锁定」（下拉菜单项=库存锁定/现货锁定/锁定查询，懒创建=首次成功展开才注入 DOM）：inventory-lock 步骤 15/16（wait text 库存锁定→现货锁定、click 同改）+diag-liliao 镜像修复（闸门+target+改名），最小行编辑零格式噪音。②**实弹验证链**（历史首次推进）：掣肘链全通——弹层死亡自愈（步骤 0-11 含弹层闸门 32ms/580ms 过）；:focus 闸门 4-7ms；type 通过（探针修复生效）；树项双击→**模块打开 OK**（网格/页签/底栏全渲染，obs 截图实锤）；改名后闸门「现货锁定」29ms 过。③**多端在场零干预实证**（用户裁定场景：小新/ROG/米14 不同分辨率缩放打开 Selkies）——失败报告 viewportSkipReason='user-present' 铁证：在场时回放零 emulate、分辨率全程纹丝不动。④**残余登记**：销售订单模块深交互元素无响应（底栏菜单按钮/侧栏直接项零反应；送货单模块对照正常；同族 09-28 E6）——新条目入库跟踪，不阻塞本次改名链结论。⑤r4/r5 头段（步骤 9 弹层渲染）二连挂=环境相位接线时序（同刻交互直测弹层秒开=非流程缺陷），记观察项。

## V202609290001 — 2026-09-29 [fix]

- **type 写后读根因链修复（P0-1 断言帧盲假阴性 + 重试退避配套）**：①**真根因（帧盲假阴性）**——写后读探针顶层 `document.activeElement` 对弹层 iframe 内输入框恒 len:0（--keep-tab 帧遍历探针实锤：`top/layui-layer-iframe5` 内 INPUT#searchInput 值="销售订单…"文本一直正常落入）；修复=`buildInsertVerifyExpr(needle)` 帧遍历探针（docsWalk 同构：逐文档 activeElement contains 检查，跨域跳过，MAX_DEPTH=4，逐文档诊断串）+selftest 三组（Node mock/Chrome 同源 iframe 真管线/源断言）；「45s 焦点 churn」表述作废。②**重试循环配套**（原缺陷：3 次背靠背重试全落假阴性窗口+慢点击吃满步超时）——已聚焦跳过重击（isTargetFocused 廉价判据：id/domPath/tag，保守 unknown 照旧点击）+失败有界退避（2500×attempt 帽 10s，步预算裁剪不睡穿）+selftest 扩 #34 组。③webapp.md 已知坑勘误（timeoutMs ≥30000+根因备注）。selftest 299 过/0 warn/0 fail。

## V202609280002 — 2026-09-28 [feature]

- **视口策略三态动态化（方案 B，用户确认——多设备访问：不同分辨率/非电脑/桌面端 Windows Chrome 均兼容，自适应不写死）**：flow `_meta` 新增可选 **`viewportMin`**（最小布局宽度地板，如 winui 双击路径声明 1920）。三态语义：①**在场永不 emulate**（低于 min 只打 advisory 告警，失败报告实测视口天然可归因）②**不在场托底** max(vmin, 实际宽) 永不缩小（floor）③**实际已达标纯跟随**不施加 override。纯函数 `viewportMinPlan` 七态决策表（含 presence 探测失败保守 floor、实际宽不可读 probePartial）；旧 `_meta.viewport` 存量语义零变化、vmin 声明时胜出（log 说明）；goto 重申链加 floor 分支（仅 `iw<min-2` 才重施加——修复直接复用会违背「永不缩小」的隐性缺陷：原 Math.abs>2 条件会把 2560 缩回 1920）；floor 的 `height:0`=禁用该维 override（CDP 语义同 dsf:0 先例）高度恒跟随实际。validateFlow 可选校验（有限正数 ≤4096+指路文案，缺省零误伤——webapps 5 flow 全过）；selftest #65 扩组 3→6 用例（**299 过/0 warn/0 fail** 持平）；playbook 三态表述一行换一行（400/400）+distill 质量清单加宽布局依赖声明条。连带消化【录制视口硬编码多分辨率适配】研究项方向①（视口参数动态化）。**遗留**：桌面端 Windows Chrome 9222 实测待用户配合（一并验证 floor height:0 的 CDP 语义跨端一致性，人工区已登记）。

## V202609280001 — 2026-09-28 [doc]+[feature]

- **用户在场视口自适应（用户裁定当天机制化）+弹出容器机检补全+E6 面板旁路判别实验**：①**引擎级视口自适应**——用户裁定「共享浏览器已有页签=在场，禁 emulate 录制视口（缩成怪分辨率很难受），自适应现有分辨率；无既有页签才自由」：runFlow 在 override 前 Target.getTargets 探测既有页签（排除自建/--target 标签），≥1→skip 不 emulate（log+失败报告 viewportSkipReason='user-present' 如实可归因）；=0→存量对齐；探测失败 fail-soft 保守 align。决策纯函数 viewportPlan 四态（selftest #65 组 3 用例，**299 过/0 warn/0 fail**）；playbook 标签卫生话题区加一行纪律（400/400 等量压缩保持）。②**弹出容器注意力规则机检补全**（state §4.1 跟踪项清账）：selftest #64 组 3 用例锁三处规则锚文本在位（playbook 纪律⑥ container 硬收窄/distill 弹出容器注意力条/webapp 领域语义节——防未来文档重构静默丢失）。③**E6 面板旁路可达性判别实验**（b-2 迁移实证，四连跑）：面板路径全通到壳+侧栏（示例ERP→物料域→销售管理图标单击→壳初始化→侧栏组展开+完整模块菜单树加载=菜单数据链活）；侧栏「销售订单」**直接菜单项**三交互全灭（click+dblclick 零视觉反应帧取证/单 click 证伪/Enter 证伪）——**对照实验定案**（delivery flow 同晚重放通到步骤 30：单据子组 treeview 行 opener 有效、模块表单正常加载=模块装载无通用回归）→ 直接项特异性静默死，与 09-19 弹层死亡同签名（零请求零报错）指向域更新后注册表回归，并入同事核查回报面；DOM 对照探针=直接项与子组项完全同构（LI.treeview.menuItem）。**b-2 迁移实证成立**（面板路径对单据子组族模块全通）。附：登录态过期恢复（os-login-goto 5/5）；run3 泄漏标签清理+--target 完整 ID 纪律再实证。

## V202609220003 — 2026-09-22 [feature]

- **截图通道兜底体系（用户催办条目落地，实现单源迁 lib/screenshot.js）**：①**fromSurface:false 诊断裁决降级**——judgeMatrix 纯函数代码化 facts.md 判读矩阵（runtime ok→allowFallback+coldStartSuspect/runtime 败→禁降级 broad-block/true 败 false 成→path-divergence；禁止无条件切换），降级结果入矩阵作诊断信号 ②**失败诊断矩阵**——截图失败同发 Runtime.evaluate+Page.getLayoutMetrics+双路径三探针，chromeuse-screenshot-fail/1 失败报告平铺 runtimeCheck/layoutMetricsCheck/fromSurfaceTrue/fromSurfaceFalse/verdicts/controlShot/backoff+screencastFallback+hint 判读指引（含 DOM 快照 exec Page.captureSnapshot 降级建议）④**冷启动停滞退避**——backoffSchedule env 可配（CHROMEUSE_SCREENSHOT_BACKOFF，缺省 2s/5s/10s 总窗 17s<20s 自愈窗纪律、单档帽 60s 总帽 5min），对照截图判别法机制化（09-21 INBOX 判别法）+每档轻探针复查、runtime 转死立即中止 ③**screencast 活跃帧兜底**——latestLiveFrame 只读扫 tmpdata/video 会话 index.json（零改 screencast 接口）60s 时效窗+saveFrame（bin/ffmpeg 在位真转码 png/否则原字节 .jpg 如实注记），advisory 定位+合成器冻结期同死边界如实标注。原 hardened 语义（bringToFront+重试）原样保留、doctor screenshotProbe 裸通道不回退（selftest 断言锁死）；成功输出增 via=/退避恢复标注。验证三层：selftest #63 组 6 用例（**295 过/0 warn/0 fail**）+fake-CDP 真 WS 管线集成 4 场景 24 断言（降级成功/全局冻结全字段/档内恢复/冻结+新鲜帧 png 文件头）。遗留：实弹随自然会话；DOM 快照兜底=hint 指引级；帧兜底跨 tab 归属不保证（index 无 URL）。

## V202609220002 — 2026-09-22 [feature]

- **录制定位素材增强：语义事件采集 domPath+aria 名（Jev P0 终审落地，MIT gate 已过）**：录制期对语义动作事件自动采集定位素材（稳定 CSS path+aria role/name）落独立素材文件，供蒸馏直接抄作四层链③层兜底。选路=**页侧生成**（事件时刻 e.target 必活/uiAppear 双时刻采样证明 DOM 易变/零 Runtime.evaluate 往返——+200ms/整段预算轻松达标）→事件批次随行→Node 侧哨兵门控剥离→`locate-materials-<stamp>.jsonl` 落盘（paths 单源 LOCATE_MATERIALS_PREFIX+locateMaterialsPath，与事件流同目录同 stem）。六约束逐条：六型动作白名单（click/dblclick/contextmenu/input×2/change/paste——mousemove/scroll 热路径零采集）+连击同目标去重；稳定 path 八纯函数（nth-of-type 优先/动态类判定截断 layui/react-/:rN:/长哈希/深度长度双帽）；**aria 优先排布**（09-21 chatgpt 漂移实证 aria 存活）；SVG 降级 degraded；跨 iframe=frame 内局部 path+FRAME 标识（MV）；哨兵 OK 才采集；**事件流 chromeuse-events/1 形状零变化、不进 flow schema 不进执行链**。selftest #62 组 6 用例（**294 过/0 warn/0 fail**）+vm 真实 recorder IIFE 端到端冒烟+77 flow 零影响。遗留：实弹随下次实录自然核对；drop 落点白名单未纳入（一行扩展位）。参考=Jev snapshot.js 思路（MIT 已核，.slim/clonedeps 入库，仅借鉴未复制）。

## V202609220001 — 2026-09-22 [doc]+[fix]

- **Jev 吸收第一批落地（条款文档+前置告警）+ LICENSE gate 定案**：①**LLM 目标引用安全边界条款（Jev P2 终审落地，纯文档）**——playbook 新节 `§LLM 目标引用边界`（**稳定节锚**承接机器可引用性：运行期 LLM 只能引用观察到的节点引用（index/uid/text+container），禁推测直产 selector/坐标/JS；豁免=作者离线声明的 domPath/point ③④层合法+evaluate_script 只读合法（关联红线#1）；蒸馏产物来源可追踪走报告/证据包外部映射文件不进 flow schema）+SKILL 红线区**非编号引用**（1-9 编号原样不动）+distill.md 质量清单两条（定位证据来源标注/wait ms 值须来自录制实测间隔）；playbook 400/400 满员下等量压缩 6 行腾位（纪律语义零删，压缩点先 grep selftest 确认无机检引用）。②**replay 前置 ERP 标签计数告警（oracle 归因批后续三件之③）**——flow-engine 纯函数 countAppTabs/tabHygieneWarning（阈值常量 2=playbook 标签卫生纪律；matchers 分段锚定计数防裸子串误报；matchers 缺失 fail-soft 跳过）+cdp.js flow replay 探活块接线（复用 getTargets 结果零额外往返；>2 打 ⚠ advisory 不阻断；探活快速失败语义不变）+selftest #61 组 4 用例。③**Jev LICENSE gate 通过**：browser-use/jev-ultrafast 实核 **MIT**（调研报告 132 行"MIT 无障碍 vs 需核对"口径矛盾定案），浅克隆入 .slim/clonedeps/repos/browser-use__jev-ultrafast（HEAD 1231850a）+.slim/clonedeps.json manifest+仓库根 AGENTS.md 注册——录制定位素材增强实施（在途，record/paths/recorder/selftest 四文件，随下一版本号入库）的前置 gate。selftest 293 过/0 warn/0 fail（两条落地车道各自实测；+1 组=②新增）。

## V202609210003 — 2026-09-21 [fix]

- **chatgpt.com 09-21 改版定位符整体漂移修复**：两 flow 换锚+webapp.md 状态机重写——输入框=`div.ProseMirror[contenteditable=true]`（编辑器库级 class 全页唯一，textarea 旧形态兜底保留）；发送=`button[type=submit][aria-label]`（**唯一语言无关锚**——aria 只用属性存在性不用值，有值态全页唯一实证）；收单②=[data-message-author-role] 废弃改 `{text:"你说："}` 文本锚；完成双信号=主 `button[aria-label=开始语音]` 回归 120s（空/完成态同形态实弹验证）+辅 absent `button[aria-label=停止]` 10s；**10 步结构/超时预算/双信号设计零改动只换锚**。乐观会话新中间态 `local-chatgpt%3A<uuid>` 实测与 /c/ 断言天然兼容（URL 轨迹实锤出现后迁真实 uuid）；webapp.md 三态状态机表/读回复（lastIndexOf「ChatGPT 说：」+尾部截断锚）重写+已知坑三条残余风险（英文界面 aria 未测/submit 唯一性为时点实证/新中间态判别未验证不脑补），观察项两条登记 chatgpt TODO INBOX；GPT-001 [resolved]+主台账【chatgpt 定位符 09-21 整体漂移修复】关闭移 bak；连带主台账人工区新增【chrome-browser 合成器通道恢复】（restart 后补跑截图步即 10/10）+四问视图③联动。验证：flow validate 2/2 PASS+主 flow replay **9/10**（唯一红步=步骤 9 screenshot 合成器通道环境损伤非定位符问题——probe 三通道③✗+延迟单发对照仍超时两通道取证，按禁重击纪律停手转人工；交互+断言步全绿）。链路：oracle 四形态现场取证修复稿（实弹预验证短/长回复两轮全通）→ fixer 落盘实弹。**验证收口（用户 restart 后补跑）**：三轮对照 9/10→9/10→**10/10 全过**（截图 203ms）——截图步两连挂定性=合成器**冷启动停滞·自愈型**（既有 tab 截图同期正常区分非全局死；与 09-08 自愈型冻结同族，定因置信度中未受控复现），人工区【chrome-browser 合成器通道恢复】关闭移 bak+INBOX 登记现象与复发判别法。

## V202609210002 — 2026-09-21 [doc]

- **任务优先降级触发时机补丁（用户裁定）**：playbook §flow 回放守则任务优先降级条目补「触发前先排除网络抖动/瞬断类偶然故障（超时重试一次或轻探针确认环境稳定）」——偶然故障不构成降级依据，误降级会平白丢弃已固化的 flow 资产。

## V202609210001 — 2026-09-21 [doc]

- **任务优先降级原则（flow 失效探索伴跑兜底，用户裁定）**：playbook §flow 回放守则新增条目——flow replay 失败且 self-heal retry≤1 用尽（或失败报告 diagnosis 已明示结构性失效：应用改版定位符整体漂移/环境回归，retry 无意义）时**任务优先不恋战**，立即切「record 伴跑的探索模式」继续完成任务（`-v` 双流随行，视觉感知看最新录屏帧/抽帧），收尾报告四要素=失效步骤与根因初判＋flow 是否建议修复＋证据位置（事件流/录屏/失败报告）＋修复参考（新事件流 vs 旧 flow 逐拍 diff）。**边界三条**：①探索不豁免模拟人类双红线（探索操作即下一版 flow 示范素材，路径越保真蒸馏越可用）；②验收/回归类任务不降级（回放失败本身就是验收结论，硬做=假证据，只报告不重录）；③降级是任务层兜底非 flow 层修复（修复仍走蒸馏协议逐拍对齐，红线 #9）。缘起案例=当日 chatgpt.com 改版定位符整体漂移（oracle Jev 辩论按本精神手工 CDP 绕行完成但未起伴跑录制，事后修复缺对照素材——本条补缺；应用级记录 webapps/chatgpt/TODO.md GPT-001）；SKILL.md 排障路由表 flow replay 失败行同步指引。当日同批 Jev 吸收终审 5+1 TODO 登记属纯台账登记不 bump（commit b8a5903），本条为原则落地故 bump；selftest 292 过/0 fail。

## V202609190001 — 2026-09-19 [fix]

- **简单批（收尾挂起+焦点闸门）+ GPT 截屏方案查阅 + diag-liliao 弹层死亡取证（环境回归嫌疑待人工对照）**：①**flow replay 收尾挂起修复**——成功 verdict 先行同步落盘（paths 单源新增 tmpdata/replay-verdict/，formatStamp 时间戳单源，尽力而为不影响判定）+ finally 的 client.close 包 3s 超时兜底（withTimeout 复用，超时只 warn 强制放行让 stdout 判定行正常冲刷；失败路径本有 flow-fail 旁路，成功路径对等补齐）。②**V2 步骤 11 焦点闸门（纯 flow 改零引擎）**——inventory-lock 步骤 11/12 间插 `wait cond {count:{domPath:"#searchInput:focus",min:1}}` 闸门（60s 覆盖 45s 自愈窗，:focus 伪类=activeElement 持焦语义，docsWalk 逐 iframe 文档求值天然正确）+ type 补 target 激活引擎 3 次重聚焦兜底；77 flow 全量扫描零误伤；**实弹验证被弹层死亡新阻断劫持待补**。③**GPT 截屏方案查阅（agent 遗留项完成归档）**——翻查用户-GPT 会话「Chrome截图失败原因解答」落 facts.md「截图失败归因与 fromSurface 双路径」节（截图失败≠合成器冻结等价替换/fromSurface 双路径诊断信号/页面隐藏态 Surface 停滞/失败诊断矩阵/GPT 策略优先级五档）；对照已落地面（screenshotHardened+doctor=其优先级①②）后新增量两条登记 INBOX（fromSurface:false 降级+失败诊断矩阵）。④**diag-liliao 弹层死亡取证包**（两连挂步骤 10 self-heal 用尽→交互复现+E1/E3/E4/E5+双通道接线探针，tmpdata/diag-liliao-弹层死亡取证-20260919.md）：接线完好（桌面项 11 类 jQuery 事件在位）而单击/双击/Enter 全形态静默无效（零选中态/零请求/零报错/零弹层 DOM）；404×3 全良性；硬重载排除缓存；回归窗口铁证=09-18 09:54 弹层闸门还全过→重部署→09-19 00:08 起死；**E2 人工双击对照+同事核查登记人工区**，oracle 裁决 b-2 面板路径迁移为战略活路（E6 待办）。⑤方法论坑入库：DOMDebugger objectId 跨进程复用得**假 0**（document 活性对照证伪法）——必须单会话消费（facts.md 注+erp-listeners-probe.js 双通道互证范式留档）。⑥勘误两处：webapp.md:61 面板图标「CDP 免疫」系误诊（点域自动滚动动画期竞态撕碎 click，2s settle 后 delivery 38/38 两连过，面板/桌面双通道均可用）；inventory-lock 步骤 11 desc 日期 09-19→09-18（flow-fail 文件名时间戳）。selftest 285 过/0 warn/0 fail；fix-1 三提交文件：flow-engine.js/paths.js/inventory-lock.flow.json。

## V202609180003 — 2026-09-18 [fix]

- **oracle 归因批：网络类症状主因定案（标签并存/goto 风暴）+ assert text 轮询化 + 组合拳与标签卫生纪律**：①**归因**（用户问「agent 和人工有什么不同」）——每次 replay 新开 ERP 标签=同 profile 多 winui 会话并存互踢（实弹天然对照：4 标签累积期点击链 5.2s/步 vs 清场后 222ms/步差 23 倍；「网络连接」弹窗=被踢会话的外部性落在用户长活标签上）+8 分钟 ~9 次门户 goto 全量重载撞物料域更新恢复期；screencast/CDP 短连接弱相关（合成器线程独立、连接路径与 ERP 服务器无关）。②**assert text 轮询化**——原单发 TEXT_EXISTS_SRC（V1 无 gate4）与异步业务效果竞速：步骤 35 两跑一侧 4ms 真红（表单已拆明细未刷的空窗）一侧 5ms 假绿（命中将拆未拆的表单自身行文本）=无判别力；修复=轮询循环+textExistsWait（V2 两级漏斗）+消费 timeoutMs（此前该字段不被 assert 分支消费）。③M4 fast-pass 审计扩展到 assert 效果断言（速通=旧状态残留假绿嫌疑，b2f1b 5ms 实证会被此条抓住）。④delivery-extract 组合拳：确认后插 `wait hidden 待发货明细`（表单真关闭锚）再 assert 订单号，37→38 步。⑤playbook 标签卫生与运行节奏纪律（ERP 标签≤2/失败标签取证完即关/复用自建标签/轮次间隔 ≥2min/域重启后先人工确认）。⑥selftest #59 M4+轮询源断言、#60 38 步同步；实弹两连过见当日验证轮（38/38×2+清理回退×2）。

## V202609180002 — 2026-09-18 [fix]

- **批二：tspan 移出 activate.tags+面积升序决胜复核（合议 R1 歧义第二规则落地）**：业务地图 SVG tspan 候选曾以 kindMiss=0+面积 1257<7680 升序决胜抢占侧栏 a 真目标（diag-V1b/V1d 活体实证，与组头动画窗问题叠加构成 R1 全貌）；移出后 tspan 候选 kindMiss=1 软降权（仍可点 SVG 文本，真目标优先）。**面积升序决胜复核结论**：同类 kindMiss 内面积升序保留（nearZero 近零尺寸已前置降权；text-node 精确落点语义成立），残余歧义由 container 硬收窄（V202609130006）系统性兜底，不加额外决胜规则。存量 5 flow 预审：tspan 仅出现于 desc 文本零 target 直点，移出零误伤；selftest #2041 断言同步（负向断言 tspan 不在位）。**实弹两连过待补**：两轮 replay 挂于步骤 19/6 早段状态闸门——实锤环境侧物料域停用更新中（13:36 终态截图：物料域(已停用)+桌面图标全盖停用章+布局重排），与排序改动无关（未达任何候选选择步）；按禁带病迭代纪律止损，域恢复后补两连过。

## V202609180001 — 2026-09-18 [fix]

- **X4 命中复核深度 iframe 坐标空间修复（fix-31 以来「✓ 但没发生」悬案真根因）+ delivery-extract 提取段 28+ 解冻全链贯通（两连过 37/37×2）**：①**引擎修复**——buildVerifyExpr 重找比对用 frame 本地 getBoundingClientRect 对 absRect（视口累加）spec.rect 做 ±6px near，深度≥2 iframe 元素两者差父 iframe 累加偏移（实证：提取按钮 local y≈810 vs abs y≈885，Δ75px 恒超阈）恒判 gone→ensureHittable 'success'→**静默跳过 dispatch 还报 ✓**（0~27 深度 1 元素 iframe 偏移仅 1~2px 侥幸全过，故历史仅深层点击失效）；修复=重找比对前 absOf 沿 frameElement 链累加成视口坐标（与 absRect 同空间），elementFromPoint 保持同文档局部坐标；定位过程即取证：browser-restart 批准执行→os-login-goto 重登→回放×4 全 ✓ 但提取表单零开→同 tab 手动同坐标秒开（031~036 实例递增链）→逐参数 bisect（视口 override/引擎参数/零间隙时序全排除）→mini-A --target 温热 tab 复现锁定派发层。②**提取段解冻**：人类演示（demo-extract-2026-09-18.json 事件 47~64）逐拍蒸馏 9 步——settle 8s（人类 6.35s 节奏护栏）→闸门G「待发货明细」→勾行复选框（react-grid-Row:nth-child(2) 位置锚+icheckbox [class*=] 前缀匹配；**文本点击不联动勾选**实锤）→scroll（滚动条拖拽=真手动滚动）→确认→assert {{订单号}} 明细 +1→终态 screenshot；五项未知实测落定（提取表单=壳内新 Tab iframe 实例序号递增不可锚/无订单号下拉/icheckbox 行选择器/终态=明细+1 表头不变/「确认提取」旧拼接标题证伪）；删除段（gongqi_render_select 选行→recorddelelte→layer 确认）实证并用于两轮回退清理闭环。③_meta.viewport 1705×664→1917×904（对齐今日演示实测视口；1705 系 09-08 老录制值——【录制视口硬编码】活体案例）。④selftest #60 升级 37 步全流程定稿断言（冻结段锚点+蒸馏锚点+猜测段零残留）+ #23 补 absOf 回归断言；webapp.md 提取全链知识卡；playbook 录制节蒸馏/验收高清档口径（--video-width 1920 --video-quality 80，用户裁定 960 字体不可辨）。环境记录：browser-restart 批准执行（6.1s 优雅重启）→登录态过期 os-login-goto 重登；新观察：flow replay 收尾 client.close 间歇挂起（3 跑 1 次，verdict stdout 缓冲被 SIGKILL 吞——record-stop 204 挂起家族，TODO 登记）。

## V202609170012 — 2026-09-18 [feature]

- **P0 引擎批+flow 定稿批（五方合议统一路线第一批）**：①wait text+container 语法糖升级——带 container 走 buildLocateExpr 全链路（四层定位+X1+排序+X4；gone/blocked 视为未就绪继续轮询=稳定在场语义，与 click 分叉）；无 container 保持 TEXT_EXISTS_V2 存量兼容零破坏；waitLocateSpec 归一单源（复用 normTextDesc）；ACTION_FIELDS.wait+container+validateFlow 校验（container 仅与 text 同用/validContainer 单源/无 container 对象 text 拒收防 match 静默降级）②M4 过闸耗时审计（<100ms 条件类 wait 嫌疑标记，盲等不参与，runFlow 接线纯 advisory——实弹触发 6 条）③delivery-extract 33→29 步定稿：截除 28~31 提取段（无演示依据，_meta freezeNote 五项未知+禁猜测式补写）；纪律九条入 playbook（400/400）+webapp.md ambiguousTexts 登记（销售送货单/单据/销售管理）；selftest #59/#60 组 9 用例（283 过/0 fail）；**实弹两连过被环境阻塞**（浏览器合成器/GPU 管线冻结实锤——恢复需 browser-restart 杀用户标签页，人工区登记待批准）；偏差 3 处均为收窄性（scope 并入 container/X4 wait 分叉/M4 覆盖三条件类）。

## V202609170011 — 2026-09-18 [fix]

- **delivery-extract 步骤 21~27 修复+实弹 0~27 连过两跑稳定（历史最长推进）**：双重根因活体取证（①业务地图 SVG tspan 候选抢占——面积升序压过侧栏真目标 ②组头点击 1s 背靠背被「销售管理」组 slideDown 动画窗撕裂吞 toggle——历史上三态终态全解释）；修复=步骤 21 scoped 闸门（#mainMenu li.menuSub > ul.treeview-menu.menu-open 锚定主区列表行，559ms 真渲染非 38ms 假绿）+步骤 19 效果闸门 scoped 化（原 13~44ms 假绿实锤）+步骤 20 有界停顿 4s+步骤 22 settle 2s+步骤 23/24 container 硬收窄+match exact；实弹 25 双击 444ms→26 表单+按钮真开 1045ms→27 点提取 142ms；步骤 28 新发现：提取对话框从未有人类演示依据（点击后无请求无响应疑前置状态）交用户决策；V2 回归不受影响但自身步骤 11 焦点 churn 另登记。

## V202609170010 — 2026-09-18 [fix]

- **delivery-extract 定稿+V1 历史最佳（步骤 0~24 全过）+面板死循环根治**：31 步定稿（ora-4 九项+实弹修正三项+用户裁定两项——viewport 1705×664/12s settle/闸门B 收紧 img 本体/关闸门 toggle 惯用法/闸门D 域菜单渲染/闸门E scoped domPath 防桌面歧义/**手动 scroll 步删除**（seq5 scroll=录制器误录的系统自动滚动副作用）/停顿步恢复人类实测间隔）；V1 实弹 0~24 全过（面板段+壳段侧栏→单据→送货单→双击开单连过），步骤 25 后被环境崩坏阻塞（02:30 起 ERP 服务端桌面构建停摆，按禁带病迭代纪律止损留恢复路径）；**根因三连（帧+监听器证据）**：①背靠背点击撕碎 click 事件（0.1s 间隔→.app-item handler 不触发）——「面板图标 raw Input 免疫」历史口径被推翻（E2 免疫结论反转）②闸门闸容器不闸本体 ③scroll 步=录制器副作用；playbook 三守则+scroll 副作用甄别固化（400/400）；TODO 登记 diag-O 探针补跑。

## V202609170009 — 2026-09-17 [fix]

- **flow 人类路径化改造（用户裁定当日闭环）**：sales-delivery-extract 深链 goto salesAppUrl 废止——换 6 步人类路径（面板入口 img[src*=applistmenu]→示例ERP→物料域→滚轮滚入→应用图标 img[file-url*=gongqi.df.sales] 单击，逐拍真实录制链 2026-09-08_15-43-55 考古）；inventory-lock/via-search 复核合规（goto 全门户级+页内搜索合法）；salesAppUrl 变量零残留；selftest #58 人类路径机检 fail 级（vars 插值后 pathname 判定/登录页豁免/「用户要求直达」desc 豁免——实扫 5 flow 8 goto 全过）；SKILL.md 红线 #2 增补（goto 仅限门户/登录/用户显式要求）+webapp.md goto 深链 landing 缺陷案例卡；275 过/0 warn/0 fail。
- **facts.md 路径修正**：V202609170008 的 E2 真实场景补证误写 skill 根 facts.md（未跟踪）——归位 references/facts.md（f269d60 实际未含补证内容，本 commit 补齐）。

## V202609170008 — 2026-09-17 [doc]

- **E2 真实场景闭环（历史之谜收敛）**：os-login flow 自主登录达成（首击落 winui 接线滞后窗口 T+15-20s，raw Input 补击成功；126 桌面图标）→DOMDebugger.getEventListeners 真实图标绑定全查清（桌面图标 11 条 jQuery v1.12.4 绑定 exec 全盲 vs 面板图标 inline onclick exec 可见——异族；menuClick 纯属性驱动无 isTrusted/坐标过滤）→行为 A/B：80ms hold 点击免疫未复现——**绑定层归因排除，最强候选=winui 事件接线时序**（与首击滞后同源观察互证）；facts.md #5 补真实场景证；产物 tmpdata/e2-live/real/。

## V202609170007 — 2026-09-17 [doc]

- **paste/copy/cut 合成页实弹三档全过（recorder 扩展收尾）**：CDP 真实事件（flow Runner+dispatchKey Ctrl+C/V/X 原生编辑命令+程序化选区）——关键实证：paste 可达路径=Ctrl+V 原生粘贴编辑命令（真实 ClipboardEvent isTrusted=true insertFromPaste；Input.insertText 对照探针只产 input 不产 paste）；clipMask 三档（text 全文/masked ***/meta len）/password 红线（text 档下粘贴仍 ***)/Ctrl+V keydown 与 paste 双记录互证/cut deleteByCut；cdp.js SUB_HELP 补 --full-input/--clipboard-policy；playbook 录制节分层全档说明（399/400 守门）。产物 tmpdata/rec-live/。

## V202609170006 — 2026-09-17 [fix]

- **A1 slug 裁定落地（用户拍板：下划线保名）**：selftest #15 正则放宽 ^[a-z0-9][a-z0-9_-]*$（允许下划线），erp_demo_test/erp_demo_dev 目录名不动——常驻 WARN 根除（warn 2→0）。
- **A3 部署机 config.jsonc 查证关闭**：容器内 /root/.config/opencode/skills/chromeuse/config.jsonc 可达（/root 整挂宿主，原"机器实例不归 agent 管"表述过时）且 grep 无 erp_demo 旧引用——无需同步；流程认知修正：部署机真身配置容器内可直接查改。
- **A2 操作路径原则固化启动**（用户裁定：优先模拟人类操作，goto 直达仅限门户/登录/用户显式要求；landing 落业务地图页=goto 深链缺陷）——flow 人类路径化改造进行中（另 commit）。

## V202609170005 — 2026-09-17 [feature]

- **recorder 全输入录制实施（三子项，ora-3 报告步骤单）**：①keydown 白名单（shouldRecordKey 纯函数：组合键 ctrl/alt/meta 全录+修饰位面平铺 ctrl/alt/meta/shift+code 物理键码；白名单 10 键 Escape/Arrow×4/PageUp/PageDown/Home/End/ContextMenu ⊆回放 KEY_CODES 录放闭环；Shift 单独不触发/单字符/纯修饰/Backspace/Delete 不记——治录放不对称 Ctrl+S 蒸馏必丢）；②paste/copy/cut document 级监听（paste 读 clipboardData/copy cut 走选区/clipMask 三档脱敏 text 默认-masked-meta+password 判定优先恒 ***/clipTypes types-only≤8×40 红线同 DnD/policy 元字段）；③分层录制（PROFILE=CFG.inputProfile 非法回退 semantic；full 档 wheel 200ms trailing 累计+focusin/focusout+auxclick button 位面+F1-F12，semantic 默认零注册；--full-input/--clipboard-policy CLI 旗标+config recorder.clipboardPolicy 可选键；默认档落盘流 byte 级不变）；events.js 零改动纯透传；distill.md 新增消费规则节（69/160）；selftest #55-#57 组 15 用例（273 过/2 warn/0 fail）+真浏览器实弹 8/8；#45 getData 禁令收窄 dataTransfer（paste clipboardData 为报告许可独立通道）。

## V202609170004 — 2026-09-17 [fix]

- **录制侧两实锤缺陷修复（ora-3 三盲区前二）**：①内部容器滚动误导性事件——scrollFace 三面分类（元素面读 scrollTop/scrollLeft 真值+descriptor 容器标识=蒸馏区分窗口/容器滚动依据；取不到坐标如实降级不发事件；WeakMap 分面独立 500ms 节流互不压制；先节流后 descriptor 布局读≤2 次/秒/容器）；②contenteditable maskedValue 恒空——isContentEditable→textContent 分支走既有脱敏管线（password 判定仍最前，截 200 同口径）；chromeuse-events/1 不 bump（可选字段 contextmenu 先例）；selftest #53/#54 两组 7 用例（270 过/0 fail）。

## V202609170003 — 2026-09-17 [feature]

- **录制帧率 v1 参数化（ora-3 分析即做项）**：screencast resolveEveryNth 纯函数（默认 6≈上限 10fps/1=旧全速收帧/上限 30 护栏/非法回退）+Page.startScreencast 与 index.json config 双接线+record --every-nth 旗标透传+启动提示打印实际抽帧率；严格 v1 边界（每帧立即 ack 原样/不做动态调频/两档制 v2 触发式排期）；⚠ 默认收紧为行为变化（消费侧 diff-video/evidence-pack 已解耦不受影响）；playbook 顺修 3 处 --video-interval 存量误导口径（unused 占位从非帧率杠杆）；selftest #26 组内新增帧率断言 5 条（268 过/0 fail）。

## V202609170002 — 2026-09-17 [doc]

- **E2 深挖机制验证（facts.md 实测事实 #5）**：合成页四绑定形态实证 DOMDebugger.getEventListeners 与 exec 属性探测覆盖互补——addEventListener 全形态对 exec 恒盲、命令级查询全可见；使用要点五条（objectId 必须/无需 enable/depth:-1 递归/委托语义/0 基行号）；真实 ERP 图标排查待登录态按指引执行；facts.md 内容随 d4da71c 入库（并发卷入，归属说明）。

## V202609170001 — 2026-09-17 [refactor]

- **webapp selftest 目录化布局（用户需求：自包含+格式统一）**：webapp 专属断言从 selftest/webapps/ 迁至各 webapp 自己目录（webapps/<app>/selftest.js 与 webapp.md/flows 并列，不污染主目录）；selftest/main.js 改 fs.readdirSync **自动发现**加载（新 webapp 建 selftest.js 即自动纳入，WEBAPP_EXCLUDE 显式排除保留）；webapps/erp_demo_dev/selftest.js 同款骨架落地（dev 专属断言登记处占位）；install.js webapps walk 白名单加 selftest.js（copy 安装带上）；README 目录树+「webapp 专属断言约定」段；纯布局迁移断言零修改，输出与迁移前逐字节一致（263 过/2 warn/0 fail），排除演练通过。

## V202609130013 — 2026-09-13 [feature]

- **验收回放证据包 evidence-pack（章程提级高优先 v1）**：lib/evidence.js 单源（三形态输入发现/时间轴归一 tRecv↔tArrive 同钟/gap 中断与交叠显式标记/显著事件关键帧×帧池最近前后帧引用/README 取证自足/损坏段如实登记不中断）+cdp.js 子命令（纯本地聚合零 CDP）；索引式证据包不复制大文件（v1 边界）；真实产物四段打包实测（2 处真实中断/毫秒级对齐）；selftest #52 组 7 用例（263 过/0 fail）；playbook 逃生舱+用法节/SKILL.md 文件地图同步。

## V202609130012 — 2026-09-13 [refactor]

- **selftest 按 webapp 拆分（质量门手术）**：selftest.js（3085 行单文件）→ thin wrapper+selftest/common.js（断言框架/helper 单源）+selftest/main.js（通用组+webapp 导入清单）+selftest/webapps/erp_demo_test.js（唯一 slug 锚定子块）——输出与拆分前逐字节一致（262 过/2 warn/0 fail）、50 组零遗漏零编号变化、webapp 导入移除演练通过（某 webapp 失效只改对应文件目标达成）；**install.js manifest 补 selftest/ 递归 *.js 收集**（copy 安装路径修复，照 webapps walk 模式）；README 同步。

## V202609130011 — 2026-09-13 [feature]

- **flow drag 原语（13→14，路线 A）**：dragGesture 纯鼠标序列（mousedown buttons:1→5 段插值 mousemove 按住段 90ms 节距→mouseup 落点 buttons:0——G3 实证走通原生管线，收尾无 DOM mouseup 为正常语义）；to 两文法（{x,y} 坐标/{target} 描述符取中心）；dragPathProbe 拖动期 elementFromPoint 探针（seg2/4，fail-soft）；aggregateDrags 标记驱动聚合（dragstart→drop 双标记齐才聚合，6px 只滤抖动，无标记不猜，跨 tab 不配对）；selftest #48-#51 四组（合成序列/round-trip 含四负向/DPR 双档/格式锁）；真浏览器实弹三段全过（变体 A 描述符/变体 B 坐标/round-trip 全环闭环）；types 采集时机边界（dragstart capture 相早于 setData→读 dropTypes）注记 playbook。

## V202609130010 — 2026-09-13 [fix]

- **contextmenu uiAppear 第四触发面（spec 定稿+实施）**：右键菜单 DOM 出现纳入 uiAppear 捕获（与 click 同构双时刻采样 t1=700/t2=1800；原生菜单空 diff 天然抑制；时间轴邻近性关联不强求配对）；**顺带修复 send() 提前 return 潜伏 bug**——flush 定时器挂起期返回 undefined 致全触发面 triggerSeq 恒 0（V202609080017 关联设计静默失效，实弹实证），改恒返回 item 队列行为零变化；distill.md triggerType 枚举补 contextmenu；右键批注入口 1.0 前置能力全齐（V202609130002+007+100001+本条）；selftest #47 组 4 用例+真浏览器实弹 7/7（isTrusted=true CDP 真实右键）。

## V202609130009 — 2026-09-13 [fix]

- **target 层 match:'exact' 兄弟键静默失效修复**：normTextDesc 单点归一（container/target 共用，对象形态>兄弟键>默认 contains；非法值归 contains 与旧语义逐点等价）+matchModeOK 值域单源（validTarget 拼写错拦截）；存量 42 flow 16 处 match 逐一复核全部完全相等零翻红；真浏览器实弹双向验证（修复前误点 superstring 候选→修复后 exact 转正严格生效）；selftest #46 归一组+#43 实弹组扩展至 8 用例。

## V202609130008 — 2026-09-13 [doc]

- **drag 判决实验闭环（本地实证）**：双路线可行——①纯鼠标序列+按住段 buttons:1 走通完整原生拖拽管线（推翻 librarian 纯鼠标不可行一半：旧失败形态由缺 buttons 位掩码精确复现）②Input.dispatchDragEvent 独立注入可行（拦截链坐标零偏差）；Chrome 151 setInterceptDrags/dispatchDragEvent 支持性确认；实验产物 tmpdata/drag-live/（报告+合成页+两批脚本+全量原始数据）；TODO 关闭归档+新登记【flow drag 原语实施】。

## V202609130007 — 2026-09-13 [feature]

- **录制侧鼠标序列采集（council 裁决④）**：recorder 九类→十四类——mousedown/mouseup（button 位面 0/1/2，rightClick 录制闭环补全）/按下期 mousemove（40ms·8px 双阈值节流，moveSampleDue 纯函数）/dragstart/drop（DataTransfer types-only 防敏感入流）；未按下热路径一次引用比较零布局读；事件先落流不做聚合（留给阈值标定条目）；preprocess 透传零改动（record.js/events.js 不动）；selftest #45 组 8 用例（节流四象限/轨迹状态机 33 次精确收敛/getData 红线/isTrusted 零合成）。

## V202609130006 — 2026-09-13 [feature]

- **flow 定位 context-container 文法（ora-5 设计步骤 2/3/4 收尾）**：target 内嵌 container 三形态（{text,match?}/{role}/{domPath} 恰居其一；grid/point/near/嵌套拒绝；单独 container 不构成锚点）；text 形态结构祖先解析（15 标签+16 role 结构集，≤8 层，不过 gate4）；tryCollect 硬收窄（scopeEl.contains，恰 4 处 scoped，grid/domPath/point 不动；无全局回退）；container-not-found/容器外 N 条两分支诊断（attempts 五元组）；P0-2 白名单零改动；selftest #42 文法组+#43 真浏览器实弹组（Chrome 151 data:URL 合成页走 Runner.step 真实管线四项全绿）；--no-kind CLI 逃生舱（runFlow opts.kind 接线）；playbook/distill 文档推广。附带实证：target 层 match:'exact' 兄弟键静默失效（存量 quirk 已登记 TODO）。

## V202609130005 — 2026-09-13 [feature]

- **flow 定位 kind 语义层（ora-5 设计步骤 1）**：kindExpectations 纯函数（click/rightClick→activate 宽集合/type→textinput/select→selectcontrol/断言类→null 不评分）+withKind 注入（显式 tag/role 声明压制隐式，单点内聚；cond/assert/wait 不注入；select 选项二次定位不注入）+text 层 kindMiss 恒软评分（键序 fragment→tagMiss→kindMiss→nearZero→面积；未注入键恒 0 与旧链逐键等价）+attempts.kindMiss 诊断+_meta.kind:false 总开关；selftest #41/#44 两组（fake client 行为断言+42 flow 零回归哨兵+near 闸门禁令不破）；真浏览器合成页实弹五断言全过（span→button 翻转/显式压制/真实 click 全绿/contenteditable）。设计稿：reports/flow-定位语义层设计-oracle-20260913.md。

## V202609130004 — 2026-09-13 [feature]

- **时区配置单源 lib/time.js（默认 UTC+8）**：CHROMEUSE_TZ_OFFSET 环境变量（分钟，非法/越界回退 480）；formatStamp（文件命名安全）/isoLocal（ISO 带偏移显示）双出口；命名点 6 文件 12 处+显示点 5 文件 11 处统一接线；数据字段边界不动（tArrive/tMeta 双时钟/e.tRecv/closedAt 原样）；selftest #39 组 4 用例+REQUIRED manifest 收录；playbook 新增时区配置节。来源：用户头脑风暴 #7。
- **tmpdata 辩论 flow 双信号迁移**：gpt-debate-r1/gpt-drag-discuss 完成判别升级为收单断言+双信号（对齐 V202609130001 库内模式），vars/内容步骤零改动。

## V202609130003 — 2026-09-13 [fix]

- **CDP 通道健康修复包（librarian 社区研究定因→方案落地）**：①screenshot 加固 screenshotHardened()（Page.bringToFront 前置+失败 300ms 重试 1 次+双败 fallback 建议 captureSnapshot/browser-restart；probe/watch 探针有意保留裸通道原始信号）——定因=多标签 race（Chrome 只可靠截活动标签）+合成器冻结（Chrome 147+ 回归）；②CLI 连接优雅清理 gracefulClose()（逐 session Target.detachFromTarget+ws.close 正常关闭帧+ACTIVE_CLIENTS 注册表 8 处退出路径+SIGINT/SIGTERM/exit 兜底）——杜绝浏览器侧 session 堆积；③新子命令 doctor（chromeuse-cdp-doctor/1：browser 版本/targets 全列表堆积可见/wsLatency 3 次采样/screenshotProbe 前兆探测/multiClientHint 多客户端共连 9222 现状提示）——实弹即捕获真实截图冻结前兆；④flow replay 探活前置（Target.getTargets 单次快失败，文案指引 doctor/browser-restart）。定因补充：CDP 失效累积主嫌疑=多客户端共连 9222 互相干扰（chromeuse 与 chrome-devtools MCP 共用为架构现状）；心跳保活不适用 CLI 短连接模式（如实标注）。实弹：NAS chrome-browser:9224 Chrome/151，targets 4 稳定/attached=False/wsLatency avg 2ms。

## V202609130002 — 2026-09-13 [feature]

- **rightClick 原语落地（13 原语）**：flow 引擎 mouseClick 按键参数化（button:'right'/buttons:2，复用定位/坐标/focus/screenX/Y 忠实映射全链）；ACTION_FIELDS 白名单+validateFlow+step 四处接入；contextmenu 因果契约注释固化（Chromium 输入管线在右键 mouseup 后自动派发受信事件，录制 V202609100001↔回放 round-trip 闭环）；selftest +9 断言（#35 合成序列/#36 录放 round-trip/#37 DPR 1.0+1.5 双档/#38 录制格式锁）——242 过/3 warn/0 fail 零回归。来源：council 三议员合议 CDP 鼠标操作专项（commit 2e4f17c）。

## V202609130001 — 2026-09-13 [fix]

- **GPT 假绿链修复三件套（oracle 定稿规格）**：gpt-debate-r1 事故（2500 字辩论稿误写进 click 步骤 text 字段被静默忽略 → 三轮 replay 全部发送 vars 默认值「请只回复：OK」，日志全绿内容全错）的引擎层根治——① **P0-2 字段白名单**：validateFlow 新增 ACTION_FIELDS（12 原语合法字段清单），未知字段前置拦截报「含非法字段：text（疑似 action 写错或字段挪位）」（本案拦截器）；② **P0-1 type 写后读断言**：insertText 后 probe `document.activeElement`（真实落点）的 value/innerText 是否 contains 文本首 20 字符，失败重聚焦重试 3 次全败 → `TYPE_VERIFY_FAILED`；③ **P0-3 click 可选焦点断言**：`focusAssert:true`（opt-in）时 dispatch 后 sleep 120 比对 activeElement 与定位结果，不符 → `CLICK_FOCUS_FAILED`（示例ERP命令型 click 不适用，不默认开）。
- **P1 系配套**：waitCond 超时抛错前挂 `captureTerminalState()`（stop-button rect/visibility/aria-label + 输入框 value 长度 + user/assistant 消息计数 + URL）并入失败报告 `terminalState`（P1-1c）；buildFailReport/CLI 新增 `urlTrailSummary` 人读摘要 + `/c/WEB:` 乐观会话中间态检测（`检测到乐观会话迁移=消息已提交`，P1-2）；chatgpt 两 flow 完成判别升级为**收单断言（url /c/ + user 节点）+ 双信号（主：send-button 回归 120s 对 stop 滞留免疫；辅：absent stop 10s 交叉验证）**，空态 send-button testid 形态实弹验证后在稿；存量非法字段修复（gpt-debate-r1 辩论稿入 vars.topic、gpt-drag-discuss 同型 click.text 迁 vars）。
- **P2 文档**：webapp.md 已知坑 +3（goto 后 /c/WEB: 乐观中间态判别法与 urlTrail 诊断纪律 / click.text 无效与 vars 传参 / stop 滞留双信号判别）；playbook §前置操作条件与假绿治理补**收单断言通用律**（提交类操作收单=效果断言；存在性断言可被历史内容满足）；selftest 新增 #34 组 9 用例（白名单完备/事故拦截正向/合法零误报/P0-1 源+行为/P0-3 行为/P1 源+摘要/webapps+tmpdata 存量 40 flow 全量扫描）。

## V202609120006 — 2026-09-12 [doc]

- **两 webapp.md 入口直达经验修正（用户审阅指认）**：示例ERP 入口面板 = IP+端口根路径直达（无需 /osweb）——erp_demo_test matchers 新增 `erp.example.com:10000` 根路径 pattern（原仅登记 /osweb 模块路径，根路径入口 URL 不命中识别）；识别特征节改写：入口=IP+端口直达、/osweb 仅模块内部路径（两环境同规则）。


## V202609120005 — 2026-09-12 [doc]

- **playbook hover 手法升级为「悬浮文本排查四步法」**（用户建议算法化）：①截图全览圈定候选区域 ②按目标特征 DOM 枚举过滤缩到个位数 ③逐个 mouseMoved 悬停探测文本匹配 ④命中点击（可视区外先滚入）——对比滚动盲扫，候选过滤后通常 1~3 次悬停即命中。


## V202609120004 — 2026-09-12 [doc]

- **webapp.md 专属操作手法新增「数字域控制台日志（域日志）排查路径」**（物料域 Item 全链实证）：win_start 开始按钮→开始菜单滚动+hover 文本→域管理→目标域卡片→详情→域日志弹层；读取手法=示例ERP 层 iframe 内部 DOM 弹层 contentDocument 穿透+mouseWheel 向上滚读堆栈头部 Caused by。其他数字域（资金域/设备域等）同路径替换目标域卡片即可。


## V202609120003 — 2026-09-12 [doc]

- **playbook §通用深度新增「图标按钮的 hover 文本」**（域日志实战沉淀）：图标类按钮/菜单项 hover 悬浮才注入文本（非悬浮态 DOM 无文本，定位与枚举扑空）——手法=mouseMoved 悬停后再探测/点击；关联坑=菜单面板可视区外坐标点击无效，先 mouseWheel 滚入可视区再悬停探测（示例ERP 开始菜单「域管理」项实测闭环）。


## V202609120002 — 2026-09-12 [doc]

- 快赢批 10 条清空 9 条：selftest 优雅 fail（#32 组）/dispatchKey modifiers 位掩码（#33 组+实弹负控）/面板图标口径复核（两通道差异即结论）/指南同步（v54→v55）/录制比对复盘终判（keydown 设计性过滤非缺陷，粘贴 value 可还原、Ctrl+C 零痕迹缺口并入 recorder 全输入条目）/flow 固定 wait 评估（2 换锚点 10 保留）/tmpData 清理（不删：断言机制仍活跃）/ffmpeg 兜底（知识闭环）/旧结构化条目复核（16 条判定：007 关闭、001→open、005 注记、13 条维持）
- 领料锁定对照变体：流程修复完成（validate ✓+人类演示侧对照已获），实弹待环境恢复（ERP 502）
- TODO-007 转 resolved（观察期满零案例）；TODO-001 pending→open、TODO-005 注记 NAS 已验证

## V202609120001 — 2026-09-12 [doc]
- **TODO 台账维度化分类落地**（oracle 定稿方案全量传递）：头部新增「遗留项维度规范」（语义单源）——协助维度=两物理分区本身（人工/agent，分区头即维度不打标签）+ 三维度行首标签：难度二档 `简单|复杂`（简单=≤1 会话零星时间可清；复杂=跨层设计/需专项，禁"中"）、类型三值 `bug|增强|新功能`（bug=行为与预期不符；增强=现有能力面内的缺口补齐+文档债；新功能=新增能力面默认 1.0 外）、优先级三值 `高|中|低`（**阻塞度唯一承载者**：高=阻塞复杂自动化主线无绕行或用户催办；中=有绕行或仅损证据质量；低=打磨/观察/gate 休眠/产品化 idea）；标定原则（阻塞无绕行→高/有绕行→中/打磨观察→低/新功能默认低提级须显式）+ 纪律（INBOX 行不打标签、[x] 完成条目不打标签、旧结构化条目 TODO-NNN 不适用）。头部新增「四问速查视图」四小节（①快赢区 agent×简单×bug|增强×≤中 10 条 ②阻塞区优先级=高按难度两档 5 条 ③协助小修区人工×bug|增强 5 条 ④新功能区 4 条）——视图与标签一致性由 selftest 机检防漂移。两分区存量 28 条开放条目全量打标（人工 5 含 slug 规范适配裁定自 agent 区迁入——剩余动作=用户拍板归人工；agent 23）+ 新登记 1 条【旧结构化条目复核】[简单|增强|低]（TODO-001~016 逐条判 resolved/open/结论并入 INBOX）= 29 条全带标；[x] 完成条目 5 条不打标签；条目描述文本零改动只加标签；旧结构化条目 TODO-001~017 与 INBOX 历史行零改动。selftest #6 扩展三断言：A（fail）两分区 `- [ ]` 条目行首必须匹配 `[难度|类型|优先级] 【`（[x] 豁免）、B（fail）四问视图标题集合=按标签推导集合（①③④+②简单/复杂双档，解析 TODO.md 自身一致性校验）、C（warn）agent 区高优先占比 >40% 提示优先级通胀；既有断言零破坏。AGENTS.md 台账纪律块同步（登记格式含三维度+维度语义单源指针+INBOX/新功能纪律两句）。selftest 全绿；开放条目标签分布（29 条）：难度 简单 18/复杂 11、类型 bug 4/增强 21/新功能 4、优先级 高 5/中 15/低 9

## V202609110002 — 2026-09-11 [doc]
- **webapps/erp_demo 改名 erp_demo_test（示例ERP项目测试环境定位）**：该 webapp 实为示例ERP项目的测试环境——基于 erp_demo 二次开发，包含物料域、资金域等数字域（app 清单暂不细化）；项目上线后测试环境可能消失，届时本条目归档、flow 失效不作维护。webapp.md 顶部新增「应用定位」块记录上述定位与归档语义（实质知识内容零改动、无 slug 行故仅加定位块）；目录 git mv 保留历史；flows ×3 `_meta.app` 同步（validate 安全阀按 webapps/<app>/webapp.md 路径匹配，不同步即回放被拒）+ sales-delivery-extract desc 内路径提及同步（步骤语义零改动）；selftest #1 manifest 两路径与 #18 inventory-lock 断言路径同步（#5 config 模板检查/matchers 样例字符串无 erp_demo 引用，示例ERP URL 样例与 slug 无关不改）；webapp TODO.md 标题/定位行同步（GQ- 前缀不变）；references/playbook.md、references/openclaw.md、skill TODO.md 活文件路径提及同步；config-template 无 erp_demo 专属模板（仅平台模板 linux/windows，install.js 按平台选模板与 app slug 无关）零改动；SKILL.md/README.md/install.js 无 erp_demo 引用零改动；CHANGELOG 历史条目不改写。⚠ 部署机侧 gitignored config.jsonc 的 matchers/slug 引用需用户手动同步（人工遗留项已登记 TODO.md）。selftest 206 过 0 fail；flow validate 新路径通过

## V202609110001 — 2026-09-11 [feature]
- **flow 机制演进三件套**（用户 idea 经 oracle 读码 + GPT 讨论定稿；优先级 Q2 分诊器 > Q3 absent/hidden > Q1 tag；零红线冲突——真实事件/失败即停/advisory only 哲学不变；GPT 的 kind 语义层/context-container 维度本期不做）：**Q2 失败分诊器（Evidence Aggregator）**——buildFailReport 对 TARGET_NOT_FOUND 类失败新增 `diagnosis` 字段（纯 advisory 不改判失败）：①锚点回探（Runner 记录最近一次成功 wait 的 waitAnchor={stepIdx,text|urlNeedle,url,timestamp}——wait text 成功记 text+url、urlContains/cond.url 成功记 url；失败时 TEXT_EXISTS/location.href 2000ms 短超时 fail-soft 回探：锚点仍在→嫌疑集中当步目标、已消失→upstream-broken）；②readyState 轻探针（2000ms 短超时——renderer 无响应→env-frozen）；③拒因聚合（X1 拒因 L4 计数>0→遮罩/前置条件嫌疑 ambiguity、候选 0 条→目标不存在/文本漂移嫌疑 target-changed）；产出 {likely, confidence, evidence[], probeStatus{anchorProbe,readyStateProbe}, probesFailed, advice}；**铁律：探测失败≠没有证据**——各探测独立记 ok/absent/timeout，probesFailed:true 时 confidence 强制降 low，advice 一律「疑似」措辞；分诊器自身异常 fail-soft 不掩盖原失败现场。**Q3 wait absent/hidden 两键（严格状态模型）**——validateCond/buildCondExpr 新增两键（现有六键语义零改动，轮询复用 waitCond 500ms）：`absent`=!exists（值=target 描述符，DOM 无匹配元素为真）；`hidden`=exists && !visible（**存在但不可见，严格语义——target 不存在时恒 false 防 false-success**）；实现=buildLocateExpr 存在性模式（`__presence`：visRect 跳过可见性与尺寸过滤，0×0/display:none 也算存在 + `__hitTest:false` 关闸门）求 exists + 常规 X1 定位求 visible，双表达式一个 IIFE 返回布尔。**Q1 tag 软评分 + opt-in strictTag 硬约束**——validTarget 新增修饰字段校验（tag 须字符串或非空字符串数组；strictTag 须布尔；单独出现不构成锚点）；text 层默认**软评分**：候选 tagName 不在声明列表内降权排后不排除（tagMiss 排序键追加在 fragment 之后 nearZero 之前，tag 未声明时键恒 0 零影响）；`strictTag:true` 升级**硬约束**：不匹配候选直接排除（作者显式契约——改版 fail 显性化告知契约破坏，attempts 带 tagMiss 计数）；命中闸门（X1/X4）与收集过滤零改动。**文档**：playbook §通用深度新节「§使用模式总览（四场景闭环）」（探索/演示复现/固化 flow/回放自诊断四场景映射既有命令与协议）+ flow 回放守则 cond 文法补 absent/hidden 与 tag/strictTag 条 + 失败报告条目补 diagnosis 说明；distill.md flow 草案条补**等待锚点优先级**（业务可观察状态 > 稳定 UI 状态 > 关键 network 请求 > URL > 固定 ms 最后 fallback 不追求消灭）。**selftest #31 新组**（validateCond 两键双向/buildCondExpr 语义形状/validTarget tag+strictTag 校验/text 层排序键位置与 strictTag 排除源断言/flow schema 集成/diagnosis 结构四场景断言——spawnSync 子进程承载 async 合成 fail report，含铁律 probesFailed→low 断言）；buildFailReport/diagnoseFailure 导出供测试消费。**实测门**：合成 13 用例全过（absent 存在/不存在双向、hidden display:none 成功+不存在/可见恒假、tag 软评分同文本 button+div 按面积对照、strictTag 契约破坏转红+软评分兜底可点对照、分诊器 target-changed/upstream-broken 实弹 diagnosis 对照）；selftest 215 过 0 fail。行数：playbook 354/400、distill 61/160

## V202609100002 — 2026-09-10 [feature]
- **browser-restart 运维命令产品化**（Y1 治本方案固化，2026-09-10 实测全链路 ~10s）：cdp.js 新增第 15 子命令 browser-restart——`Browser.close`（浏览器级、无 sessionId，优雅关闭 ExitType:Normal 无恢复气泡）→ keep-alive 自动拉起（**NAS chrome-browser 容器 wrapped-chromium 特有**）→ 探活轮询（每 2s `/json/version`，预算 30s 可 --timeout 覆盖）→ 等 2s DevTools 稳定 → `/json/list` tab 清单；Browser.close 致 WS 断开的连接错误为**预期路径**（捕获转探活等待，报错文案友好）；探活超时兜底含**环境边界文案**（无自动重启机制的环境如 Windows 桌面端需手动重启浏览器后重试探活，命令幂等；NAS 容器 keep-alive 失效时人工 docker restart chrome-browser）；用途 = CDP 操作过多/DevTools 域层损伤（per-target 全 -32601，2026-09-09 实弹打穿实证）时的环境重置——比 docker restart 干净（无恢复气泡）；helpMain/SUB_HELP 文案含爆炸半径警示（整浏览器全 tab 关闭）；selftest #17 SUBS 冒烟收录 + 新增 #29 运维命令断言组（路由/实现/帮助面/探活轮询/环境边界兜底文案/断连预期捕获 4 条）；playbook Y1 条目更新为标准执行方式 + 环境差异标注

## V202609100001 — 2026-09-10 [doc]
- **模拟人类双红线与排障总纲经验沉淀**（oracle 定稿 6 处落位，源=库存锁定 landing 漂移实锤 + 两次实弹对照）：**A** SKILL §一步骤 4 原地改写为**闸门语义**（验证是闸门不是建议——下一动作前必须确认目标状态已达成；盲走下一步把单点失败传染成连锁失败、断裂点无法定位；手段清单保留）；**B** SKILL §三插入 #2 **操作路径红线**（模拟人类为准/禁抄近道——「点击应用等效打开某 URL」不得改 goto 直达：点击背后有选中态/上下文写入/后端预取，直达会跳过致后续走不下去（2026-09-10 库存锁定 landing 漂移实证）；goto 仅限录制流中真实导航步骤，例外=用户显式声明的测试场景；与 #1 合称模拟人类双红线——#1 事件层 isTrusted/#2 路径层业务语义；原 #2-#7 顺延 #3-#8，内部引用「纪律见 三.6」→「三.7」同步）；**C** SKILL §六路由表前排障总纲 preamble（元规则一视觉优先：出问题第一动作=截图/-v 帧对照看实际状态再进结构化分析；元规则二分层归因：运营期偶发→flow.json/知识漂移→chromeuse 代码→其他、开发期代码提前为第一嫌疑、顺序不绝对按证据跳层）+路由表新行「操作/回放『成功』但后续连锁失败（日志✓画面✗）」；**D** playbook 新节 **§排障总纲：视觉优先与分层归因**（既有排障簇入口伞；视觉优先操作序三步含理由「结构化分析建立在错误前提上最费时」；分层归因表四层×运营期/开发期序×典型指纹×核对动作；术语判定与顺序弹性声明；衔接引用假绿取证/视觉兜底/采集失效指纹三簇不重写）；**E** playbook 新节 **§操作路径红线（细则）**（双红线相邻位；机制=点击≠导航（选中态/上下文参数/后端预取回发 vs goto 只做加载）；取证法=网络域对比点击路径 vs 直达路径请求序列；案例卡=2026-09-10 库存锁定 landing 漂移（直达 URL 步骤 3→业务地图 landing 而非表单、步骤 9 等 60s 超时，旧实录点击链三连过直达表单——直达跳过门户点击链的组织/域选中态与后端上下文写入）；等价判定法=唯一安全 goto 替换为录制流该步本就是 navigate 且无同点 click 在先；与「不得跳步」概念区分（跳步=前置 UI 状态缺失归前置操作条件域/抄近道=路径业务语义丢失归本节域）；例外条款=显式声明测试场景须留痕）；**F** flow 回放守则编写纪律+路径纪律条（点击类步骤不得 goto 等价替换/直达仅当录制流为纯导航）；**G** selftest 新增 #28 断言组（闸门语义/红线编号一致性与内部引用三.6→三.7/排障总纲要素/交叉引用防漂移——SKILL 引用的 playbook 节名须有对应标题/playbook goto 禁令）；**H** 指南 v54 4.2 双红线+排障总纲各一句+2.6 追加。行数：SKILL 171/320、playbook 308/400

## V202609090003 — 2026-09-09 [feature]
- **录制采集失效治理**（council 定稿批0-批3；根因链=Selkies 重连致 renderer 替换：①Page.enable/addScript/addBinding 域状态记账随 renderer 静默清零且无通知（CDP await OK=伪成功）②attachedToTarget 对同 targetId 新 session 无条件跳过=永不重注入，两层叠加永久静默失效）：**批0 取证**（tmpData/ 一次性脚本不入仓库+reports/ 简报）：实验0 存证复析——11/11 事件带 tRecv 但 tRecv 双通道共用无法断案（历史数据无通道标记，待批2 ch 字段验证）；9 navigate=8 frame/9 互异 docId，同文档快照假设证伪；实验1 addScript 验证——navigating 注册对当前文档不补跑（预期）、跨导航生效，注册失效仅在 renderer 替换场景成立。**批1 自愈通道**（lib/record.js）：①attachedToTarget 会话感知（同 target 同 session 幂等跳过；同 target 新 sessionId → log.warn renderer-swapped re-attach + 以新 session 重跑注入，tab 别名自 targetsMeta 复用）②幽灵 detached 守卫（ghostDetach 纯函数导出：仅 st.sessionId===事件 sid 才清理，旧 session 迟到分离事件跳过不误删）③ensureInject 幂等五连发提取（removeScript 旧 scriptId→addScript 记 identifier→Page/Runtime.enable+addBinding→evaluate 补注入；启动/重 attach/哨兵/WS 重连四路径统一）④per-target 注入锁（注入中不重入，消除与 context 补注入同帧并发双实例窗口）⑤st.error（仅硬失败=协议错）与 st.pendingInject（瞬时失败清 error 交哨兵/context 补注入解除）拆分 ⑥waitForStableDocument（loading 等 loadEventFired 5s 兜底/complete 后 300ms 稳定确认/冻结延迟 1s 重试 ×3）⑦注入后验证退避 300/800/1500ms ×3 失败置 pendingInject ⑧「录制中」提示逐 tab 标注实际注入状态（[✓ 已注入]/⚠ pendingInject/✗ 硬失败）。**批2 哨兵+WS**：10s 哨兵与 15s 采样合并单 5s 定时器交错（tick%2 哨兵/tick%3 采样）；合并探针一次 evaluate 2s 超时（recorder 哨兵+beacon 函数+readyState+beat()，纯只读红线，chrome:///about:blank 跳过）；状态机 OK→SUSPECT→LOST（迁移才打日志；探针超时=冻结信号计 SUSPECT 不升 LOST；导航中 rs≠complete 不误判）；三态处置（ok 跳过/no_binding 仅补 addBinding 不重新 evaluate/其余全量 ensureInject(reInject:true)）；节流（重注入冷却 3s、单次 LOST 片段 ≤3、每 target 会话总上限 5、连续 2 败告警 10min 去抖、3 连败落盘头 injectLost:true 响亮告警）；--no-sentinel 可关。**WS 有界重连**（cdp-core 加 onClose 回调注册+reconnect 复用实例保留监听器清空旧 session）：断开→一次 5s 预算重连+重发 setAutoAttach（存量 target 经重 attach 路径全量重注入）→未成响亮 stopAll('ws-down') 落盘头 wsDown:true 绝不静默空转。**通道 ch 标记**：事件加 ch:'binding'|'beacon'（onPayload 来源透传，chromeuse-events/1 不 bump）+采样日志分通道计数。**recorder.js 仅加 beat()（返回 docId/seq/frame 只读零布局）与 reInject 静默模式（CFG.reInject：跳过初始 load-navigate 发射+uiAppear 静默重打底防伪事件污染）**——events.js 热路径零改动。**批3 知识**：playbook 采集失效症状指纹排查四步（injectLost 头→ch 计数→状态迁移日志→哨兵告警）+gamma 边界目录（OOPIF/严格 CSP/bfcache/bindingCalled 零告警反向）；TODO 记 gamma P2 页面侧自注入哨兵被否决方案；SKILL.md 文件地图一句话；指南 v54 2.6 追加段。**验收**：S3 Page.crash 刺激（tmpData/ 脚本）——crash→自动重注入 42ms 实证（__chromeuseRecorder=true）+crash 后事件持续捕获（navigate/uiAppear 全 binding 通道）；合成 click 在恢复过渡窗被浏览器输入管线静默丢弃（beat seq 不变实证=Input 未达 DOM，recorder 侧无损——环境限制非缺陷）；批0 断案：失效非 addScript 跨导航失效（实验1），是 renderer 替换场景（批1 覆盖）。浏览器 DevTools 服务层经多轮 crash 刺激后整体打穿（全 tab 域 -32601、新 tab 即 zombie、直连 9222 不可达）——录屏 -v 回归复验需人工重启 chrome-browser 容器后执行（本版批2 改动不触及 screencast 链路）

## V202609090002 — 2026-09-09 [feature]
- **录制管线「录屏兜底」**（CDP `Page.startScreencast` 页面录屏 + `diff-video` 对照命令；参数语义 = 用户裁定 **`-v` 显式开启制**，默认关——默认路径零新增 CDP 命令，页侧 tools/recorder.js 一行不碰是本方案核心优势）：**lib/screencast.js 新建**（每 target 一路 `Page.startScreencast({maxWidth, everyNthFrame:1, format:'jpeg', quality})`；帧经 `Page.screencastFrame` base64 解码写 `frames/<tab>/NNNNNN.jpg`；**ack 节流**每 intervalMs（默认 1000ms）对最新一帧 `Page.screencastFrameAck`——⚠ 协议字段名陷阱：该命令参数叫 `sessionId` 但语义=帧序列号 int，与 flatten 会话 sessionId 撞名，按 Chrome 151 实际协议区分下发；每帧记 `{file, tab, tArrive: Date.now(), tMeta: metadata.timestamp}` 双时钟（对照基准统一 tArrive 毫秒）；index 内存累积 + 每 ~5s 覆写 `index.json`（chromeuse-video/1：format/session/config/startedAt/frames）+ stop 终写；全部 fs/CDP 异常 fail-soft 吞异常——录屏失败绝不拖垮录制主流程）；**lib/paths.js** +VIDEO_DIR（tmpdata/video 单源）；**lib/record.js 条件化接线**（setupTarget 链 `flags.video` 为真才 start——独立 try/catch 不污染注入错误隔离；closeTarget 关 tab 即停该路并终写 index；stopAll 拆 WS 前先停全部录屏（帧计数进落盘头）；onPayload 每事件补 `tRecv`（Node 接收时刻，与帧 tArrive 同钟）；落盘头 `session.video = {dir, frames}` 可选字段（未开省略，chromeuse-events/1 不 bump）；.record-state.json 仅 -v 补 `video:true`）；**tools/cdp.js**：parseArgs 前预处理 `-v`→`--video`（全部子命令统一获得别名，未来 verbosity 用 -V/--verbose 避让）；record 旗标面 `-v`/`--video` + `--video-width 960`/`--video-quality 60`/`--video-interval 1000`（仅 -v 时生效）；**flow replay `-v` 接入**（runFlow 对目标 tab 起 screencast，落 `tmpdata/video/replay-<ts>/`——独立命名不复用 rec-：replay 无配套事件流，diff-video 不消费，帧流+index.json 直接人工/observer 看；失败路径同样留存帧流）；**diff-video 子命令**（读 events `session.id` 自动定位 `tmpdata/video/<session>/index.json`，缺失扫帧目录重建兜底；`--video-file <mp4> [--t0 <iso>]` 外部 mp4 兼容（bin/ffprobe 取时长，t0 缺省 session.startedAt，报告标注对齐误差 ±2s 级）；输出 chromeuse-videodiff/1 对照报告 JSON 落 tmpdata/videodiff/ + stdout 摘要：每个 click/dblclick/uiAppear/navigate → 前后最近帧（路径+Δt）按 tab 分列；`--mp4` 可选 bin/ffmpeg 帧序列合成 -framerate 2）；**文档**：playbook §前置操作条件新增「视觉兜底」排查三步（①events-summary 结构化真相 ②diff-video 对照报告 ③疑点帧 observer ≤25 帧/批）+ `-v` 使用时机三场景（①人类演示录制必带 ②假绿/前置问题 replay -v 重跑 ③偶发 flaky 布控 --video-interval 2000；反例：确定性流程再录、纯事件审计不带）；distill.md 演示协议录制命令默认带 -v；SKILL.md 文件地图一句话；**selftest #26**（screencast.js ack 节流/双时钟/index 格式 + `-v` 别名解析机检 + help 面无 --no-video + diff-video 帮助面与 --help 冒烟 + VIDEO_DIR 单源 + **recorder.js 零 screencast 痕迹机检**[页侧零改动] + record.js/flow-engine 接线断言）；实测门：`record -v` 冒烟全链路闭环（index.json+frames 生成→diff-video 事件↔帧映射正确）+ 默认关零开销（tmpdata/video 无新目录）

## V202609090001 — 2026-09-09 [feature]
- **回放假绿治理批1+批2**（council 定稿四件套，预期行为变化=修复后假绿步骤"转红"——红得正确即验收）：**X1 text 定位候选强制可见性四层闸门**（candidatesIn 逐个过闸：①rect<1（现状保留不收紧亚像素）②offsetParent===null 且 position!=='fixed'（O(1) 覆盖任意深度 display:none 祖先）③自身 visibility==='hidden'（opacity 不查——仍收事件）④主判定命中测试：同文档 elementFromPoint(局部中心)，hit===el/contains 双向三段容忍保 SVG tspan 与事件委托包装层；**仅 text/role 锚点层启用，near 的 pool 严禁**（全 DOM 量级会重演 V202609080017 的 5s/次回归——visRect 的 8 层祖先 walk 亦撤，由 offsetParent O(1)+命中测试取代）；nearZero 保留为排序降权不升格过滤；全部候选被拒 → TARGET_NOT_FOUND 附被拒 top-N 诊断（tag/rect/拒因第几层）；总开关 flow `_meta.hitTest===false` 或 CLI `--no-hit-test`，经 runFlow→Runner.locate→spec.__hitTest 透传）；**X3 两段完整双击序列**（mouseClick cc===2：clickCount:1 一对 → 100ms → clickCount:2 一对坐标同源——Chromium dblclick 检测依赖第一对；重试协议=整体重发两段，self-heal 整步重跑天然满足）；**X2 TEXT_EXISTS 两级漏斗**（新增 TEXT_EXISTS_V2 仅 wait text 使用：一级 innerText 快路径不含 q 即 false（95% 轮询零增量）+二级候选扫描过同套 gate4 闸门存在过闸元素才算真——幽灵模板文本不再假绿；assert text 保持原 TEXT_EXISTS_SRC 单级；flow-engine textExists/textExistsWait 分流；**cond element 缺口顺修**：buildCondExpr 补 element case 复用 buildLocateExpr.ok——消灭"validateCond 收 element 但 switch 抛错被 waitCond 吞掉空转超时" latent bug）；**X4 统一容忍式命中复核**（centerClick dispatch 前 ensureHittable：locate 候选顺手带 hitOK（闸门拒绝=明示 false 防御性拒）；point 策略只要求 elementFromPoint 非 null；其余策略 sleep 100ms 缓冲后按 best 身份（frame+tag+id+text+rect±6px）重找元素→elementFromPoint(中心)：命中自身/后代/祖先→放行、evaluate 异常→放行、best 已移除/rect 大变→判成功跳过 dispatch（点了会关菜单的项）、best 仍在原位但命中 null/html/body/无关→TARGET_NOT_FOUND（hitMiss 标注）；select opt 点击与 scroll target 同闸；**post 复核实验开关默认关**（_meta.postVerify===true / --post-verify：点击后 best 仍在原位→告警不失败）；预算与 locate 对齐 8s）；selftest #23 新增 3 t() 断言（四层要素+总开关+nearZero 保留+负向拒因串 / 两级漏斗+原版保留+cond element 可执行 / verify 四态）+4 check()（两段双击/verifyHit+hitMiss/hitTest 接线+text 分流/postVerify 开关）。**批3 文档**：playbook 新增「§前置操作条件与假绿治理」专题（点击无反应第一假设=前置未满足不先怀疑定位器/截图验证日志✓不算证据/对照 uiAppear 找断裂点/修复优先补前置而非改定位硬点/日志全绿≠生效纪律）+「可见性三层判定」表（visRect 廉价前置/X1 精过滤/X4 click 前命中闸）+Y1 运维条目（exec Browser.close 不带 --target：报连接错误=预期、keep-alive ≤2s 拉起、ExitType:Normal 无气泡、爆炸半径=整浏览器）+Y2 证伪记录（气泡 infobar 属 browser Views 层不移动页内坐标，"气泡遮挡"不成立，恢复期面板不开优先怀疑 winui handler 未接线）；webapp.md 已知坑首条改写为 hit-test 新语义+专属手法补前置操作条件链（buttonmenu 先点开/左侧栏双击/应用管理面板先开）+双击条目补两段序列；distill.md 质量清单新增「终态复核」栏（回放完成必须 screenshot/人工观察确认目标终态记 verified 注记；被假绿污染的 verified 基线重跑+人工复核后 bump baseKnowledgeVersion）；via-search flow 步骤 2/16/22 旧注释更新为新语义（结构不动，schema 过）；TODO backlog：uiAppear ①号标记本版已顺修 + Y3 跨仓交接条目（--hide-crash-restore-bubble+exit_type 兜底，跨仓需 restart browser 生效）；VERSION 日期翻篇 V202609090001；SKILL.md 文件地图一句话

## V202609080017 — 2026-09-08 [feature]
- **uiAppear UI 状态变迁捕获**（council A⁺ 定稿，三提交结构）——**提交#1 回放定位修复**（lib/target-resolver.js）：① visRect 祖先链可见性（alpha 贡献：向上 ≤8 层查 display:none/visibility:hidden，命中即不可见——display 不继承，祖先 none 时自身 computed 失真且 rect 可被过渡动画保留非零；已知边界：hidden 祖先+后代显式 visible 覆盖的罕见模式宁严勿漏）② text 层候选**近零尺寸降权**（oracle latent②：宽或高 ≤1px 的 0×0/1×N 动画中间态排到正常尺寸之后，降权不删除——实录失败点#2 根因：0×0 下拉项被面积升序选中点击无效；visRect 的 <1 过滤只挡纯零）③ TEXT_EXISTS_SRC 核实：**实现已是 innerText**（渲染可见文本、隐藏祖先不计入），council alpha/gamma 矛盾以此裁定，不改——wait text 天然等面板渲染后才放行。**提交#2 页侧采集**（tools/recorder.js，~190 行）：lastStable 基线（交互元素键 tag|id|cls|text 不含 rect；顶层帧 load+600ms 打底）/scoped 选择器（a,button,input,select,textarea,[role],[onclick],[tabindex],li——禁 * 遍历，仅 DOM 规模指纹允许 * 计数）/容器门（beta：div/ul/nav 且 ≥2 可见子元素，或 role∈{menu,listbox,dialog,dropdown,panel,nav}，无 role 按标签推断、未知记 unknown）/触发面 click|dblclick|keydown(Enter 300ms 去抖)（连击各自排布不取消 pending、空 diff 不发射、seenEver 签名防重复；scroll/input/change 不触发）/双时刻采样 t1=700ms t2=1800ms 累积并集（appearSet 按 sig 追加 rect 取 t2 终值）t2 后单发射/settled=t2 与 t1 的 * 计数相同/差集=采样键集−lastStable（基线缺失 items=快照全集+baseline:'missing'）/iframe 自身 load 后 ~700ms 首采样发射（triggerType:'load'，triggerSeq:0）/配额纪律（候选 >8000 放弃采样、DOM >50000 降级只 walk 容器门命中子树、≤8 容器×≤12 items、text≤24/容器 text≤60/cls≤80）/数据形状定稿逐字段（triggerSeq|triggerType|settled|baseline?|containers[{sig,role,rect,text,repeat,items[{tag,text,cls,rect}]}]，信封字段由 send() 自动携带——record.js/events.js/flow-engine.js 零改动）/性能纪律（批量只读循环无写操作单次强制布局、采样全在 setTimeout 回调）。**提交#3 文档**：distill.md「uiAppear 消费」七规则（①最强规则"等你要点的那个"：triggerSeq=S 的 items 与 S 后下一次 click 目标文本匹配则该 click 前插 wait text，无匹配取首项 ②无文本容器 wait ms=clamp(观测间隔,500,3000) ③容器+items 进 desc 不进 cond ④load 型→该 frame 下一事件前插 wait ⑤repeat:true desc 注记 toggle ⑥两采样点空集记坑清单候选 ⑦跨域 iframe 盲区已知限制）+质量清单追加"每个 uiAppear 均被消费或标注丢弃原因"；TODO.md backlog 追加 4 项（buildCondExpr element 分支实现或显式拒绝/uiDisappear YAGNI 暂缓/跨域 iframe 采样/自适应 t1）；selftest #24 +3 条 uiAppear 静态断言（lastStable+seenEver+双时刻常量/scoped 选择器+配额常量/iframe load 首采样+三触发面）；SKILL.md 文件地图一句话（八类事件含 uiAppear）；验收门实测：target-resolver 单测回归全绿+探针实证（面板真开时示例ERP 158×17 祖先链全 visible 判定正确；关闭态 0×0 新旧代码同为 0 候选非回归）；实录回放受阻于浏览器输入/合成器管道会话级卡死（点击报 ✓ 但 handler 不响应+截图通道超时，evaluate 仍通——需人工重启浏览器后复验，见 vNN 实录记录）

## V202609080016 — 2026-09-08 [fix]
- 录制第三轮实录（带录屏 ground truth 比对）两实锤修复：**bug① = 事件成对重复（双 recorder 实例）**（证据：165 事件 66 组成对——同毫秒/同 tab/同 frame/同目标仅 seq/docId 不同；根因：executionContextCreated 补注入分支对**所有** execution context 注入 initScript，而 CDP 为每个 frame 暴露 main world + isolated world 多个 context——isolated world 的 window 是独立对象，recorder IIFE 哨兵 `window.__chromeuseRecorder` 查不到主世界哨兵 → 完整第二实例（含全套事件监听）→ 双份事件，binding 会话级全 context 可用双实例都能回程、seq/docId 各自独立致去重键不同全部落盘）：修复 = 补注入只认主世界（`ctx.auxData.type === 'default'`，isolated 直接跳过，注释写明双实例根因）；Page.addScriptToEvaluateOnNewDocument 不动（本来就只跑 main world）。**bug② = 关 tab 后清理未触发（死 target 残留 + closed 标记缺失）**（证据：录制日志 `getTargetInfo 现取失败（D87EDD91，重试 1 次仍败）：-32602 No target with given id found`——该 tab 录制中被用户关闭，attachedToTarget 曾触发但 detachedFromTarget 从未执行：无"已关闭"日志、targets 台账无 closed 条目；根因：Chromium 关 tab 发的是 **browser 级 Target.targetDestroyed（无 sessionId、params.targetId 直接携带）**，record.js 只监听了 session 级 detachedFromTarget）：修复 = onEvent 新增 targetDestroyed 分支 + 两分支清理动作收敛为同一 `closeTarget(targetId, via)` 幂等小函数（targetsMeta 标 closedAt——`!closedAt` 守卫天然幂等因两事件可能先后到达 + targetStates.delete + 同款"[record] tab-N 已关闭（url，经 detachedFromTarget|targetDestroyed）——已录事件保留"日志；detachedFromTarget 经 targetOfSession(sid) 反查、targetDestroyed 直接用 params.targetId）；**cdp-core 分发层核实（硬前提）**：ws.onmessage 对一切带 method 的消息无条件分发 `{sessionId: msg.sessionId, method, params}` 给全部监听器、无任何 sid 过滤/丢弃——browser 级事件 sessionId=undefined 原样透传，分发层无需修改；selftest #24 新增 3 条静态断言（auxData 主世界过滤 / targetDestroyed 分支+closeTarget / 两分支共用 closeTarget）；recorder.js/events.js 本轮零改动（两 bug 全在 record.js 侧）

## V202609080015 — 2026-09-08 [fix]
- 录制管线第二轮实录两修：**实锤 = 去重键跨导航碰撞**（证据：tab-2 main frame 从 chrome://newtab 整页导航到示例ERP OS 后示例ERP主文档 load navigate 事件消失、iframe 事件全在；根因：seq 是 recorder IIFE 闭包私有计数器**每个文档独立从 1 起**，同 target 同 frame 跨导航后新文档早期事件 (targetId,main,1/2/3…) 与旧文档撞三元键被 seen 集合当重复静默丢弃——多 target 下切 tab/整页导航是常态，系统性丢数据）：**docId 文档代际**修复——recorder.js IIFE 顶部 `DOC_ID = Math.random().toString(36).slice(2,10)`（每文档实例唯一）、send() 每条事件打 `docId`；record.js 去重键升四元 `${targetId}:${frame}:${docId||''}:${seq}`，旧事件流无 docId 回退 '' 与旧三元键等价天然兼容；排序键 (t,tab,seq) 与 chromeuse-events/1 格式版本号均不动（docId 为新增可选字段）；**疑点 = getTargetInfo 现取失效**（tab-2 落盘快照 URL 仍是 chrome://newtab 而实际页面在示例ERP；browser 级直调路由实测正常、refreshTargetsMeta 正确 await、异常被 catch{} 静默吞掉根因无从判断）双保险修复：① **页面侧 navigate URL 兜底（主修）**——onPayload 管道内 main frame navigate 事件到达即实时回填 `targetsMeta.url`（页面自报 location.href 永远比 CDP 查询真实；title 无从知晓保留现值；targetsMeta 无该条防御跳过；状态表声明前移 onPayload 之前消除 collector listen 后 TDZ 窗口）② 现取 catch 打诊断日志 `[record] ⚠ getTargetInfo 现取失败（targetId 前 8 位，重试 1 次仍败）` + 单次重试后放弃；selftest #24 断言更新（三元键断言升四元）+ 新增 4 条静态断言（DOC_ID 生成+事件打 docId / 去重键含 docId 段 / navigate→targetsMeta url 兜底 / 现取失败诊断日志+重试）；events.js preprocess 不受影响不动（折叠键基于 tab|frame|target，与 docId 正交）

## V202609080014 — 2026-09-08 [fix]
- 录制管线多 target 首轮实录三 bug 修复：**主 bug = HTTPS 页面 beacon 被混合内容策略静默拦截**（实测 tab-1 https://bigmodel.cn recorder 注入成功但 0 事件、tab-2 http 页 30 事件正常——Chrome 主动拦截 https 页面向 http://opencode:9999 的 sendBeacon）：新增 **Runtime.addBinding('__chromeuseBeacon')** 会话级注册（flatten 会话下发、不下 executionContextId = 本会话全部 context 含后续新建可用）+ **Runtime.bindingCalled 回程处理**（payload=batch JSON 直喂现有 onPayload 管道，按 sid 归属、解析异常吞掉）——CDP 标准做法，binding 走 CDP 会话不经页面网络栈；recorder.js flush() 优先 `window.__chromeuseBeacon`（try/catch），失败/不存在回落 sendBeacon（http 页面主通道）→ fetch 兜底，双通道靠现有 (targetId,frame,seq) 三元去重天然幂等；**次 bug1 = session.targets 快照 URL 过期**（tab-2 落盘显示 chrome://newtab、实际早已导航到示例ERP OS）：flushToDisk 落盘前对每个存活 target 用 browser 级 Target.getTargetInfo 现取 url/title 覆盖存档（refreshTargetsMeta，逐 target try/catch + 1.5s 超时，失败用存档兜底）；**次 bug2 = 中途关闭的 tab 从 targets 消失**（用户关过 tab 但 session.targets 只剩停止时存活的 2 个）：detachedFromTarget 反查 targetId 标记 closedAt，落盘 targets 列表保留该条并加 closed:true（url/title 用最后已知值；stateFile 同形状）；selftest #24 增 4 条静态断言（__chromeuseBeacon 调用+sendBeacon fallback 并存 / addBinding 注册+bindingCalled 回程 / detachedFromTarget 标 closedAt / getTargetInfo 现取）；事件流头/dpr/record-stop 协议/事件格式版本号不动

## V202609080013 — 2026-09-08 [feature]
- 录制管线多 target（全标签页）升级（oracle 评审定稿五风险全落地）：默认 **Target.setAutoAttach(autoAttach+waitForDebuggerOnStart:false+flatten) 单路径**自动附挂全部存量/新增 page target（风险#5 裁定：不做 Target.getTargets 枚举——autoAttach 对存量 target 也立即发 attachedToTarget，枚举=双 session 双注入冗余；风险#2 裁定：client.onEvent 处理链**先注册再发 setAutoAttach**——attachedToTarget 可能先于命令响应到达）；**事件双标 tab+targetId**（tab-N 别名按 attach 顺序分配，关了重开=新别名；OOPIF/service worker 不占别名——混入打碎 tab 语义，同源子帧由页面内自传播覆盖）；**风险#1 三处键原子落地**：record.js 去重键升三元 `${targetId}:${frame}:${seq}`（跨 target seq 无意义）｜recorder.js send() 每条事件打 tab+targetId 双标｜events.js IME 折叠键与 scroll 突发键加 e.tab 维度（缺 tab 回退 '' 兼容旧事件流，chromeuse-events/1 不 bump）；**风险#3 per-target 错误隔离**：注入链（Page.enable→addScript→Runtime.enable→上下文补注入→存量 evaluate）每 target 独立 try/catch+状态表，chrome:// 崩溃 target 不拖垮录制循环；**风险#4 pagehide 终刷**：recorder.js 补 pagehide+visibilitychange→hidden 的 sendBeacon 同步终刷（多 target 后关 tab 是常态，防丢尾部 ≤200ms）；停止铁律保持（flushToDisk 同步首刷→collector.stop+client.close O(1) 拆除，WS 断开浏览器自动回收全部 session，不逐 session ping）+可选二次补尾已实现并测（存活 session 逐个 __chromeuseRecorder.flush() 等 300ms 覆写落盘，异常全吞首刷已安全）；cdp-core.js attach() 补 sessionId→targetInfo 反向映射（registerSession/targetOfSession）；落盘排序三段键 (t, tab, seq)；事件流头 session.targets:[{tab,targetId,url,title}]、stateFile 同形状（record-stop 只读 port/pid/out 不受影响）；15s 采样日志按 tab 分列；「录制中」提示等全部初始注入完成（inflight 归零，30s 兜底）后打印；collector.js stopping 语义收窄（只挡 onStop 重入，payload 处理到 server close——防停止窗口丢数据）；--target 保留单 target 降级路径（不 setAutoAttach）；cdp.js record 帮助文案/SKILL.md 文件地图一句话/openclaw.md CLI 模板/distill.md 分段键升级 (tab, navigate)+多 tab=每 tab 独立 flow（flow-engine 不加 tab 原语——明确不改）联动更新；selftest 新增 #24（preprocess 两 tab 交错 input 不互相折叠/同 tab 仍折叠/旧流缺 tab 兼容/scroll 跨 tab 不并案 4 单测 + 录制链静态断言 7 条：pagehide+visibilitychange/setAutoAttach/三元去重键/监听器先注册顺序/折叠键含 tab/resolveTarget 仅降级分支 1 处/tab 别名+分离处理）

## V202609080012 — 2026-09-08 [doc]
- 勘误收口 + 蒸馏协议终稿（执行方案 v2.1 §V012 按修正简报改向）：distill.md 写入**通用性评分指令**（升级判定双轴量化成表——根因轴/解法轴各 0/1/2 分，双轴各 ≥2 才 candidate-通用，附判据一句；候选≠升级与唯二触发器重申）+ 输入节对齐两级 TODO（apps/<app>/TODO.md 入关联知识清单）；reports/ 知识库 DPR 勘误标注（最优架构-v3 / 执行方案-v2.1 / 优化思路分析报告三文件顶部标注因果推翻与立场指针，正文不动）；剩余 DPR 表述核查（playbook 社区案例索引带佐证范围说明、TODO INBOX 历史行按只追加纪律保留、V202609080010 澄清行已覆盖）——本轮 V007~V012 六版本收官

## V202609080011 — 2026-09-08 [feature]
- V008 定位精度（执行方案 v2.1 §V011，必须在 DPR 撤销后做——定位基线已定）：lib/target-resolver.js 新建（定位实现单源，纯函数 Node 可单测）：①语义层加 **tspan 子片消歧**（候选文本是父元素完整文本真子片→降权——「销售订单」exact 误中「销售订单修改」tspan 的实测教训固化为引擎行为）②**grid-context 定位**（{grid:{headers,row,col|colIndex}}：表头语义序列**有序子集匹配** headersSubmatch+行号+列名定位单元格，匹配数最高网格胜出）③DOM 路径（{domPath:"css"} 跨 frame querySelector）④坐标兜底 point——四层链 text→role→near→grid→domPath→point；**条件文法**（wait/assert 共用：text|element|value|count|url|network，wait 简写 urlContains 含 iframe 遍历——表单状态锚定；network 走 Network 域请求缓冲不进页面表达式）；buildLocateExpr/TEXT_EXISTS 从 flow-engine 迁入（组装时注入纯函数源码，测=跑一致）；失败报告增强（stoppedAt.stepNo+当时 URL、urlTrail 每步 URL 轨迹、attempts 带 fragments 计数）；SKILL.md 写入 **MCP uid 翻译规则**（uid 是快照临时分配，写 flow 必须翻译成语义定位器再落盘）；playbook §flow 回放守则重写（四层链/条件文法/dbl 双击/原生 DPR）；selftest #23 定位解析单测组 7 用例；实测门：修正 flow **3 连过**（14/14×3 原生 DPR）+ 条件文法正路径 4/4（urlContains/count/url）+ 异常路径 TARGET_NOT_FOUND 报告字段齐全（步骤号/当时 URL/候选/urlTrail）

## V202609080010 — 2026-09-08 [fix]
- **DPR 结论反转：撤销一切默认 DPR emulate**（修正简报裁定——用户实证原生 DPR 1.5 下人工全可点，"幽灵菜单=DPR 布局断裂"假设被证伪；0×0 rect=菜单关闭态正常测量、elementFromPoint 穿透=测量时无菜单打开、emulate"修复"未做对照验证）：flow-engine 撤销启动即 applyDpr（改读 devicePixelRatio 记录参考，不修改不告警；applyDpr+emulate 原语保留为可选工具，默认不启用，用完恢复）；record.js dpr 改读实际值写事件流头（dprSource 实测值）；两 flow 撤销 emulate 步骤、_meta.dpr 改原生 1.5+dprNote；SKILL.md 专题二根因改写（ symptoms 不变，排查序反转：文本匹配歧义+主线程冻结=高先验，DPR 降为低先验，0×0 先查关闭态误测）；playbook §专题二深度重写（证据链重审+社区案例保留但标注佐证范围=坐标换算非布局归零+DPR 立场定稿）；apps/erp_demo DPR 手法条目撤销+幽灵菜单条目重新归因；TODO-017 gate 作废关闭（wontfix）+ INBOX 反转记录；distill.md/facts.md/playbook 坐标换算表述联动勘误；cdp.js flow 摘要输出实际 DPR。
- **self-heal 实测三连修（原生 DPR 回放门）**：①「销售订单」exact 误中「销售订单修改」的 tspan 子片（同词前缀歧义实证——修正简报归因实锤）→ flow 增「点销售管理展开分组」前置步；②侧栏模块项单击不打开（apps「需双击」登记在当前部署复核成立，双击 2.5s 开 vs 单击 60s 无响应）→ flow 改 dbl:true；③顺带修复 flow-engine click 原语 dbl 参数未实现缺陷（该字段此前被静默忽略——sales-delivery flow 的双击步骤实际执行单击）。修正后 flow 原生 DPR 1.5 无 emulate **14/14 两连过**（含历史"幽灵菜单"路径：底栏下拉+菜单项原生直点即过——DPR 因果彻底证伪的实证）

## V202609080009 — 2026-09-08 [feature]
- 应用识别 matchers + 用户断言（执行方案 v2.1 §V009 + 需求 A 终审）：lib/matchers.js 新建（分段锚定语法 host[:port][/pathPrefix，host 通配仅整段 *；正则不做——ReDoS；裸子串语义否决——192.168.1.7 命中 192.168.1.70 假阳性消除｜URL 归一去 query/hash/尾斜杠｜约束度确定性打分：精确段 4 分/段+port 2 分+pathPrefix 1+段数，同分多命中=歧义问用户，禁声明序｜extractMatchersMd 取 apps/<app>.md 首个含 matchers 的 jsonc 块｜用户断言两级：会话级绑定零持久化 + 记忆化 tmpdata/url-assertions.jsonl，断言优先级最高）；apps/erp_demo.md 首部 matchers 块落地（精确部署 + *:10000/osweb 宽模式兜底 + knownDeployments 版本指纹登记）；SKILL.md 步骤⓪ 改写五步（提 URL→遍历 matchers→单命中直载/多命中问人/零命中问人→标题二重确认→断言登记）；flow 引擎安全阀（回放前校验 _meta.app 对应 apps 文件存在 + matchers 与当前 URL 匹配——APP_NOT_FOUND/APP_MISMATCH 拒执行防错应用；每次 goto 后复检，全程未命中记 warning）；cdp.js 新增第 13 子命令 identify（exit 0 单命中/3 多命中问人/1 零命中；--assert-app 记忆化）；selftest #22 matchers 单测组 11 用例（含 alpha 实锤假阳性注入与歧义构造）+ #14 扩展 matchers 块机检 + #17 收录 identify；实测门：真实 ERP URL 单命中直载/临时第二 app 多命中 exit 3 问人/零命中 exit 1/断言记忆化走通/APP_NOT_FOUND 拒回放，全过

## V202609080008 — 2026-09-08 [doc+feature]
- 两级 TODO + distill 打标 + app 目录规范（执行方案 v2.1 §V008）：apps/<app>/TODO.md 规范定稿并落首实例 apps/erp_demo/TODO.md（INBOX 只追加 + 结构化条目 + 编号前缀独立空间 GQ-001 式 + 双向链接行「升级状态: app-only｜candidate｜已升级→skill TODO-NNN (date)」+ 首批条目 GQ-001 SELECT_ITEM 竞态=app-only / GQ-002 库存锁定下拉疑因=candidate）；升级判定双轴（根因不引用专有资产 + 解法可复制，同时成立才标 candidate）+ 唯二升级触发器（第二 app 撞同坑 / 人工确认，候选≠升级，AI 永不自动升级）；distill.md 产出③坑清单目标改判 apps/<app>/TODO.md INBOX + AI 打标规则（默认 app-only，双轴成立才 candidate-通用 附一句判据）；skill TODO.md 使用规则补两级 TODO 分流与防悬空条款（skill 条目 resolved → apps 条目标注"上游已解决"）；SKILL.md 文件地图补 apps/<app>/TODO.md 行；selftest 新增 #21（同构格式抽查 + 编号前缀独立机检 + 升级链接存在性，负向用例验证 TODO 前缀被抓出）

## V202609080007 — 2026-09-08 [refactor]
- tmpdata + 路径单源地基建（执行方案 v2.1 §V007，后续所有落盘踩新路径）：lib/paths.js 新建（SKILL_ROOT/TMPDATA_DIR/EVENTS_DIR/FLOW_FAIL_DIR/LOCKS_DIR/LOCK_PATH 六导出 + ensureDir 随用随建）；写盘方收口（lock.js 锁迁 tmpdata/locks/ 且获取前 mkdir -p｜flow-engine 截图→tmpdata/events/、失败报告 JSON+终态截图→tmpdata/flow-fail/｜record 事件流/状态文件→tmpdata/events/｜cdp.js net/screenshot 默认落 tmpdata/events/，events.js 死常量删除）；install.js PRUNE_KEEP 坑修复（+/^tmpdata\//——缺失时桌面 copy 安装 --prune 会连事件流带锁一起删）；.gitignore +tmpdata/ 整目录；文档/flow desc 全部指向新路径；失败报告顺带增强 stoppedAt.stepNo+url；selftest 新增 #19（路径单源四收口 + PRUNE_KEEP 保护 + .gitignore 收录）与 #20（reports/events 字面量零残留机检）；实测门：截图/锁落盘新路径全通（真实浏览器）

## V202609080006 — 2026-09-08 [feature]
- 蒸馏层 + openclaw：references/distill.md（事件流→flow 草案/apps 知识草案/坑清单三产物 + 质量清单：业务意图确认/凭据脱敏复核/人机确认/回放验证 + T3 口述 fallback + >100KB 分段纪律）；references/openclaw.md（openclaw 执行端手册：判定树三档/CLI 直调模板/白名单 flow/审计要求/微信远程执行按不可信输入设防的安全边界五条）；install.md 增 §0 工具层运行要求（Node≥22 检查命令+降级声明）与 §3 cdp.js probe 冒烟；SKILL.md 文件地图（tools/、distill、openclaw）与排障路由（专题二/flow 失败/cdp.js 报错）更新；selftest #4 预算收录 distill/openclaw。至此 v3 定稿架构（V202609080001~006）全部落地，转入"使用→发现→头脑风暴→大版本迭代"模式

## V202609080005 — 2026-09-08 [feature]
- 录制层落地：tools/recorder.js（纯前端注入资产：IIFE+全 passive+capture 采集 click/dblclick/input/change/keydown(Enter,Tab)/scroll(节流零布局读)/navigate(history 包装)，密码字段录制端脱敏 ***，IME composition 折叠，frame 路径+当时 DPR 描述符，主世界向存量同源子帧自传播）；lib/record.js（record 编排：.chromeuse.lock+heartbeat、beacon 按 environment 路由 NAS=opencode:9999、initScript+执行上下文双保险注入——实测 Page.enable 是 flatten 会话 addScript 的前置、状态文件+record-stop 跨进程优雅停止、落盘去重排序）；lib/events.js（events-summary 确定性预处理：scroll 突发过滤/IME 折叠/类型帧分布；recorder-convert T2 转换器：DevTools Recorder selectors 数组数组拍平→text/aria 映射、不可映射出 warning）。S1 spike 三时序实测：①导航前注入 ✓ ②已加载页注入当前文档不生效、reload 后生效 ✓ ③运行期新挂同源 iframe 被 initScript 自动覆盖 ✓（补注入保留范围=存量子帧自传播）

## V202609080004 — 2026-09-08 [feature]
- flow 引擎落地：lib/flow-engine.js（chromeuse-flow/1 schema 校验 + {{var}} 插值 + 四层定位回退 text→role→near→point + 纯 CDP Input 域真实事件回放器 + 每步独立超时 + 附录 A3 结构化失败报告落 reports/events/）；cdp.js flow validate/replay 真实路由（replay 入口 .chromeuse.lock 互斥；未指定 --target 自建标签自关）；selftest 新增 #18（apps 递归 flows/*.flow.json schema 校验）+ #18b（凭据禁词键名机检）；playbook 新增 §flow 回放守则（self-heal retry≤1 协议）；首个真实 flow：apps/erp_demo/flows/sales-order-inventory-lock.flow.json（13 步：门户→直达应用→销售订单→库存锁定下拉→断言）。实测门两连跑 0~12 步全过（含幽灵菜单下拉在 DPR 1.0 下真实点击成功+业务断言通过），实证三条新经验：① emulate 施加于导航前会被 goto 重置（导航后重申）② DPR 1.5 原生点击坐标错位不开模块、emulate 1.0 后同坐标即开（专题二定论）③ SVG 菜单文本先渲染事件后接线，过早点击被静默吞（SELECT_ITEM 竞态同族）——均已回写 flow desc 与 apps/playbook

## V202609080003 — 2026-09-08 [feature]
- 工具层基建（raw CDP 逃生舱）：lib/cdp-core.js（Node≥22 守护 + 内置 WebSocket 连接管理 + 每命令独立 5000ms 超时执行器 + /json/list·attachToTarget 目标解析 + 错误归类）+ lib/lock.js（.chromeuse.lock 互斥：owner+PID+heartbeat，15s 无心跳 stale 可抢占）+ lib/collector.js（beacon/record 共用零依赖 HTTP 收数）+ tools/cdp.js 十二子命令（probe 三通道探测/exec 万能口/targets/net/screenshot/beacon 默认绑 0.0.0.0 修 NAS 路由/watch 看门狗 detect&advise 不自动杀/flow·record 系列占位）；selftest 新增 #17（node --check 全 tools/lib + 各子命令 --help 冒烟零连接）；install.js manifest 加 tools/ 与 apps 递归 flows；playbook 新增 §逃生舱（子命令速查 + 使用纪律 + redflags 六条固化）；TODO-012~017 登记

## V202609080002 — 2026-09-08 [feature]
- P1-b 专题二「DPR / 零命中元素」：SKILL.md 新增浓缩决策树（症状=可见不可点/a11y 空节点 → 查 DPR → 逐层 elementFromPoint 只读诊断 → emulate DPR 1.0 → 收尾沉淀）；playbook 新增 §专题二深度（示例ERP OS 库存锁定幽灵菜单全案：0×0 rect/溢出绘制/穿透网格画布/外部点击不收起 + 社区案例索引 + emulate 解法与注意事项）；apps/erp_demo.md 新增库存锁定下拉幽灵菜单专属条目

## V202609080001 — 2026-09-08 [fix]
- P1-a 文档固化：①"截图恒可用"类表述全部修正为"通常最后失效"（ChatGPT 硬阻塞实测截图也 -32001、等待 ~20s 自愈——SKILL.md 通用循环/工具速查/通道分级表 + playbook click_at 边界共 4 处）② facts.md 新增「工具层实测事实」节（pageId 显式传参 / 截图像素≠CSS 像素·click_at 用 CSS 坐标 / ChatGPT 冻结时间线）③ playbook §通用深度加 pageId 与 DPR 坐标换算 ④ apps/erp_demo last-verified 刷新 ⑤ TODO INBOX 补录 ChatGPT 冻结行并标注吸收

## V20260907002 — 2026-09-07 [fix]
- mcpDefaults.timeoutMs 推荐值 120000 → 60000（用户裁定：真死锁场景 120s 等待过长；运行层 NAS 真身同步回落 60000，--experimentalVision 保留）。TODO-006 继续跟踪 timeout 提档副作用

## V20260907001 — 2026-09-07 [feature]
- skill 创建（阶段 0 骨架）：chromeuse 浏览器自动化操作手册——宽触发 SKILL.md 总手册（通用操作循环 + 通道分级 + 红线纪律 + 专题一浓缩决策树 + 排障路由）+ config 双模板（config-template-linux/windows.jsonc，四层真源模型的推荐层，config.jsonc 为 gitignored 机器实例经 --init-config 实例化）+ install.js/selftest.js 零依赖脚本 + lib/（jsonc 四态状态机解析器、config 代理解析链）+ references/（install 两环境配置、playbook 深度操作、facts 技术事实）+ apps/erp_demo 应用专属经验种子；TODO 台账初始 10 条（001~007/009~011，008 留空）。
