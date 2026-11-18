# chromeuse 安装与环境配置

## §0 通用：真源模型 / 真身路径 / 安装 / 实例化

**四层真源模型**（每一层各有一个真源，层间是生成与核对关系）：

```text
模板层  config-template-{linux,windows}.jsonc   推荐真源（git 共享；selftest #8/#9 锚点）
实例层  config.jsonc                            本机生效配置（gitignored；--init-config 生成；可自由改值）
展示层  本文件（install.md）                     模板值的投影（selftest #9 机检与模板一致）
运行层  opencode.jsonc                          运行态真源（铁律：install.js 永不触碰）
```

> **实例层无副作用**：改 config.jsonc 只改变 skill 的提示与指引，不改 MCP 行为。要让 MCP 行为变化，必须改运行层 opencode.jsonc 真身并 restart（见 §1/§2）。改"推荐值"本身 = 改仓库模板 + 推广流程（bump + CHANGELOG + 提交），私改模板会被 `--check` 的 sha256 检出。

> ### ⚠ 红字：两环境 MCP 配置真身路径（改这里才生效）
> - **NAS**：部署机卷内 `opencode/root/.config/opencode/opencode.jsonc`（容器内路径 `/root/.config/opencode/opencode.jsonc`，/root 整挂宿主）。**仓库骨架 `opencode/root/` 写了不生效**——它只是种子占位，真身在部署机卷。
> - **桌面端（Windows）**：`%USERPROFILE%\.config\opencode\opencode.jsonc`。
> - Playwright MCP 互补通道当前**状态：未启用（gate：【Playwright MCP 并存实测（事件竞争+超时调优）】）**——并存守则见 playbook §专题一；`enabled` 翻转须与 config 模板 `playwright.status` 同一推广原子完成。

**skill 本体安装**（源目录 = 仓库 `opencode/root/.config/opencode/skills/chromeuse/`——v65 起 skill 统一目录；默认目标 = `~/.config/opencode/skills/chromeuse`）：

```bash
node install.js                                # copy 安装（桌面端默认推荐）
node install.js --link                         # 链接安装（NAS / 作者端推荐：源改即生效，免重装）
node install.js --check                        # 漂移检查（exit 0 in-sync / 2 drift）
node install.js --prune                        # 清理装机目录白名单外文件（config.jsonc/*.bak-* 永不删）
node install.js --init-config auto             # 实例化本机 config.jsonc（linux|windows|auto）
```

> **临时数据目录可覆盖**（V202610280004 ISSUE-3）：默认落 `<skill>/tmpdata/`（整目录 gitignored）；**若 skill 安装在 opencode skills 监视根内（如 `~/.config/opencode/skills/`），跑全量 selftest 前建议 `CHROMEUSE_TMPDATA_DIR=<监视根外绝对路径>` 覆盖**，避免高频写盘触发 skills watcher 重扫（2026-10-28 Windows 端实测风暴：40~187 次重注册/秒，serve 需重启）。值须绝对路径；未设/空串走默认，非绝对路径回退默认并在 stderr 告警。
>
> **日志目录可覆盖**（V20261117014 ISSUE-2）：`CHROMEUSE_LOG_DIR=<监视根外绝对路径>` 单独指定 `log/` 落点（默认 `<skill>/log`，未设/空串逐字节同旧版）；相对路径按 **SKILL_ROOT 基准**解析（非 cwd）。与 `CHROMEUSE_TMPDATA_DIR` **成对使用**可让测试/批量运行完全不写监视根内的 live 目录（`CHROMEUSE_LOG_ECHO=0` 只静默 stdout 回显，不阻止写盘）。

**工具层运行要求**（tools/cdp.js 及 lib 引擎；2026-09-08 起）：

```bash
node --version    # 须 >= 22（内置 WebSocket + fetch；NAS 容器 Node 22.22.3 ✓）
```

- Node < 22 时工具层启动即明确报错指回本节（R29）；**降级声明：工具层不可用不影响 skill 主功能**——chrome-devtools MCP 通道照常，逃生舱/flow/录制暂缺（【桌面端 Node 版本分布观察】）。
- 零第三方依赖（Node 内置 WebSocket/fetch/http/fs），无需 npm install。
- ffmpeg/ffprobe 来源 = `config.jsonc` 的 `bin` 节（模板已默认显式声明 `bin/ffmpeg`、`bin/ffprobe`）：**相对路径以 skill 根为基准解析、与 cwd 无关**；ffmpeg 装在别处就改成绝对路径（Windows 例：`"ffmpegPath": "C:\\ffmpeg\\bin\\ffmpeg.exe"`，不知道装在哪用 PowerShell `Get-Command ffmpeg` 查）。**不做 PATH 自动探测**（bin/ 单点真源，2026-10-28 裁定）。已有实例升级到本版后 `#16` 会提示缺 `bin.ffmpegPath`/`bin.ffprobePath`——按模板默认相对值补上即可（Windows 写 `bin\ffmpeg.exe`/`bin\ffprobe.exe`；已安装别处填绝对路径）。
- 长页长图（scroll-shot）：先 `node tools/cdp.js scroll-shot --target <页> --dry-run` 看分段计划（段数/预热/图片就绪），实跑产物 `tmpdata/events/<name>-NN.jpg` + `<name>.json`（默认 jpeg q90）；**旗标语义/分段/预热细节 → SKILL.md §1.2 捕获（全量）**。前台保障默认开（后台页签 raw `Page.captureScreenshot` 会超时/返回旧帧，`--no-foreground` 显式放弃并告警）。
- 懒加载与空段（细节 → SKILL.md §1.2 捕获 / `scroll-shot --help`）：`--img-promote` 默认开（`data-cu-promoted` 打标）、`--no-img-promote` 关；就绪判据 `naturalWidth > 1`；`--img-settle 1800`；空白自检默认 advisory，`--blank-strict` 才 exit 1，`--blank-min-px`/`--blank-threshold` 调阈值、`--no-blank-check` 关、清单 `blankSummary.strictFail`。
- 切点吸附（F15，细节 → SKILL.md §1.2 捕获）：`--snap-cuts` 默认开，`--snap-window` 调窗口、`--no-snap-cuts` 关、`--snap-px` 像素法兜底；清单 `snapConfig`；「不为吸附把段拉长」依据 `L77`。
- **快速上手（cdp 主通道，2026-10-31 用户裁定；MCP 为 fallback）**：感知 → 交互 → 验证一条链——`node tools/cdp.js probe` / `targets`（通道与页签）→ `a11y --depth 3`（感知，只读）→ `click --text "提交订单"` → `type --text "abc" --into-selector "#kw"` → `key Enter` → `wait --text "提交成功" --timeout 10000`；`hover --text "菜单"` 展开浮层；`screenshot` / `scroll-shot` / `cast` 取证。
- **进阶能力（2026-11 能力补强批）**：交互后确认生效 `click --text 保存 --expect-text 已保存`；先看后点 `a11y --ref` → `click --ref @e3`；巨树找元素 `a11y --find "文本"`；抓表格 `extract --kind table --selector table`；长任务 `scroll-shot --async` + `job status <id>`；产物清理 `artifacts report` / `artifacts prune`（默认 dry-run）；操作审计 `audit stats`——全部命令契约详见 SKILL.md §1.2 与 `references/mechanisms.md`。
  - 输入/定位纪律：全部 Input 域真实事件（isTrusted，禁 DOM 合成）；文本/CSS 定位跨同源 iframe，**多候选不猜**（`--nth N` 显式选或收窄）；目标在视口外自动 `scrollIntoView` 一次，仍在顶层视口外报错不盲点。
  - 命令与排错：命令清单/一行式 → SKILL.md §1.2；完整旗标 → `node tools/cdp.js <cmd> --help`（SUB_HELP 唯一准源）。console 取证：`node tools/cdp.js console --listen 3000` 先开窗口再复现（`--listen 0` = 立即读浏览器侧 console 历史回放，连接前条目标 `pre:true`；Chrome 153 实测 `Runtime.enable` 回放，88 未验证），全量报告落 `tmpdata/events/console-*.json`。
- DEST 优先级：`--dest <路径>` > 环境变量 `CHROMEUSE_DEST` > `~/.config/opencode/skills/chromeuse`。
- `--init-config` 实例化 = 模板**逐字复制**到**脚本所在目录**为 config.jsonc（实例化时刻 = 审阅值的时刻）；已存在拒绝（exit 1），`--force` 先重命名为 `.bak-<时间戳>` 再重建（绝不覆盖丢失机器改动）。普通安装**不会**自动实例化——缺实例时安装结束会醒目提示。`auto`（含省略模式）= 按平台取模板：**win32 → windows**（`browserUrl=http://127.0.0.1:9222`）、linux → linux（`browserUrl=http://chrome-browser:9224`）；Windows 上直接拷 linux 实例会报「无法连接 http://chrome-browser:9224」，用 `node install.js --init-config windows --force` 重建或手改 `mcp.browserUrl`。
- config.jsonc **永不**被 install.js 复制/覆盖/prune（机器实例跨机器复制必错）；模板则随 manifest 正常拷贝。
- **分发清单与 flow 测试参与策略（R4，V20261117011）**：manifest 覆盖文档面（SKILL/README/CHANGELOG/TODO/VERSION）、commands.meta.json、scripts/build-help.js、`lib/`（含平台层 `lib/platform/`）、`tools/`、`snippets/`、`references/*.md`、`config/*.jsonc`、`selftest/`（`*.js` + fixtures 数据文件）与 `webapps/` 递归（`*.md`、`flows/*.flow.json`、`<app>/selftest.js`、`<app>/popup-rules.jsonc`、`<app>/selftest.config.jsonc`；排除 `*.local.json`）。`selftest.config.jsonc` 是分发物不是机器实例——live 与骨架同语义同排除；排除/撤销 = 改该文件（撤销即恢复全量参与），`--check` 缺它报 drift 属正确行为。
- 启动 fail-fast：config.jsonc 存在但坏（parse / schemaVersion 失败）→ exit 1 不装半成品。
- **多环境切换（临时 config 实例，V20261117005 批B/R3）**：`node tools/cdp.js --config <path> <cmd>` 用另一份 config 实例跑单次命令——**全局 flag、位置无关**（`--config x probe` ≡ `probe --config x`，也认 `--config=<path>`），整份实例生效（`environment`/`mcp.browserUrl`/`bin` 等全换），相对路径按**当前 cwd** 解析（注意：与 `bin` 键的相对路径基准=skill 根不同域）。仅本进程有效，不改 `config.jsonc`；文件不存在/坏 JSONC → exit 1（不静默回落主实例）。与 `--url` 的区别：`--url` 只覆盖 browserUrl 单值、优先级最高；`--config` 换整套实例（含平台语义）。跨环境测试例：Linux 上用 `environment: windows` 的临时实例 = 按 Windows 语义跑（PATH/exe 探测按 Windows 规则），启动打一行「不一致」warn，属合法用法；`--async` 作业子进程经 `CHROMEUSE_CONFIG_PATH` 继承同一实例。机制 → `references/mechanisms.md` §25，场景 → playbook §临时实例。

## §1 NAS 环境（config: linux）

适用：opencode-xdg 容器（项目 `/app/coding-started-projects/projects/opencode-started`）；浏览器在 coding-envs 项目 `chrome-browser` 容器，MCP 经 nginx sidecar `:9224`。

**运行层 opencode.jsonc 片段**（真身路径见 §0 红字；值与 config-template-linux.jsonc 一致）：

```jsonc
"mcp": {
  "chrome-devtools": {
    "type": "local",
    "command": ["npx", "-y", "chrome-devtools-mcp@latest",
                "--browser-url=http://chrome-browser:9224",
                "--experimentalVision"],
    "timeout": 60000,
    "enabled": true
  }
}
```

**npm 预热**（首次 / 版本变更后在容器内执行，把包拉进 npx 缓存，避免首次调用即超时）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
  npx -y chrome-devtools-mcp@latest --version
```

> 代理地址 = config `proxy.httpProxy` 登记值（解析链生效值可用 `node install.js --check` 查看打印）。

**重启生效**：

```bash
docker compose restart opencode
```

> ⚠ restart 会中断容器内**所有**运行中会话——须由用户确认 / 空闲期执行；**agent 不得在任务中自杀式 restart**（SKILL.md 红线 #5）。

**四步验证清单**：按 §3 共通模板执行。

## §2 桌面端 Windows（config: windows）

**第一步：带调试端口的 Chrome**（Chrome 136+ 起调试端口必须配非默认 `--user-data-dir`，否则旗标失效）：

```powershell
Start-Process chrome.exe -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\chrome-debug'
```

> 三键与 config-template-windows.jsonc 的 `chrome` 节一致：launchCommand `chrome.exe` / debugPort `9222` / userDataDir `C:\chrome-debug`。登录态存在该 profile：首次各网站手动登录一次，之后 AI 复用同一实例。
>
> **或直接 `node tools/cdp.js browser-up`**（推荐）：自动发现 chrome.exe（绝对路径→App Paths 注册表→安装目录表→PATH）→ 拉起 → 等就绪（幂等可重跑；`--stop` 关停 / `--status` 查询）。仅 Chromium 内核（Chrome/Edge/Brave/Chromium；Firefox/Safari 不支持 CDP）。场景与 --auto-launch → playbook §本地调试实例拉起。
>
> **代理按需在命令上给**（V20261117014 ISSUE-3，用户裁定 b：config `proxy.httpProxy` 保持空串常态、不改配置）：`node tools/cdp.js browser-up --proxy http://127.0.0.1:7897` 即给被拉起的 Chrome 注入 `--proxy-server`（Windows Chrome **不读** `HTTP_PROXY` env，必须走此参数）。优先级 CLI `--proxy` > env `CHROMEUSE_BROWSER_PROXY` > config `proxy.httpProxy`；三者皆空不注入（与旧版一致）。仅 http/https/socks5 前缀（非法值 E_USAGE）；仅影响被拉起实例——已启动实例需先 `--stop`；`--status` 显示 state 记录的脱敏代理值（`user:pass` → `***`）。

**第二步：运行层 opencode.jsonc 片段**（真身 `%USERPROFILE%\.config\opencode\opencode.jsonc`）：

```jsonc
"mcp": {
  "chrome-devtools": {
    "type": "local",
    "command": ["cmd", "/c", "npx", "-y", "chrome-devtools-mcp@latest",
                "--browser-url=http://127.0.0.1:9222",
                "--experimentalVision"],
    "timeout": 60000,
    "enabled": true
  }
}
```

> `cmd /c` wrapper：Windows 下 npx 是 .cmd，直接 `["npx", ...]` 会 spawn 失败。
> npm 首次下载如需代理（登记值与 NAS 同源）：`$env:HTTPS_PROXY='http://127.0.0.1:7890'; $env:HTTP_PROXY='http://127.0.0.1:7890'` 后再 npx。

**第三步：重启 opencode（桌面端 = 重启 opencode 进程 / 窗口）→ 验证按 §3。**

### Windows 端行尾归位与验证（一次性）

> 背景：根 `.gitattributes` 已对全仓 `*.js`/`*.md` 固定 `eol=lf`（本 skill 目录另有 `skills/**` 规则）。Windows 端 `git pull` 后，属性生效前旧检出的文件工作区仍是 CRLF，须一次性定向重检出——否则 selftest #7 报 CR WARN；matchers 的 CRLF 回归闸虽已在 V202610280004 修复，工作区仍应回到 LF 基线。

**① 列出待归位文件**（`w/crlf` = 工作区仍为 CRLF；预期≈根文档/README/webui-ext js/skills 内 5 个旧检出，以实际输出为准）：

```powershell
git pull
git ls-files --eol | Select-String 'w/crlf'
```

**② 定向归位**（只处理上一步列出的文件；⚠ 禁用整树 `git checkout-index -a -f`——会覆盖未提交修改）：先打印清单，核对后输入 `y` 才执行删除+重检出：

```powershell
$targets = git ls-files --eol | Select-String 'w/crlf' | ForEach-Object { ($_.Line -split "`t")[-1] }
$targets
if ((Read-Host "以上 $($targets.Count) 个文件将删除并重检出，输入 y 继续") -eq 'y') {
  $targets | ForEach-Object { Remove-Item -LiteralPath $_ -Force; git checkout -- $_ }
} else { Write-Host '已取消，未改动任何文件' }
```

> 若清单出现 `w/mixed`（部分行 CRLF），把筛选串改为 `'w/(crlf|mixed)'` 后同上处理。

**③ 复验**（应输出为空）：

```powershell
git ls-files --eol | Select-String 'w/crlf'
```

**修复效果验证清单**（Windows 端逐条执行）：

| 命令 | 期望 |
|------|------|
| `node selftest.js` | `SELFTEST：ALL PASS`；**#7 零 WARN**（BOM/LF 扫描）；**#14/#61 全绿**（webapp.md matchers 提取）；**#22 全过**（含 CRLF 回归闸）；**#84** = PASS（bin 放了 `ffmpeg.exe`/`ffprobe.exe`）或 WARN「bin/ffmpeg·ffprobe 不可用…」（仓库内 Linux ELF 在 Windows 探活失败，如实跳过属预期） |
| `node tools/cdp.js scroll-shot --help` | 用法串含 `--snap-cuts`（V202610280005 切点吸附生效） |

预期剩余 WARN 仅：**#19** `SKIP 仓库 .gitignore 检查`（copy 安装到 `%USERPROFILE%\.config\opencode\skills\` 等非 git 仓位置时出现；`--link` 或仓库内直跑无此项）与**浏览器依赖跳过项**（#34/#43 在 Chrome 9222 未连通时 WARN，连通后重跑即消）。

> 以上全部满足 → TODO【行尾治理】条目可关闭（Windows 端结果回传 NAS 会话记录，由 NAS 侧收口）。

### Chrome 88 实测命令矩阵（旧版 Chrome / MCP 降级预案）

> 依据=2026-10-29 示例ERP测试批（Windows Chrome **88.0.4324.190** + 9222 + chrome-devtools-mcp 1.12.0；材料 `tmpdata/test-runs/2026-10-29/`：README §0 环境实况 + SUMMARY §七 + chromeuse-issues.md GQ-001~011 + results-B1B2~B7）。88 上唯一验证过的驱动面=raw CDP（现由 `cdp.js` 承接）；`probe`/`doctor` 对 <94 版本给 ℹ advisory——**MCP 已知降级线（非硬协议门槛）**，只提示、不改 exit 语义。现代版本（如 NAS Chrome 153）不触发 advisory，MCP 仍可作 fallback。

| 能力 | 88 实测 | 处置/替代 |
|------|---------|-----------|
| MCP `list_pages` / `pageId` | ❌ 列表恒空；pageId 跨调用漂移（GQ-002/006） | 不用 MCP：`cdp.js targets` 直接取 targetId（稳定不漂） |
| MCP 全族（click/fill/press_key/snapshot…） | ❌ 受 pageId 制约 → 跨调用长流程必断 | 走 `cdp.js` 主通道；MCP 仅 fallback |
| MCP `screencast_start` | ❌ 依赖 WebCodecs（Chrome 94+），88 无 `VideoEncoder`（GQ-001） | `cdp.js cast`（raw `Page.startScreencast` 帧流 + ffmpeg，fps 按真实跨度归一） |
| MCP `take_snapshot`（a11y） | ❌ layui 弹出 iframe 10s 超时（GQ-007） | `cdp.js a11y --depth 3` / `--find` / `--timeout`（超时必返，partial 如实标注） |
| MCP `take_screenshot` | ⚠️ 真实页面可用（pageId 稳定时） | `cdp.js screenshot`（长页用 `scroll-shot`） |
| Input 域（mouse/key/insertText） | ✅ 可用（8 批约 90 用例，isTrusted=true） | `click` / `click-at` / `type` / `key` / `hover` / `drag` / `upload` |
| DOM 域（getDocument/requestNode） | ✅ 可用 | `a11y --ref` 映射、`css --matched`、locator 定位 |
| Runtime 域（evaluate / console） | ✅ 可用（console 历史回放未验证） | `eval` / `wait` / `exec`；`console` 先 `--listen` 开窗口 |
| Page 域（navigate/screenshot/screencast） | ✅ 可用 | `goto` / `screenshot` / `cast` |
| `Page.captureScreenshot{captureBeyondViewport}` | ❌ 静默忽略（Chrome 88.0.4324 实测：返回完整请求尺寸、视口外内容刷白，不报错不夹高） | `scroll-shot` 自动双拍探测（尺寸差主判 + md5 同负判；md5 异补控制拍）→ 判不支持时段级撑视口无 clip（清单 `via=A2`）；缓存 `tmpdata/state/beyond-viewport.json`（key=浏览器版本，手删即重探） |
| Target 域（getTargets/attach/activate） | ✅ 可用 | `targets` / `new` / `close` / `select` |
| `Accessibility.getFullAXTree` | ⚠️ 可用但**无 depth 参数**（忽略传参→悬空 childIds） | `a11y --depth N` 客户端裁剪（报告标 `depthMode:client`） |
| `Browser.getVersion` / `GET /json/version` | ✅ 可用 | `probe` ① 通道 + 版本闸 advisory；`doctor` 的 `browser` 字段 |
| `Emulation.*`（viewport / UA / media） | ⚠️ 长期协议但 88 未实机验证 | `viewport` / `emulate`（`--reset` 兜底；首次先小样验证） |
| `Page.startScreencast` 帧推送 | ⚠️ 仅画面变化时推帧（静止 6s 仅 1 帧） | `cast` 已按真实跨度归一 fps，<2 帧如实失败 |
| 虚拟化宽表 / 引用字段 | ⚠️ 横向未滚列 DOM 无节点、引用字段须下拉选择（GQ-011） | 先滚到可见再读；DOM 批量取数只作交叉校验 |
| `exec` JSON 传参（PowerShell 5.1） | ❌ JSON 引号被吞（GQ-008） | `exec --params-file <file>`（避开命令行引号） |

> 88 实测可用命令集（原 gq-drive）：`pages/text/find/click/clickat/type/key/eval/shot/wait` → cdp.js 对应 `targets` / `extract --kind text` / `locator` / `click` / `click-at` / `type` / `key` / `eval` / `screenshot` / `wait`（2026-10-31 起一期~二期已落地，V20261031005~012）。

## §3 验证清单（两环境共通模板）

1. 工具层冒烟（cdp 主通道；Node ≥22）：`node tools/cdp.js probe` → 三通道（浏览器进程/renderer/合成器）存活报告，浏览器进程 ✓ 即连通；`node tools/cdp.js targets` 能列标签页。
2. `opencode mcp list` → `chrome-devtools` 在列且 enabled（MCP fallback 通道）；
3. 新会话让 agent 调 `list_pages` → 能列出标签页即 MCP 连通；
4. 任意页面轻探针：`evaluate_script("()=>document.readyState",{waitForStableDom:false})` → 返回 complete/interactive；
5. 新会话问一个浏览器实操问题（如"打开 example.com 截一张图"）→ 确认 chromeuse skill 被触发注入（description 触发面生效）。
6. 子命令自检（可选，本地零连接）：任意 `node tools/cdp.js <cmd> --help` 各自 exit 0。

### 裸机 Linux / 第三环境

- 裸机 Linux：`--init-config linux` 生成实例后改 `mcp.browserUrl`（裸机通常 `http://127.0.0.1:9222`）+ 取消模板 chrome 注释块（三子键齐备：launchCommand / debugPort / userDataDir）；改完直接 `node tools/cdp.js browser-up` 自动发现+拉起+等就绪（等价手动 `google-chrome --remote-debugging-port=9222 --user-data-dir=<独立目录>`；--stop 关停 / --status 查询；需要代理时加 `--proxy <url>`，语义同 Windows 节）。直接改模板会影响 NAS 推荐真源——勿动模板。
- 第三环境（darwin 等）：复制最近似模板为 config.jsonc、`environment` 如实填写（selftest #16 按它路由缺键检查）；MCP 片段按本机浏览器地址改写，流程同 §1/§2。
- docker 出现结构性专属键时新增 `config-template-docker.jsonc`（【docker 结构性专属配置模板】）；模板超过 4 个再评估共享节生成脚本（【模板共享节生成脚本评估】）。
