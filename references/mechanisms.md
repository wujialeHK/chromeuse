# chromeuse CLI 输出信封与错误码机制（references/mechanisms.md）

> 版本：V20261104004（B4 R2 命中诊断 + N8 extract + N9 assert；同文件含 B5 §13、B7 §14、B6a §15、B6b §16 的并行批次内容）｜准源代码：`lib/envelope.js`（信封构造/发射/audit 接缝）＋ `lib/errors.js`（码表/分类）＋ `tools/cdp.js`（三出口编排 + `--json` 放行面 + audit/artifacts/job 命令）＋ `lib/expect.js`（四态 phase/expect settle）＋ `lib/audit.js`（结构化审计）＋ `lib/quota.js`（配额/保留期/pin）＋ `lib/jobs.js`（作业槽位/状态机/孤儿/取消）＋ `lib/redact.js`（输出脱敏）
> 本文只写**机制与契约**；命令旗标/边界看 `node tools/cdp.js <cmd> --help`（SUB_HELP 准源），操作手法看 `references/playbook.md`。
> 后续批（B8 触发式等）在本文件追加对应机制小节，不再新开 references 文件。
> 行数预算：≤580 行（V20261117005 批B/R3 由 555 扩限；selftest #4 守门）。

## 1. 信封 `chromeuse-cli/1`

**发射面**：仅 `--json` 模式写 stdout（单行 JSON，`fs.writeSync` 同步落盘，`process.exit` 的 exit hook 里也完整）；非 `--json` 输出与旧版**逐字节一致**（stderr 人类可读文本照旧，audit 照旧触达）。

失败信封（B1a 实装）：

```json
{
  "envelope": { "name": "chromeuse-cli/1", "command": "click", "at": "2026-11-03T14:22:14.178Z" },
  "ok": false,
  "code": "E_USAGE",
  "message": "click 需要且仅需一种定位：…",
  "retryable": false,
  "hint": "按 --help 修正参数后重试（本类错误重试同一命令不会成功）",
  "elapsedMs": 26,
  "data": null
}
```

- `envelope.name` 恒定 `chromeuse-cli/1`；`envelope.command`=子命令名（无则 null）；`at`=ISO-8601。
- `ok`：失败恒 `false`。`code`：`lib/errors.js` 20 码表之一（见 §2），**永不输出表外值**（未知码归一 E_INTERNAL）。
- `message`：单行化 + ≤800 字符（超长截断加 `…`）；完整文案在 stderr / `--help`（信封不丢信息，只是不塞爆）。
- `retryable`：码表标记 ∧ 当前命令不在非幂等表（`click/click-at/type/key/hover/drag/upload`）；`true` 时**必带** `backoffMs`（与红线 #10 熔断同向：不让模型盲试）。
- `hint`：码表默认建议（调用方可覆盖）。`data`：默认 `null`（成功=命令自定义对象，B1b 定义；报告型失败=诊断/旧报告对象，见下条）。`evidence`：诊断类码专用；**B4 起 `E_HIT_BLOCKED` 发射**（遮挡元素/祖先/fixed 浮层，见 §12.2），B5 的 `E_REF_STALE` 预留。
- 字段序不构成契约：外部消费只按 key 读；golden 只做结构断言（`envelope.name`/`ok:boolean`/`code∈码表`/`message:string`），不锁字段序、不锁 data。
- **成功信封**（`ok()`，B1b 启用）：`{envelope, ok:true, elapsedMs, data, warnings?}`——不带 code/message。**仅 `--json` 且命令在放行面内时发射**；非 `--json` 路径逐字节不变。
- **失败信封 data**（B1b 补充）：默认 `null`；**报告型失败**把结构化诊断/旧报告放进 `data`（`emitFailWithData()`），`ok:false` + `code` 表达失败——避免「有报告却只能读 stderr」。已落地：probe 通道矩阵、screenshot 失败矩阵、goto/wait 结果对象、locator 四模式报告、console/a11y/css 旧报告、click/type/hover/drag/upload 的定位诊断。

**stdout 单文档纪律**：`--json` 下 stdout 只允许出现 1 个 JSON 文档。实现=单点 `console.log` 占用探针：命令一旦向 stdout 打过任何内容（帮助文本 / 文本报告），失败收口**不再补发**信封（只发 audit）。12 个放行命令在 `--json` 下把进度/告警一律写 stderr（`info()` 单点：`jsonMode ? console.error : console.log`）；现役 5 命令（targets/locator/console/a11y/css）已从「打印旧 JSON 报告」迁到信封（B1b）。

## 2. 错误码表（20 条；B1a 定稿）

来源＝v1 计划 17 码（hub S10 命名对齐）＋按 v2 任务书授权微调：`E_FAIL`→`E_INTERNAL`（对齐 kind 语义）、新增 `E_LOCATE`/`E_IO`/`E_BUSY`。

| code | 含义 | retryable | 本批状态 | 典型来源 |
|---|---|---|---|---|
| `E_USAGE` | 用法/参数错误 | ✗ | 实装 | die 参数校验（~120 处的默认大类）、flow 用法、**未放行命令遇 `--json`（分发层拦截，不执行；34 命令名单见 §8.2）** |
| `E_CONN` | 连接失败（浏览器不可达） | ✓ | 实装 | kind=conn、`无法连接/不可达/CDP 通道` |
| `E_HTTP` | `/json/*` 非 2xx | ✓ | 实装 | kind=http（502/503） |
| `E_TIMEOUT` | 命令/等待预算耗尽 | ✓ | 实装 | kind=timeout、wait 超时（显式码） |
| `E_CDP` | CDP 协议错误 | ✗ | 实装 | kind=cdp、`-32601/-32000/协议错误` |
| `E_DISCONNECT` | WS 断开 | ✓ | 实装 | kind=disconnect、`连接中断/已断开` |
| `E_NO_TARGET` | 未找到目标页面 | ✗ | 实装 | resolveTarget「未找到匹配的页面 target」、「需要 --target」 |
| `E_LOCATE` | 定位失败（元素/坐标不可用） | ✗ | 实装 | `printLocateFailure`（click/type/hover/drag/upload 的 locate 失败） |
| `E_IO` | 文件/IO 错误 | ✗ | 实装 | 写盘失败/读取解析失败/ENOENT/EACCES/加载失败 |
| `E_BUSY` | 互斥/并发占用 | ✓ | 映射就绪（B7 启用拒绝语义） | 「另一动作正持锁」 |
| `E_FROZEN` | watch 判定冻结（exit 2） | ✓ | 实装（exit code 映射） | `codeForExit(2)` |
| `E_INTERNAL` | 未分类内部错误 | ✗ | 兜底 | 无特征词的 die、return EXIT_ERR 无显式码、未知异常 |
| `E_NOT_FOUND` | 零命中 | ✗ | 实装（B4） | 定位候选 0 个 / container-not-found（click/type/hover/drag/upload） |
| `E_AMBIGUOUS` | 多命中不猜 | ✗ | 实装（B4） | 可点候选 >1 且未 `--nth`（click/type/hover/drag/upload） |
| `E_REF_STALE` | `@eN` 引用失效 | ✗ | 预留（B5） | ref 解析 |
| `E_HIT_BLOCKED` | 命中被遮挡/禁用 | ✗ | 实装（B4） | X1 L4 elementFromPoint 未命中（可见候选被遮挡）+ evidence |
| `E_QUOTA` | 产物配额超限 | ✓ | 预留（B3） | admit() |
| `E_BUDGET` | 时间/体积预算超限 | ✗ | 预留 | 预算类中止 |
| `E_CANCELLED` | 作业被取消 | ✗ | 预留（B7） | job cancel |
| `E_POLICY_DENIED` | 策略拒绝（白名单/红线） | ✗ | 预留 | 协议白名单等 |

**边界口径**（v2 任务书要求「与既有 kind 语义对齐」）：

- `E_LOCATE`＝定位链失败**其他出口**（视口外/nth 越界/坏选择器/收集失败等）；`E_NOT_FOUND`（零命中；含 container 未找到）与 `E_AMBIGUOUS`（多命中需 --nth）是它的**细分码**（B4 起启用，判定单源 `locateFailureCode()`，边界见 §12.1）；`E_HIT_BLOCKED`=可见候选被 X1 L4 遮挡（附 evidence）。`data.reason` 保持原始 reason，消费方可继续按 `E_LOCATE` 兜底。
- `E_USAGE` vs `E_NO_TARGET`：`--target` 找不到页/未给必填 `--target` → `E_NO_TARGET`（可行动：先 targets）；其余参数形态错误 → `E_USAGE`。
- `E_IO` vs `E_USAGE`：文件路径不存在/不可写/内容解析失败（**用户提供的文件**）→ `E_IO`；单纯缺旗标/旗标值非法 → `E_USAGE`。

## 3. 三出口改造（单点化落点）

改造前 `main().catch` 只覆盖第 ① 类：

| # | 出口 | 改造前 | 改造后（V202611030001 B1a） |
|---|---|---|---|
| ① | `throw` → `main().catch` | 打 stderr 后 exit 1 | catch 内 `noteFail(codeFor({kind,message}))` → exit hook 发射 |
| ② | `die()`（`process.exit` 直通，~120 处） | 绕过 catch | `die()` 置 `failure`（码=显式 code 或消息模式初分类）→ exit hook 发射 |
| ③ | cmd 内 `console.error` + `return EXIT_ERR`（~44 处） | catch 拿不到 | `main().then(code!==0)` 兜底：有 `noteFail` 用显式码，否则 `E_INTERNAL` |

**编排（tools/cdp.js 顶部）**：`finalizeFailure(exitCode)` 幂等（`failureEmitted` 去重）：①`envelope.auditFailure({cmd,code,msg,exitCode})` **恒触达**（--json 与否都记）；②`jsonMode && !cmdJsonEmitted` 才 `envelope.emit(envelope.fail(...))`。`process.on('exit')` 与 `main().then(code!==0)` 都调它——两条路径互补覆盖。

**写入约定（冻结裸 die）**：

- 新增失败：`fail(code, msg, extra)`（内部走改造后 die 路径，可带 `{hint,data}`）；**禁止**新写裸 `die()` 承载「需要特定码」的失败。
- `return EXIT_ERR` 型且需要显式码：`noteFail(code, msg)` 后再 return（不打印/不退出）。
- `die(msg)` 不带 code：按 §4 消息模式初分类（落 `E_INTERNAL` 时可接受；优先补关键词而不是逐点加 code）。
- 现役显式码点：`printLocateFailure`→`E_LOCATE` 及细分码 `E_NOT_FOUND`/`E_AMBIGUOUS`/`E_HIT_BLOCKED`（B1b 起带 `data` 定位诊断，B4 起带细分码/evidence）；`cmdWait` 超时→`E_TIMEOUT`（带 `data.found=false`）；`cmdFlow` 用法→`E_USAGE`；a11y 超时→`E_TIMEOUT`、a11y 降级→`E_CDP`、a11y/css/locator 定位失败→`E_LOCATE`；goto 超时→`E_TIMEOUT`、导航网络错误→`E_CONN`；screenshot 失败按 `kind` 映射；catch 按 kind。其余 return EXIT_ERR 点本批落 `E_INTERNAL`。

## 4. 分类映射（`lib/errors.js`）

`codeFor({kind, message})`：kind 权威（conn/http/timeout/cdp/disconnect/usage→对应码）；**例外**：kind=usage 时若消息命中更具体规则（如 `未找到匹配的页面 target`→E_NO_TARGET）取具体码。

`codeForMessage(msg)` 规则表（顺序即优先级，全部大小写不敏感）：

| # | code | 特征（正则摘要） |
|---|---|---|
| 1 | `E_BUSY` | 持锁/锁被占用/另一动作/正在运行/busy/locked by |
| 2 | `E_TIMEOUT` | 超时 / timed out（**不**裸匹配 `timeout`——大量用法文案含旗标名 `--timeout`） |
| 3 | `E_DISCONNECT` | 连接中断/已断开/WS 断开/socket hang up/ECONNRESET |
| 4 | `E_CONN` | 无法连接/连接失败/不可达/浏览器通道/CDP 通道/探活失败/ECONNREFUSED/ENETUNREACH/fetch failed |
| 5 | `E_CDP` | CDP 协议/协议错误/-32601/-32000/Unsupported method/Invalid parameters/evaluate 异常 |
| 6 | `E_NO_TARGET` | 未找到匹配的页面 target/无任何 page 类型标签/需要? --target |
| 7 | `E_IO` | 写盘失败/落盘失败/无法写入/磁盘/空间不足/ENOSPC/EACCES/EPERM/EISDIR/ENOENT/读取(/)解析失败/加载失败/文件不存在/不存在：/未找到录屏产物 |
| 8 | `E_USAGE` | 用法/需要/缺值/至少/二选一/仅支持/须为/不接受值/不可用/为空/无效/非法/至多一种/成对/只能/未发现任何/解析失败/校验失败/非 chromeuse- |
| 9 | `E_INTERNAL` | 以上皆不命中（兜底） |

顺序语义：IO/网络特征词先于宽泛的「用法/需要」——否则「读取/解析失败」会被 E_USAGE 抢走。新增文案若落 E_INTERNAL：先补关键词，再考虑显式 code。

## 5. golden 双套（selftest #96）

- **文本套（逐字节）**：离线命令的 `stdout+stderr+exit` 与冻结基线比对（短文案存原文、长帮助存 sha256）。覆盖面：die 路径（参数缺失/用法）、return EXIT_ERR 路径（flow/identify/popup-guard/events-summary）、`--help` 冒烟。失败路径基线取自**改造前**代码——保证「非 --json 输出逐字节不变」；`--help` 因本批有意新增 `--json` 通用说明，基线为改造后值（同批更新，CHANGELOG 记因）。
- **JSON 套（结构）**：`--json` 失败路径断言 `envelope.name==='chromeuse-cli/1'` + `ok===false` + `code∈码表` + `message:string` + stdout 单文档、`retryable` 布尔；不锁字段序、不锁 data。三出口各有代表用例（die=fake 前的 `click --json`；return EXIT_ERR=fake-CDP 定位失败；throw=fake-CDP resolveTarget 抛 cdp 错）。
- **B1b 扩展（#97/#98）**：12 命令成功信封结构（fake-CDP）+ 5 命令 data deep-equal 冻结期望 + 34 命令 E_USAGE 拒绝（exit 1/单文档/无副作用；B1b 时点 29，B3/B4/B7 后 34）。#96 ⑥ 随迁移改为「a11y --json 超时 = 单文档失败信封（E_TIMEOUT + data 报告）」。
- 成功路径不进 golden（B1b 用实弹抽查 + 结构断言承接）。
- 后续批触碰帮助文案/失败文案时：同批更新 #96 基线并在 CHANGELOG 记因（golden 限定本批触碰过的命令，不做全量快照）。
- **SUB_HELP / SKILL §1.2=构建双产物（C8a 产物① / C8b 接线产物②，2026-11-04）**：`tools/cdp.js` 的 `const SUB_HELP = {…}` 块与 SKILL §1.2 的 `####` 组段都由 `scripts/build-help.js` 从 `commands.meta.json`（唯一源）生成——SUB_HELP 模板=`用法：{usage} —— {summary}；{detail}`（detail 空时省 `；`）；§1.2 模板=`` - `{usage}` — {title||summary} ``（`title` 可选、仅供投影；summary 仍拼 SUB_HELP → 帮助面零漂移）。改命令=改 meta + `node scripts/build-help.js`（`--check` 检两产物漂移、只读；`--preview <file>` 额外预览 §1.2 组段）。生成物入库、部署仍=覆盖复制（live 无需 build）；`#95` 的 SUB_HELP 解析与 `#96` 消费端不变。
- **golden 重置流程（帮助面有意变更时）**：跑 build → `node selftest/main.js` 收集 #96 实测 `outLen/outSha` → 回填 GOLDEN 表 → 复跑全绿（数值来源=构建产物，禁手工推算）。C8a 实测**零漂移**（46/46 条值逐字节恒等；块内仅新增生成注记注释），故本轮基线未改。

## 6. audit 接缝 → 实装（B3 N3，V202611030004）

`tools/cdp.js` 的 `finalizeFailure` 恒调用 `envelope.auditFailure({cmd, code, msg, exitCode})`（--json 与否都记）。B3 起：

- **sink**：`envelope.setAuditSink((e) => audit.recordFailure({…}))` → `lib/audit.js` 写 `paths.AUDIT_DIR/yyyy-mm-dd.jsonl`（tmpdata/audit/，gitignored；按 `CHROMEUSE_TZ_OFFSET` 时区按天切分）。
- **成功路径**：进程 `exit` 0 单点 `finalizeSuccess()`（一次命令调用一行，覆盖全部子命令，含 audit/artifacts 自身）。B1b 的 `emitOk` 不再承担写盘，只登记 `phase`/`artifact` 上下文。
  - 设计偏离说明：任务书建议成功埋点放 `emitOk`（12 个 `--json` 命令）；验收要求「audit 命令自身也被审计」且审计应覆盖全命令，故上提到 exit 单点——写入次数不变（一次一行），覆盖面更大。
- **`CHROMEUSE_AUDIT_FILE` 处置（B1a findings 3）**：**保留为测试接缝**（#96 断言失败调用点用）；该 env 存在时正式审计**停写**（防 selftest 污染 tmpdata/audit），legacy 文件仍由 `envelope.auditFailure` 原样写 `{cmd,code,msg,exitCode}`。
- **字段白名单制**（第一道防线；第二层 redact 见 §16）见 §10；msg/DOM 文本/输入值/query 永不落盘。
- 审计是旁路：`lib/audit.js` 全部 IO try/catch 静默；调用方不得因审计失败改变退出码。

## 7. 交接点

- **B1b（已完成，见 §8）**：12 命令 `--json` 成功信封（`ok()`）+ `data` 定义 + 34 命令 `E_USAGE` 拒绝面（B1b 时点 29，后续批增至 34）；现役 5 命令 `printJson` → 信封迁移；`cmdJsonEmitted` 去重分支删除（单文档由「失败信封唯一发射点 + 进度走 stderr」保证）。
- **B3（已完成，见 §10/§11）**：audit 双出口 + 成功 exit 单点 + JSONL 按天切分 + tail/stats + 30 天 prune；artifacts report/prune/pin + 五入口 admit + config quota（schemaVersion 2）。
- **B4（已完成，见 §12）**：`E_NOT_FOUND`/`E_AMBIGUOUS`/`E_HIT_BLOCKED` 细分码 + `evidence` + 可交互性判读 + extract/assert 新命令。
- **B5**：`E_REF_STALE` 细分码 + `data.reason`（ref 解析）。
- **B6b（已完成，见 §16）**：redact 三同源（stdout 文本/信封、落盘、审计第二层）+ type 默认不回显 + net URL query 脱敏 + 占位符输入。
- **B8**：触发式（N10/N11/N12）与观察类；后续批增量继续在本文件追加小节。
- **B7**：`E_BUSY` 拒绝语义（C 案 + O_EXCL 槽位）；jobs/ 目录终态清理挂 quota 登记表（当前 jobs→other 永不删）。

## 8. B1b：`--json` 放行面与逐命令 data（V202611030002）

### 8.1 放行集 = 13（9 命令 ∪ 现役 5 命令，去重后 12 ∪ `handoff`）

`probe`｜`targets`｜`locator`｜`console`｜`a11y`｜`css`｜`click`｜`type`｜`goto`｜`screenshot`｜`flow`｜`wait`｜`handoff`

运行时准源=`tools/cdp.js` 顶部 `JSON_COMMANDS`（Set）；声明源=`commands.meta.json` 的 `jsonAllowed`（selftest #116 断言 meta / 本文件 §8.1 / `JSON_COMMANDS` 三方一致）。`main()` 在 `switch` **之前**统一拦截：`jsonMode && !JSON_COMMANDS.has(sub)` → `fail('E_USAGE', '该命令暂不支持 --json，见 --help')`——**不执行命令**、exit 1、stdout 仅失败信封（stderr 一行 `✗ …` 照旧）。未知子命令同点拦截，文案=`未知子命令：<sub>（见 --help）`（仍 E_USAGE）。

### 8.2 拒绝面 = 36（49−13，精确枚举；勿凭旧总数推算；B3 audit/artifacts、B4 extract/assert、B7 job、C9 grid、批C2 browser-up）

`exec`｜`net`｜`scroll-shot`｜`cast`｜`beacon`｜`watch`｜`click-at`｜`key`｜`hover`｜`viewport`｜`emulate`｜`dialog`｜`upload`｜`drag`｜`new`｜`close`｜`select`｜`eval`｜`popup-guard`｜`record`｜`record-stop`｜`diff-video`｜`evidence-pack`｜`browser-restart`｜`doctor`｜`doctor-forensics`｜`identify`｜`events-summary`｜`recorder-convert`｜`audit`｜`artifacts`｜`extract`｜`assert`｜`job`｜`grid`｜`browser-up`

> 9 命令卡 N1 名单原本含 `targets`/`a11y`，与现役 5 命令（targets/locator/console/a11y/css）去重后才是 12。计数口径：拒绝面 = SUB_HELP 命令总数 − `JSON_COMMANDS` 放行 13；当前 49−13=36（audit/artifacts/job/extract/assert/grid/browser-up 虽为后续能力批新增命令，也走拒绝面）。

### 8.3 逐命令 `data` 定义（`ok:true` 时；失败见 §8.4）

| 命令 | `data` 结构 |
|---|---|
| `probe` | `{url, ok, channels:{version|evaluate|screenshot:{ok,ms,detail,skipped?}}}`——三通道结论+耗时；`ok`=三通道全存活（内部页跳过截图项不算失效） |
| `targets` | 旧 `chromeuse-targets/1` 报告原样（`format/at/browserUrl/total/attachedCount/byType/targets[]`） |
| `locator` | 旧 locator 报告原样（probe/suggest/verify/pick 四模式各自的 `{mode,ok,page,spec,container,uniqueness,candidates…}`） |
| `console` | 旧 `chromeuse-console/1` 报告原样（`format/at/page/listenMs/enabled/deduped/counts/entries`） |
| `a11y` | 旧 `chromeuse-a11y/1` 报告原样（`format/nodeCount/truncated/timedOut/partial/depthMode/stages/nodes/target`）；B6a 新旗标只做 data 增量（`find/diff/out/cursor/frames/frameErrors/exclude/visibleOnly`，见 §15） |
| `css` | 旧 `chromeuse-css/1` 报告原样（`format/element/computed/computedCount/matched/errors/target`） |
| `click` | `{target:{id,url,title}, via:'point'|'locate', spec?, label?, element?:{tag,text,frame,cssPath,rect}, point:{x,y}, clickable?, scrolled?, double, clicks}` |
| `type` | `{target, into, append, cleared, value, active, focusEditable, clicked:{x,y}|null}`（`active`=发送后 activeElement 只读复核） |
| `goto` | `page.navigate` 结果对象 + `{target:{…}, redirected}`（`finalUrl/requestedUrl/readyState/loadEvent/committed/sameDocument/elapsedMs/polls`）；`--insecure` 时增 `insecure:true`（§17） |
| `screenshot` | `{target, out, bytes, format, quality, via, recoveredByBackoff, emulation}`；失败=`{…, data:chromeuse-screenshot-fail/1 矩阵}` |
| `flow` | `{ok, reportPath, summary:{action,file,steps,completed,dpr,video,popupGuard,insecure,warnings,…}}`（**回放失败 summary 追加** `stoppedAt/error/attempts/screenshot`；reportPath=失败报告文件）——非全量嵌套；回放 warnings 同时升至信封顶层 `warnings`（可选字段）；`insecure:true` 仅 `--insecure` 时出现（§17） |
| `wait` | `--text`：`{found, text, match, waitedMs, polls, matches, candidate:{tag,text,rect,frame}, target}`；`--expr`：`{found, expr, waitedMs, polls, value, target}`（§17） |

### 8.4 失败信封 `data`（报告型失败）

| 来源 | code | data |
|---|---|---|
| 5 命令迁移（targets 无失败报告除外） | locator suggest 未收窄/verify 无候选或高亮失败→`E_LOCATE`；pick 超时→`E_TIMEOUT`；a11y 超时→`E_TIMEOUT`、降级→`E_CDP`、定位失败→`E_LOCATE`；css 定位失败→`E_LOCATE` | 旧报告对象原样（deep-equal 契约） |
| `probe` ①失效 | `kind` 映射（`E_CONN`/`E_TIMEOUT`…） | `{url,ok:false,channels}` |
| `screenshot` 最终失败 | `kind` 映射（通常 `E_TIMEOUT`/`E_CDP`） | `chromeuse-screenshot-fail/1` 矩阵 |
| `goto` 超时/网络错误 | `E_TIMEOUT`/`E_CONN` | `page.navigate` 结果 + `target` |
| `wait` 超时 | `E_TIMEOUT` | `{found:false,text,match,waitedMs,polls,error}`；`--expr` 时 `{found:false,expr,waitedMs,polls,value,error}`（§17） |
| `click`/`type`/`hover`/`drag`/`upload` 定位失败 | `E_AMBIGUOUS`/`E_NOT_FOUND`/`E_HIT_BLOCKED`/`E_LOCATE`（§12.1） | `{reason,label,clickable,total,candidates[≤10]（含 disabled/readOnly/ariaDisabled/cursorNotAllowed/interactability）,point,viewport,scrolled,hitBlocked?}`；`E_HIT_BLOCKED` 另有顶层 `evidence` |
| `flow` 回放失败 | 步骤错误码含 TARGET/LOCATE/NOT_FOUND/AMBIGUOUS→`E_LOCATE`，否则 `E_INTERNAL` | `{ok:false,reportPath,summary{stoppedAt,error,attempts,screenshot,…}}` |
| 其余失败（无诊断对象） | 按 §2/§4 | `null` |

### 8.5 迁移与兼容（breaking）

- 现役 5 命令旧 `--json` 输出=多行 pretty JSON 报告；B1b 起=单行信封，**消费方改读 `.data.*`**（`targets.data.format` 等）。仓内无仓外消费方（2026-11-03 用户拍板直接迁移）；selftest #90③/#96⑥ 已同批更新。
- 非 `--json` 输出**逐字节不变**（#96 golden 文本套守门；本批触碰 click 帮助文案 → 基线同批更新）。
- 成功信封只在 `--json` 下发射；`warnings` 可选（目前 flow 摘要在 `data.summary.warnings`，信封级 warnings 预留给 B3）。
- 成功路径 audit 接线留 B3（`finalizeFailure` 接缝不动）。

## 9. B2：交互后生效判据 phase/expect（V202611030003）

**旗标**（click/type/key/drag/upload）：`--expect-text <文本>`｜`--expect-value <值>`｜`--expect-selector <css>`｜`--expect-count <css>=<n>`（**至多一种**，多给 E_USAGE）；`--effect-ms`（默认 30000，500~180000）；`--no-wait-effect`。**裸命令（无 `--expect-*`）不激活**：零新增 CDP 调用、文本逐字节不变、`--json` data 不含 phase/effect（`--effect-ms`/`--no-wait-effect` 单独出现=no-op）。

**判据**：text=页面可见文本出现（复用 `TEXT_EXISTS_V2_SRC` X2 两级漏斗+闸门）；selector=同源 docs walk 内命中数 ≥1；count=命中数 === n（css 以最后一个 `=` 分割）；value=交互主体元素（定位候选，缺省 `document.activeElement`）当前值精确相等（input/textarea/select 读 value；其余 innerText/textContent 去首尾空白）。跨域 iframe 不可见（同 wait 边界）。

**四态 phase（exit）**：`confirmed`(0)=窗口内判据成立｜`effect_pending`(0)=有可观察进展但未成立——**非成功非失败**，调用方必须继续观察（成功判据是 `phase==='confirmed'`，不是 exit 0）｜`dispatched`(0)=`--no-wait-effect` 送达即返（判据未评估）｜`stalled`(1)=窗口内零进展→报告型失败 `E_TIMEOUT`+`data.phase`+hint（screenshot/console/wait/doctor 取证；不设 exit 3——3 已被 identify 多命中共用且 main 的非 0 兜底会与「非失败」冲突）。

**进展**=判据信号（text 0 无/1 innerText 命中未过闸/2 过闸、selector|count 命中数、value 读回值）∨主体 X4 判态（`buildVerifyExpr`：pass-hit→gone/covered/blocked，每 3 次轮询采样控成本）∨页面 `元素数:文本长度:scrollHeight` 签名变化；纯 CSS 动画可能判 stalled（按 hint 截图复核，不假绿）。

**状态机**：实例=单次命令调用；内部 `settling`→四态；终态吸收（confirmed 不再轮询；stalled 不回 effect_pending——重跑=新实例）。`timeout` 是事件（`window_expired`），`stalled` 是其零进展分支（有进展=effect_pending）。转移矩阵全文 → `tmpdata/b2/state-machine.md`。

**节距护栏（M4）**：`EFFECT_POLL_MS=400`（同 flow-engine assert 轮询），`EFFECT_MS_MIN=500`——禁 <100ms 短封顶 / 50ms 快节距。

**信封落点**：click/type（`--json` 放行面）成功/中间态 `data.phase` + `data.effect{kind,expect,effectMs,polls,waitedMs,progress,firstProgressMs,observable,errors,lastError,lastValue,targetVerdict,matchedAtMs}`；stalled=失败信封 `ok:false,code:E_TIMEOUT,data{…,phase:'stalled'}`。key/drag/upload 不在 `--json` 放行面（仍 E_USAGE），phase 见 stdout/stderr 文本行。

## 10. B3：结构化审计日志 audit JSONL（V202611030004 N3）

**落盘**：`tmpdata/audit/yyyy-mm-dd.jsonl`（`paths.AUDIT_DIR`；日期按 `CHROMEUSE_TZ_OFFSET` 切分；gitignored）。一行一次命令调用（成功 1 行；失败 1 行，绝不重复——`failureEmitted`/`successAudited` 双去重）。

**埋点（两点 + 成功单点，复用 B1a 出口）**：失败=`finalizeFailure`（die 出口 + `main().then(code!==0)` + throw）→ `envelope.auditFailure` → `setAuditSink` → `audit.recordFailure`；成功=进程 `exit` 0 单点 `finalizeSuccess()`。目标 URL 由 `cdp-core.resolveTarget` 包装单点登记（命令内部几十处调用零改动）；产物路径在五落盘入口/flow 报告点登记；phase 由 `emitOk` 登记。

**字段白名单（恒 10 键；第一道防线，redact 第二层见 §16）**：

```json
{"ts":"ISO-8601+08:00","cmd":"type","targetHost":"example.com:8443","targetPath":"/login","action":"type","code":"E_CONN","phase":null,"elapsedMs":23,"artifact":"events/screenshot-x.png","sessionId":null}
```

- `targetHost`=URL host（含端口，不含凭据）；`targetPath`=**仅 pathname**（query/fragment 一律剥离，≤200 字符）；非 `http(s)/file/about/chrome` 协议（`data:`/`blob:`/`javascript:` 可能内嵌内容）→ host/path 均 null。
- **绝不写**：DOM 文本 / 输入值（`--text`/`--into-*` 等）/ URL query 原文 / Cookie / Token / 任意命令参数值。`msg` 也不落（信封 message 不进审计）。
- `action`=子动作（flow→`flow:replay`、audit→`audit:tail`、artifacts→`artifacts:prune`；缺省=命令名）；`artifact`=tmpdata 内相对路径（外部路径原样截 200）；`sessionId`=`CHROMEUSE_SESSION`/`CHROMEUSE_SESSION_ID`（双端区分用，缺省 null）。

**开关/查询**：`CHROMEUSE_AUDIT=0|false|off|no` 关闭（默认开）；`cdp.js audit tail [n=20]`（跨天按日期倒序收集、输出时间正序原样行）；`cdp.js audit stats [--days 7]`（按命令/结果码/日聚合）。**保留 30 天**：`artifacts prune` 同一入口按日期键删除（audit 类不参与配额淘汰）。审计命令自身也走成功单点审计。

## 11. B3：产物配额 / 保留期 / pin（V202611030005 N2）

**分类表（白名单路径制；新增目录必须同批登记，否则按「未登记=other 永不删」）**：

| 类别 | 保留期 | 配额淘汰序 | 登记目录（paths 单源） | admit |
|---|---|---|---|---|
| video | 3 天 | 1（第一淘汰） | tmpdata/video、tmpdata/cast | ✓ |
| screenshot | 7 天 | 2 | tmpdata/scroll-shot、events/screenshot-*、events/locator-*.png、a11y-baseline（预登记）、flow-checkpoints（预登记） | ✓ |
| download | 7 天 | 2 | tmpdata/downloads（预登记） | ✓ |
| log | 7 天 | 3（最后淘汰） | log/*.log（`.gitkeep` 等非 .log 归 other） | ✗ |
| record | 30 天 | —（不参与淘汰） | events/recording-*、events/locate-materials-* | ✓ |
| evidence | 30 天 | — | tmpdata/evidence、cdp-forensics、replay-verdict、videodiff、events/net-*、events/console-* | ✗ |
| fail-report | 30 天 | — | tmpdata/flow-fail | ✗ |
| audit | 30 天 | — | tmpdata/audit | ✗ |
| other | 永不自动删 | — | 未登记目录/散文件、test-runs/（用户补投材料，已拍板）、refs（预登记）、jobs（预登记；B7 实装终态清理）、locks | ✗ |

**report**：按类别列文件数/占用/最旧 + 按登记目录全覆盖（17 项，含 0 文件；`unregistered` 单列）→ 覆盖断言不掉项。体积口径=regular file `stat.size` 合计（不跟随符号链接）。`log` 目录恒为 `SKILL_ROOT/log`（不随 `CHROMEUSE_TMPDATA_DIR` 覆盖；tmpdata 覆盖只换 tmpdata 根）。

**prune**：①到期清理（所有有保留期类别；证据类只走到期）；②托管总量超配额时按固定序 video→screenshot/download→log 淘汰（类内最旧优先）；③**默认 dry-run**，`--apply` 才删；将删 >500 文件或 >1GB 时即使 `--apply` 仍须 `--yes`（E_USAGE 拒绝）；④pin 清单（`tmpdata/artifacts-pinned.json`，`artifacts pin <path>|--remove|--list`）永远豁免。other/locks 永不进入删除面。

**admit（落盘前配额检查，`lib/quota.js check()` 非抛错）**：五入口=scroll-shot 每段写盘、cast 每帧 + mp4 合成前、screenshot 写盘前、record 事件流/素材落盘前、record `-v` 预检。单产物 > `quota.maxArtifactMB`（默认 64MB）或总配额（默认 2048MB）不足 → `{ok:false,code:'E_QUOTA'}`（调用方按信封失败收口；不落半文件）。总配额只看 counted 类别（other/locks 不计）。超限时先算「到期可释放量」：默认**只告警放行**（`autoEvict=false`，首周观察）；不足 → E_QUOTA。`autoEvict=true` 才在准入时自动清理到期项。

**config（schemaVersion 1→2，迁移说明）**：两模板新增**共享节 `quota`**（总配额/单产物/保留期/autoEvict，双模板深度相等 selftest #8）；实例须同步 schemaVersion=2 并补 quota 段（#16 逐键校验）。旧实例（v1）升级 = 合并模板 quota 段 + schemaVersion 改 2，无行为破坏（默认值与旧无治理行为兼容，prune 首周只 report）。

## 12. B4：命中诊断 / extract / assert（V20261104003 #103~105）

### 12.1 定位细分码（R2 #103）

判定单源：`tools/cdp.js locateFailureCode()`（纯函数）→ `printLocateFailure()` 统一出口。click/type/hover/drag/upload 的 locate 失败全部接入。

| code | 判据（res.reason / candidates） |
|---|---|
| `E_AMBIGUOUS` | `reason=ambiguous`（可点候选 >1 且未给 `--nth`） |
| `E_NOT_FOUND` | `reason=no-clickable` 且候选 0 个；`container-not-found`（容器锚点零命中） |
| `E_HIT_BLOCKED` | `reason=no-clickable` 且存在 `visible=true && hitOk=false` 的候选（X1 L4 `elementFromPoint` 未命中=被遮挡） |
| `E_LOCATE` | 其余定位链失败（`out-of-viewport`/`nth-out-of-range`/`bad-selector`/收集失败等） |

- `data.reason` 保持驱动判定的原始 reason；`data.candidates[]` 追加 `disabled/readOnly/ariaDisabled/cursorNotAllowed/interactability`（**只诊断，不改 `isClickable` 判定**）。
- 旧消费方仍可按 `E_LOCATE` 兜底（细分码是补充，不是替换所有定位失败）。

### 12.2 `E_HIT_BLOCKED` evidence 契约

失败信封**顶层** `evidence`（B1a 预留字段启用）与 `data.hitBlocked` 同对象双通道：

```json
{
  "kind": "hit-blocked",
  "point": { "x": 90, "y": 40 },
  "viewport": { "w": 1705, "h": 664 },
  "target": { "tag": "button", "id": "btn", "cls": "", "rect": {"x":20,"y":20,"w":140,"h":40}, "zIndex": "auto", "position": "absolute", "pointerEvents": "auto" },
  "hit": { "tag": "div", "id": "mask", "cls": "", "rect": {"x":0,"y":0,"w":1705,"h":664}, "zIndex": "9999", "position": "fixed", "pointerEvents": "auto" },
  "ancestors": [{ "tag": "body", "id": "", "cls": "", "rect": {"x":8,"y":8,"w":1689,"h":648}, "zIndex": "auto", "position": "static", "pointerEvents": "auto" }],
  "inFixedLayer": true
}
```

- 采集：`lib/locator.collectHitBlockedEvidence()` 在候选中心点复测 `elementFromPoint`（只读 evaluate）；`ancestors`=候选至多 3 层；`inFixedLayer`=遮挡元素上溯 ≤15 层遇 `fixed/sticky`。
- 失败 fail-soft：`data.hitBlocked={ok:false,error}`，**不改变** `E_HIT_BLOCKED` 判定（hitOk=false 已由 X1 收集阶段得出）。
- `hint` 恒定三条可行动下一步：① `click-at` 坐标兜底（`evidence.point`）② `locator probe/suggest` 收窄 ③ 先关弹窗/遮罩（`inFixedLayer`/`zIndex` 已给）。

### 12.3 可交互性判读（disabled 族）

- 页面侧 `interactState()` 采集 `disabled`（property 或 disabled 属性）/`readOnly`/`ariaDisabled`（aria-disabled="true"）/`cursorNotAllowed`（computed cursor）；`collectCandidates()` 逐候选附 `interactability` 一句话判读（例：「控件被禁用/只读（disabled=true）——非定位失败：先解除禁用/只读或换取可用控件，再重试」），`rep.blocked` 计命中数。
- 边界：**判读不参与 `isClickable`**——自定义组件可能 `aria-disabled` 但仍可点；点击行为仍只由 X1 闸门决定（回归零影响）。禁用元素「点了没反应」由调用方按判读先行处理（本批不改点击语义）。

### 12.4 extract（N8 #104）

- 六 kind：`text`（省略 `--selector` 默认 `document.body` 全文）/`table`（首行表头映射对象数组，重复列名 `#2`）/`attr`（须 `--attr <name>`）/`links`（按绝对 href 去重）/`json`（JSON-LD + 内嵌 `application/json`，数组展开一层，解析失败计 `errors`）/`grid`（虚拟化网格只读读数，见 §12.7；`--col`/`--row` 成对读指定单元格）。
- 结果形状 `{kind,selector,count,items,truncated,errors?}`：`count`=截断前总数，`items`=前 `--limit` 项（1~5000，默认 100），`truncated`=count>limit。
- 页面侧只读：零合成事件/零导航/零文件注入/零页面写；跨同源 iframe 与 locator 同口径（`contentDocument`）。
- 输出：文本紧凑行（`[extract]` 头 + 项行）；本命令不接 `--json`（E_USAGE 拒绝面，§8.2）。

### 12.5 assert（N9 #105）

- 断言族：`--count <css>=<n>`｜`--text <文本>`｜`--attr <css>@<name>=<value>`｜`--url <pattern>`｜`--no-console-error`；可重复（重复旗标收集在 CLI 层 `collectRepeated`）。
- 输出逐项 `{kind,expected,actual,passed}`（文本行）+ 汇总行；**默认失败不中断（exit 0）输出完整明细**；`--fail-fast` 首个失败即中止并 exit 1。
- 判定单源/边界：
  - text/count：直接复用 `lib/expect.js buildProbeExpr`（X2 `TEXT_EXISTS_V2_SRC` 两级漏斗 + 同源 docs walk 计数）；
  - attr：expect.js 未覆盖的判据，按同一 docs walk 模式补只读表达式（不复制 X2 漏斗）；
  - url：只读读 `location.href`，模式支持 `/re/flags` 与裸正则；
  - no-console-error：复用 `drive.captureConsole({listenMs:0})` 读**已有** console 历史，过滤 `kind=exception` 或 `level=error`（Chrome 153 实测 Runtime.enable 回放；88 未验证，note 如实标注）。
- `--url` 语义=URL 正则，**不是 browserUrl**（本命令下浏览器地址只走 config；避免 `about:blank/json/version` 误连）。
- flow 兼容性：flow replay 的 `assert` 步骤（text/cond/anyOf 语义）与 `--post-verify`（X4 `buildVerifyExpr`）保持原实现，不被本命令替换/改写；三者共享底层表达式源（TEXT_EXISTS_V2_SRC/buildVerifyExpr）而非同一 CLI 路径，互不影响。

### 12.6 回归与验收锚点

- 正常 click/type/hover 路径零变化（仅新增诊断字段与失败码细分）；selftest #103~105 守门。
- 实弹夹具（2026-11-04 隔离 about:blank 页签）：透明 fixed 遮罩 → `E_HIT_BLOCKED`（hit=#mask z=9999 inFixedLayer=true）；`disabled select` → `disabled=true` + 判读；`aria-disabled`/`cursor:not-allowed` 同判读；正常按钮 click 仍成功。

### 12.7 虚拟化网格（C9：`extract --kind grid` / `grid locate|scroll-to`）

- 识别：`.react-grid-*`（v6）/`.rdg-*`（v7）双代际；命中列头或行元素即认；渲染行数远小于 totalRows 时附「行虚拟化」告警（离屏未渲染≠空值）。
- 列头视觉序：`getBoundingClientRect().left` 升序（横向滚动下 DOM 序≠视觉序）；**`--col` 文字映射到 data 索引（`aria-colindex`/DOM 序），禁止把视觉序号当列索引**。
- `extract --kind grid` 只读：不滚动/零合成事件/零导航；输出 `generation/headers/visibleHeaders/visibleRows/totalRows/cell`；未渲染单元格输出「离屏未渲染≠空值」并指向 `grid locate/scroll-to`。
- `grid locate --col … --row …`：有副作用（滚动+派发一次原生 `scroll` 通知令 RDG 重算虚拟列——POC F2：程序化 scrollLeft 不触发列虚拟化）；轮询复读至可见（默认 10s 超时）；**默认还原 scroll（`--keep-scroll` 保留现场）**。
- `grid scroll-to --row … [--col …]`：只滚动并保留现场（`--restore-scroll` 还原），供随后 `extract --kind grid` 复读；行列判定同 locate。
- 行列索引：v7 优先 `aria-rowindex`−headerRows；v6 几何 `offsetTop/rowHeight`；totalRows=`aria-rowcount`−headerRows 或 `scrollHeight/rowHeight`。
- 失败：零命中/超时=`E_NOT_FOUND`，hint 含「离屏未渲染≠空值」（列头未命中同含）；contains 歧义=`E_AMBIGUOUS` 不猜；非 `--json` 命令（§8.2）。
- fixture：`selftest/fixtures/grid/`（v6 600px 窄容器 1000×20 + iframe 坐标链 + vendor sha256 + 随机端口 serve.js）。

### 12.8 JS click 监听可交互候选（C11 N12：`locator probe --js-listeners|--cursor-pointer` / `a11y --mark-js`）

- 扫描：`DOMDebugger.getEventListeners{documentElement, depth:-1, pierce:true}` 只读列直接 click 监听节点（Chrome 153 实测零 Debugger/Runtime 前提；POC=`tmpdata/n12-poc/report.md`）；`listener.backendNodeId` 与 `AXNode.backendDOMNodeId` 同域直接 join。
- 边界：只覆盖**直接监听**（React 17+ 根容器委托元素级不可见→`--cursor-pointer` 兜底）；handler 源码不可得；objectId 会话级，**单命令单连接**闭环（evaluate→getEventListeners→releaseObject），禁拆命令。
- 定位并入：`--js-listeners` 候选 `source=js-listener`（与 spec 同元素合并为 `spec+js-listener`）；`--cursor-pointer` 走 getComputedStyle cursor 兜底（可组合，`source=cursor-pointer`）；`--mark-js` 仅对无 role/name 的 AX 行加 `[J]`（不改节点数/行序）。
- 默认关：不带旗标零额外 CDP 调用、输出逐字节不变；`isClickable`/X1 判定零改动（新旗标只扩候选/标注）。
- 能力闸：协议拒绝按 error.code（-32601/-32000）降级 `supported:false` + 明确告警，不崩不静默（Chrome 88 分叉）。

## 13. B5：a11y 引用句柄 `@eN` / 三级定位链 / 失效契约（V202611030006 N4）

把一次快照里看见的可交互节点固化成稳定句柄，`click/type/hover --ref @e3` 直接消费（不再抄 cssPath、不为多候选盲试 `--nth`）。准源 `lib/refs.js`（物化/解析）＋ `perceive.js`（行前缀）＋ `tools/cdp.js`（产表与消费）。

### 13.1 物化（`a11y --ref`）

- **候选面**：`clickable`（AX 交互角色）或 `focusable`、且**已取得 rect**（`applyBounds` 前 150 个有 `backendDOMNodeId` 的行）、非文档根（`RootWebArea/WebArea/document/Iframe` 排除）；按行序去重；`--max-refs` 默认 50（上限 500）。
- **往返预算（v2 裁决案）**：**1× `DOM.getDocument({depth:-1,pierce:true})`**（Node 侧按 parentId 链算 cssPath/container，语义对齐 `locator.cssPathOf`：唯一 id 优先，否则 `tag.首class:nth-of-type`）＋ **1× 页侧 `Runtime.evaluate` 批量核验**（选择器计数/矩形+frame 偏移/可见性/命中闸门/name 源/身份标记）。整表恒定 2 次往返，**零逐节点 `DOM.resolveNode`+`callFunctionOn`**（原方案 100 ref≈200 往返）。⚠ 有意偏离 plan 字面「一次 callFunctionOn」：callFunctionOn 需先取 document objectId 再 releaseObject（句柄泄漏面更大），两者同为 1 次页侧批量调用。
- **表**：`tmpdata/refs/<targetId>.json`（`chromeuse-refs/1`；一次快照=一代，整表覆盖不合并）。每 ref `{ref,n,role,name,backendDOMNodeId,cssPath,container,framePath,rect,identitySet,visible,hitOk,nameSource}`＋顶层 `generation:{loaderId,url}`；页侧核验不唯一/不命中 → `cssPath=null`＋`cssPathDropped` 原因（退二级），`DOM.getDocument` 失败同理记 `stats.domError`。
- **输出**：文本行前缀 `@eN`（行序稳定）；`--json` 在旧报告 `data` 上补 `data.refs/refTable/refStats`（不新增放行命令）；`--locator` 追加可持久化定位器 `{kind:'role-name',role,name,cssPath,container,frame,backendNodeId}`。**无 `--ref` 输出逐字节不变**。

### 13.2 身份与失效契约（不猜、不点错）
- **身份锚**：物化时给元素打 JS 层不可枚举扩展属性 `__cu_ref='eN'`（`Object.defineProperty`；不改 DOM 属性/结构/样式，不触发 MutationObserver/重排；元素被替换即天然丢失）。本能力唯一页面侧写，与 `locator pick` 注入一次性监听同级。
- **代际闸门**：消费时比对 `targetId` ＋ 主帧 `loaderId`（`Page.getFrameTree`）——导航/刷新即失效（同文档 hash 导航不变）。
- **判定表**：
| 情形 | 码 | reason |
|---|---|---|
| 表不存在 / 序号不在表内 / 表属另一 target | `E_REF_STALE` | `no-table` / `not-in-table` / `target-changed` |
| loaderId 变（导航、刷新） | `E_REF_STALE` | `navigation` |
| 一级唯一命中但身份标记不符（DOM 替换/重渲染） | `E_REF_STALE` | `identity-mismatch` |
| 三级链全落空（移除/detached）/ frame 链消失 | `E_REF_STALE` | `not-found` / `frame-missing` |
| 某级命中 >1 且无法唯一裁决 | `E_AMBIGUOUS` | `ambiguous`（附候选清单） |
| 命中但不可见 / 命中被挡 / 视口外（滚动一次后仍在） | `E_LOCATE` | `css-hidden` / `hit-miss` / `out-of-viewport` |

- **重解析有界=最多一次**：视口外先 `scrollIntoView` 再算一次（第二次求值带 `scroll:true`），仍在外即 `E_LOCATE`；不重拍快照、不循环。失败信封 `data={ref,reason,level,count,candidates,refTable}`，文本模式打印可行动指引＋候选清单。

### 13.3 三级定位链（顺序钉死）
1. **cssPath**（`framePath` 内；全树 @eN=主文档）：`querySelectorAll` 恰 1 → 身份标记相符即点（`verified:true`）；不符=元素被替换=失效（**不**降级去点同名新元素）。
2. **role+name**：AX role → DOM 映射表 `ROLE_DOM_SELECTORS`（button/link/textbox/searchbox/checkbox/radio/combobox/listbox/option/heading/tab/menuitem/slider/spinbutton/img…；**不复用** `locator.roleOf` 的 DOM→角色粗反推）＋ name 三源 `aria-label→alt→textContent`（空白归一后精确相等）；可见匹配恰 1 → 点（`level:'role-name'`，仍带本 ref 标记则 `verified:true`），name 为空不跑二级（防空名匹配全部）。
3. **container 收窄**：最近结构祖先 cssPath（`CONTAINER_STRUCT_SEL` 同源，≤12 层）内重跑第 2 级（`level:'container'`）；每级各跑一遍、`>1` 一律 `E_AMBIGUOUS`。

### 13.4 v1 边界与验收锚点
- 全树 `@eN` **只覆盖主文档**（`getFullAXTree` 不并含子帧节点，B0 POC 已证）；同源 iframe 用 `a11y --text/--selector --ref` 的 partial 树产 ref（带 `framePath`，按标签链下钻）；跨域/OOPIF 不穿透；跨 frame cssPath 是所属文档内路径。
- 离线 selftest #106（物化纯函数/映射表/单次批量/fake-CDP 全链）、#107（契约矩阵＋CLI 接线＋默认输出逐字节）；实弹 `tmpdata/b5/fixture/index.html`（双 iframe＋aria-label＋重渲染/破坏路径/复制按钮三场景）。

### 13.5 视觉标注 `screenshot --annotate`（C5 N11，V20261104003）

- **同源**：标注前现场物化 ref 表（`perceive.runA11y` + `refs.materializeRefs`，与 `a11y --ref` 完全同构、同编号源 `assignRefNumbers`，落 `tmpdata/refs/<targetId>.json`）→ 图上红框+黄底 `eN`。物化预算 10s（独立于 `--timeout` 的截图语义）；超时/失败/a11y 降级 → 明确报错，不静默降级。
- **叠字通道**：纯 Node zlib PNG codec + 内置 5x7 点阵字模（e+0-9；`lib/annotate.js`）。ffmpeg drawtext 不可用（7.0.2-static 无该 filter + 容器零字体）→ 零依赖零字体自绘（decode 2558×996 ≈147ms / encode filter0+level6 ≈134ms）。
- **零页面副作用**：不注入 overlay、不改 DOM、不滚动；真实点击仍走 `click --ref` 的 X1 闸门与三级定位链（标注只是视觉辅助）。
- **坐标**：`localRect`（视口相对）优先，缺失用 `rect`（页面绝对）−滚动量；物化→截图间滚动按 scroll 差修正并如实标注 drift；`--dpr/--viewport` 由标注分支自管 Emulation（覆盖生效期内取坐标，finally 还原）；物化后导航/刷新（loaderId 变）→ 明确中止不静默出错图。
- **边界**：仅 `--format png`；视口外 ref 不画但如实进 `skipped`（refs 总数=total）；`--annotate` 关闭时分支零参与（截图字节不变，验收硬线=golden 比对）。

## 14. B7：长任务作业模型 `--async` + `job`（V20261104002 N6）

**触发面**：`cast`｜`scroll-shot`｜`record`｜`flow replay` 四命令加 `--async` 即作业化。语义：

- 主进程只做「占槽 → 写状态 → `spawn` 子进程 → 立即返回」，**秒级退出**；子进程独立进程组（`detached:true`）继续跑，输出重定向到 `tmpdata/jobs/<jobId>.log`。
- 成功 stdout **一行**：`[job] jobId=<id> status=running stateFile=<path>`；`--json` 与 `--async` 互斥（**E_USAGE 拒绝**，编排方裁决不扩放行面）；四命令一律**要求显式 `--target`**（异步无人监督，禁止隐式操作用户当前页/自建页签，与页签礼仪同源）。
- 转发子进程 argv **剔除 `--async` 自身**（含 `--async=<v>` 与 parseArgs 会吞掉的裸值），防递归作业化；另附隐藏 `--job-id <id>` 供孤儿三元组校验（命令侧忽略未知旗标）。

### 14.1 并发：C 案（满则拒绝，不排队）

**并发上限**默认 **4**（`CHROMEUSE_JOB_MAX` 覆盖，合法域 1~32；非法值回退 4）。并发满时 **exit 1 + `E_BUSY`**（20 码表内，retryable=true），message 含 `running N/N / 上限 N / 重试建议`——**不排队、无 queued 死状态**；调用方（agent）自重试语义等价排队。`--wait <ms>` 可选：E_BUSY 时阻塞轮询至超时再试一次（超时仍满则 E_BUSY）。

**槽位原子性（消灭 TOCTOU）**：`tmpdata/jobs/slots/slot-1..N` 用 `fs.openSync(slotPath,'wx')`（`O_CREAT|O_EXCL`，内核级原子）占用；✅ 抢到，`EEXIST` 顺延下一槽，全满=E_BUSY。**禁止** `existsSync`→`writeFile` 两步式（opencode/openclaw 双端并发是本仓真实场景）。槽文件内容 `{jobId,pid,createdAt}`；释放=按 jobId 内容匹配才删（防误删他人刚抢到的槽）。selftest #112 含真实并发 5 抢 2 槽断言。

### 14.2 状态文件与状态机

`tmpdata/jobs/<jobId>.json`（jobId=`job-<stamp>-<8hex>`；tmp+rename 原子换名，观测面最后写者胜）：

```json
{"jobId":"job-…","pid":123,"startedAt":"2026-11-04T…","cmdline":["scroll-shot","--target","…"],
 "status":"running|done|failed|cancelled","progress":{"phase":"slice","current":3,"total":10,"updatedAt":"…"},
 "artifact":"tmpdata/scroll-shot/x-03.jpg","exitCode":null,"stateFile":"…","logFile":"…","slot":1,"note":null}
```

- 状态机：`running → done`（子进程 exit 0）｜`failed`（exit≠0/孤儿）｜`cancelled`（cancel 请求后退出）。子进程 `lib/jobs.attachChild()` 在 `exit` 事件同步落终态并释放槽位（exit 事件只做同步 fs）。
- **progress**：scroll-shot 逐段（`slice` current/total + artifact=本段图）、cast 逐帧（`frames`）、flow 逐步（`step`）、record 启动（`record`）；`jobs.progress()` 非作业进程恒 no-op。
- **artifact**：scroll-shot=清单 JSON（段图在清单内引用）；cast=清单/ mp4；record=事件流；flow=失败报告/reportPath（成功无独立路径时留空）。cancel 后 artifact 与已完成文件**原样保留**（partial 语义）。

### 14.3 孤儿判定（`{pid,startedAt,cmdline}` 三元组）

`job list/status/cancel` 与 `--async` 启动时惰性 `sweep()`：对 `status=running` 状态逐条探针：

1. `process.kill(pid,0)` 判活（`EPERM`=活；Linux 僵尸态 `Z` 视为死——未收割的 `kill -9` 子进程不得误判）；
2. `/proc/<pid>/cmdline` 校验含本作业 `jobId`（防 pid 复用；非 Linux/不可读=null 不据此判）；
3. `/proc/<pid>` 启动时刻与 `startedAt` 偏差 ≤120s（防 pid 复用；不可读=null 不据此判）。

任一判死 → 状态改 `failed` + `orphanReason`（`pid-dead`/`pid-reused-cmdline`/`pid-reused-startedAt`）+ note，**不自动删产物**；槽位回收。终态状态文件保留 **600s** 后惰性清理（含日志），挂在 job 命令与 async 启动时。jobs 目录在 quota 分类表预登记为 other（永不自动删；600s 清理由本模块负责）。

### 14.4 cancel 双路（信号 + partial）

1. 先写 `cancelRequestedAt`（子进程退出钩子据此把终态记为 `cancelled` 而非 `failed`）；
2. **第一路**：`record` 作业优先 `POST http://127.0.0.1:<record-state.port>/__stop`（读 `tmpdata/events/.record-state.json`，**pid 必须匹配**才发；目标不支持则跳过）；
3. **第二路（统一兜底）**：`process.kill(-pid,'SIGTERM')` 整进程组（spawn `detached:true`；Windows 无负 pid 回落单 pid）→ 3s 未退 `SIGKILL` → 2s 复核；
4. 终态合并写 `status=cancelled` + `cancelSignal` 链路 + note；按 jobId 释放槽位；**已完成产物保留**（scroll-shot 已完成段图、cast 已收帧、record 已落事件流均不删）。

### 14.5 命令面与退出码

| 命令 | 行为 | 退出码 |
|---|---|---|
| `cdp.js job list` | 活动+终态作业（running/上限、id/status/pid/startedAt/进度/cmdline） | 0 |
| `cdp.js job status <id>` | 单作业全字段（支持唯一前缀，多前缀不猜）；终态含 exitCode/artifact/note | 0（作业失败也 0——查询本身成功）；找不到/歧义 E_USAGE |
| `cdp.js job cancel <id>` | 双路取消；已终态幂等提示 | 0；找不到 E_USAGE |
| `--async` 启动 | 占槽成功=一行 jobId/status/stateFile | 0；E_BUSY/E_USAGE=1 |

**审计**：`--async` 启动成功走 exit 0 单点一行（cmd=子命令名）；E_BUSY/E_USAGE 失败走 `finalizeFailure`（audit 恒触达，code 进审计）；子进程各自作为独立命令调用被审计（父进程不重复记）。

## 15. B6a：a11y 快照分级 `--find/--diff/--out/--cursor` + 降噪三件（V20261104002 N5）

把「每次全量文本」拆成可组合视图；**默认不带新旗标时输出逐字节不变**（selftest #96 golden + #109 默认组）。实现单源=`lib/perceive.js`（CDP/帧/降噪）+ `lib/snapshot-diff.js`（身份键/检索/游标/基线 IO）；新旗标只进 `a11y --json` 的 `data`，不放行新命令。组合顺序：**取树 → 降噪（frames/exclude/visible）→ bounds → diff → find → cursor → out**。

### 15.1 四模式

| 旗标 | 语义 | 输出/边界 |
|------|------|-----------|
| `--find <文本>` / `--find /regex/flags` | DFS 树内检索 role/name/value/description；正则 flags 仅 `i/m/s/u`（禁有状态 g/y） | 每命中：命中行 + 根到节点路径 + ±2 行上下文；文本叶子（StaticText/InlineTextBox）若祖先已命中则去重——「找一个元素」= 单命中（万节点实测 <2KB） |
| `--diff` | 身份键增量（**不用 nodeId**：跨快照不稳定） | 新增/变化行前缀 `*`；只输出变化行；`data.diff.stats`；`forcedFull:true` 时全量输出且不加 `*` |
| `--out <file>` | 全量快照落盘（`chromeuse-a11y-snapshot/1`） | **stdout 只回 `{nodes,file,snapshotId}`**（文本/JSON 同契约；节点数组不进上下文）；与 `--cursor`/`--ref` 互斥 |
| `--cursor` | 分页视图：rows / diff 变化行 / find 命中 | `--cursor-size` 默认 200（1~5000）；首页写基线，`--cursor-token` 续页**零 CDP**读基线视图；token=`c1.<base64url({s,o,v})>`，snapshotId/视图哈希不符即拒绝（不跨快照拼页）；可与 `--find/--diff` 组合（续页只校验视图哈希），与 `--out` 互斥 |

### 15.2 diff 身份键与不可比回落

- 身份键：① `backendDOMNodeId`（同一 target+loaderId 内；B0 实测跨同进程帧无碰撞但协议未承诺）→ ② 结构路径 `framePath+role+name+同组出现序号` 兜底。匹配 bKey 优先、sKey 兜底；同键但签名（role/name/value/description/focusable/clickable/disabled）变 → `changed`。**bounds 不进签名**（滚动/布局微移不是语义变化）。
- `forcedFull:true`（全量、不标 `*`）任一成立：无基线 / 读不出基线 / 主帧 loaderId 变（导航刷新）/ 取不到代际 / target 变 / 口径变（depth·maxNodes·exclude·frames·visibleOnly·query）。跨页绝不给假 diff。
- 基线/当前快照 `truncated|partial` → 仍 diff 但 `degraded:true`（可能漏报新增，不制造假新增）。
- 基线：`tmpdata/a11y-baseline/<targetId>.json`（`chromeuse-a11y-baseline/1`，quota 预登记 7 天类；一次快照=一代，整文件原子覆盖）。保存全量行+本次视图；`--cursor-token` 续页只读它。

### 15.3 降噪三件

- `--exclude <css>`：`DOM.getDocument({depth:-1,pierce:true})` 一次 → 每个文档根（含同进程 iframe contentDocument）`DOM.querySelectorAll` → `DOM.describeNode` 取 backendNodeId → 按 DOM 祖先链判行归属；排除行连同更深后代（含无 bId 的文本叶子）按行深度剪枝。选择器非法= E_USAGE；匹配 0 不算错；上限 500 元素如实标 truncated。
- `--frames same-origin`（B0 POC 定案路径）：`Page.getFrameTree` 递归枚举同进程帧 → 逐帧 `Accessibility.getFullAXTree({frameId})`（全量时省略 depth；`--depth` 按帧预算）→ `DOM.getFrameOwner` 取父树 Iframe 行 backendNodeId 挂接 + `framePath` 标注；子帧 RootWebArea 折叠。**单帧失败只进 `data.frameErrors[]`**，不影响主树/其他帧。OOPIF 不在范围内（独立 target，帧树不可见）。
- **Chrome 88 分叉**：frameId 参数约 92~94 才引入；88 忽略额外参数返回主帧树。判据（`classifyFrameTreeResponse`）：响应 root 的 `frameId` ≠ 请求，或节点集合与主树全等 → 忽略。命中即 `framesUnsupported:true` + `approximate:true`，**如实报不支持**（不做页侧 contentDocument 投影假合并），主树仍 exit 0。
- `--visible-only`（默认关）：仅主文档、有 bounds 的前 150 行；`DOM.getNodeForLocation` 中心点最上层节点须为自身/祖先/后代，否则判遮挡（连同后代剪枝）。视口外/子帧跳过并计数（`data.visibleOnly`）；读不到命中 fail-open 保留行。`--frames` 合并时子帧行不做遮挡判定（坐标语义边界）。

### 15.4 阈值标定（2026-11-04 实测；验收基线=diff 行数 < 全量 20%）

| 页面 | 节点数 | 首次全量行 | 连续两次 diff 行 | 比例 |
|------|--------|-----------|------------------|------|
| 自建 bigframes（3 同源帧，10525 节点） | 10525 | 10527 | 2 | 0.019% |
| 内网 gitea 首页 | 112 | 114 | 2 | 1.75% |
| 内网 gitea /explore/repos | 156 | 158 | 2 | 1.27% |

页面导航后 `--diff` 实测 `forcedFull:true`（reason=navigation）；内容稳定页二次 diff 仅 2 行表头/统计。单帧 >4000 AX 节点时 chrome-browser 通道会断开（环境响应体积上限，实测 6000/8000/10000 同现象）——万节点用多同源帧合并验证。

### 15.5 验收锚点

离线 selftest #108（模式解析/身份键/forcedFull/88 判据/游标/基线/帧挂接/万节点 find<2KB）、#109（fake-CDP 四模式全链 + frameErrors/88 降级 + CLI 面 + 默认 golden）；实弹 fixture 与标定数据见 `tmpdata/b6a/`。

## 16. B6b：输出脱敏 redact（V20261104004 N7；schemaVersion 3）

**单源**：`lib/redact.js`（纯函数 + 进程级规则集）。**默认开**；`--no-redact` 显式关（全局旗标），关闭时审计追加一行 `action=redact.disabled`（每次调用恰一行；换个说法：审计自身也留「本次未脱敏」证据）。

**三同源接点（全部在持久化之前）**：

| 出口 | 接点 | 实现 |
|---|---|---|
| stdout/stderr 文本 | `tools/cdp.js` 的 `console.log/console.error` 包装 | 逐字符串 `redact.text()`（`--json` 进度行在 stderr 同样覆盖） |
| `--json` 信封 | `emitEnvelope()`（`envelope.emit` 前） | `redact.deep()` 深拷贝逐 string 过滤（成功 `emitOk` + 失败 `finalizeFailure`） |
| 落盘 JSON/文本 | `tools/cdp.js` 包装 `fs.writeFileSync` | 写前 `redact.text()`；Buffer（截图/帧）原样。覆盖 cdp.js 与同进程 lib/* 的报告/证据/事件流/作业状态写盘 |
| 审计 JSONL | `lib/audit.js record()` | 字段白名单之后 `redact.deep()` 第二层（白名单+redact 双防线） |

**三层配置**（`config.jsonc redact` 段，模板 schemaVersion 3 新增）：`secretsFile`（KEY=VALUE 每行一个的**本机**路径；凭据禁入 skill=红线 #8；不可读/不存在 → fail-soft 告警并跳过；`CHROMEUSE_REDACT_SECRETS_FILE` 可覆盖=部署/测试接缝）、`urlParams`（默认 `access_token,code,token,key,sign,sessionid,password`；大小写不敏感）、`patterns`（字符串正则数组，`/re/flags` 或裸源；非法正则 fail-soft 跳过）。内置模式恒生效：`Authorization`/`Cookie`（含 JSON 序列化形态 `"Authorization":"…"`）、裸 `Bearer/Basic`、JSON 敏感键（`access_token/password/secret/api_key…`）；URL 内嵌 `user:pass@` 记 `<redacted:credentials>`。命中替换 `<redacted:NAME>`（幂等：已替换值不二次包）。

**type 行为变更（breaking，原默认打印输入值=泄漏路径）**：默认只打字符数（`输入 12 字符`），`--echo-text` 才回显（回显仍过 redact）；`--json` data 同规则——`value=null + valueChars=长度 + valueEcho`，`--echo-text` 时 `value=脱敏后原文`；`active.value` 同规则（默认 null + `active.valueChars`）。`--text "%KEY%"` 占位符：真值从 secretsFile（优先）或同名环境变量解析，只进 `Input.insertText`，stdout/JSON 只出现 `<placeholder:KEY>`；未命中按字面量输入并告警。

**边界**：独立子进程（`tools/recorder.js` 录制等）不继承 cdp.js 的包装；`record --full-input` 等原生录制内容不在本层改写（消费侧仍应视作敏感）。`--no-redact` 状态不跨进程。

## 17. `--insecure` 连接级证书忽略 / `wait --expr`（V20261112001 三缺口批）

**面**：`goto`/`new`/`exec`/`flow replay` 四命令窄集——单命令连接窗口内只有「导航」触发证书校验（截图/读数对已加载页零校验；interstitial 上读不出内容，正确姿势=先 `goto --insecure` 重新导航）。不支持命令带旗标=**静默忽略**（parseArgs 不校验未知旗标；测试钉死零 `Security.*` 调用）。

**挂点**：`openClient(flags, defaultTimeout, {insecure})` 连接建立后 browser-level（无 sessionId）发 `Security.setIgnoreCertificateErrors{ignore:true}` 再执行主操作；flow 在 `runFlow` connect 后同行发送（长连接整场覆盖=自签 SPA 的 WS/持续子资源正确挂点）。Chrome 153 实测（S2 session 级/S3 browser 级均生效）；88 未验证。

**窗口**：本命令连接存活期间生效，断开即回退（秒级时滞+HTTP 缓存命中不重校验，S4/S5）；不跨命令。审计 `action=security.ignore-certs`（每命令恰一次）；`--json` goto/flow 成功 data 增 `insecure:true`（仅带旗标）。

**wait --expr**：与 `--text` 互斥（同给 E_USAGE），轮询 `Runtime.evaluate`（returnByValue+awaitPromise）truthy；复用 `--interval/--timeout`（总预算语义）；异常/求值失败记 lastError **继续轮询**，超时 E_TIMEOUT（data.found=false）；主 frame 不跨 iframe；表达式应只读幂等。等待读数链路=`goto --insecure` 一次导航 + 后续读命令不带旗标（wait 不在四命令面）。

**验收**：selftest #119（fake-CDP 调用序列+自签 HTTPS fixture 实弹两连过；无旗标对照组 `ERR_CERT_AUTHORITY_INVALID`；flow replay --insecure 整场）。

## 18. C7/C8：net HAR 1.2 导出 / agent 页签治理（V20261113003）

**HAR（C7 #122）**：`net --har <path>` 在采集窗口结束、net JSON 落盘后同步导出 HAR 1.2（`lib/har.js` 纯构建函数）。最小子集=`log{version:1.2,creator,pages}` + `entries[]`（request{method/url/httpVersion/headers/queryString/postData?}/response{status/statusText/headers/content{size/mimeType/text?}}/cache/timings；未知量 `-1`）+ `pageref` 页签引用。**脱敏=引用 §16 规则非重写**：头值按 `name: value` 形态过 `redact.text()`（Authorization/Cookie/Set-Cookie/api_key 族原样命中），URL/postData/body 直接过 redact，queryString 名命中 `rules.urlSet` → `<redacted:name>`；`--no-redact` 同放行原值。边界：body 按 UTF-8 解码（二进制失真）、结构化 cookies 不展开、timings 无分段（全 -1）。

**页签治理（C8 #123，用户裁定的降级形态）**：`lib/tab-govern.js`——①命名标记=`new` 登记 `tmpdata/tab-registry/agent-tabs.json`（targetId/createdAt/lastActiveAt/prefix；about:blank 另尽力设 title 前缀 `cu-`，导航后会被站点覆盖、权威标记=注册表；`targets` 文本对登记项/`cu-` 前缀命中打 `[cu]`——前缀=展示辅助，回收判据仍以注册表为准）；②惰性空闲回收=`new`/`close` 末尾顺带扫（无 daemon），默认阈值 10min、单次上限 5；③**白名单铁律：注册表未登记=用户页签，永不回收**（登记项还须 `agent:true`）；④永不抢前台=回收只发 getTargets/closeTarget，绝不 activateTarget/bringToFront（`select` 是唯一显式置前命令；`new` 的 `--background` 语义不变）；⑤活动追踪=`resolveTarget` 命中登记项即 touch lastActiveAt（15s 节流）；⑥豁免=job status=running / lock 未过期 / handoff pending｜waiting → 跳过本轮；⑦配置 `config.jsonc tabs:{reclaim,idleMs,markPrefix,maxPerRun}`（缺失走默认）+ env `CHROMEUSE_TABS_RECLAIM=0`/`CHROMEUSE_TABS_IDLE_MS`。**边界**：flow 自建页签与 MCP tab-helper 路径不登记（安全侧=永不回收）；脚本连续命令间无会话概念，靠 touch+job/lock 豁免兜底。

**命名会话+页签租约（C1 #129，零新命令/零新旗标）**：注册表条目即租约——`owner`（命名会话标识，缺省 `local`；env `CHROMEUSE_TABS_OWNER` 命名本会话）/`expiresAt`（0 或缺省=不过期）/`heartbeatAt`+`leaseMs`（条目 TTL，默认 30min；env `CHROMEUSE_TABS_LEASE_MS`，0=不过期）。`new` 开页发租约；`resolveTarget` touch（15s 节流）顺带心跳续租；`claimLease`/`renewLease`=CAS 语义纯函数，他方**活跃**租约返回 `E_BUSY`（不抢占、零改动）；过期=无主（`planReclaim` 清租约字段后仍按空闲阈值回收，与空闲回收正交）。**单用户零感知**：本主租约绝不拦自己（回收/`close` 与无租约时一致）；`close` 只在他方活跃租约时诚实红 `E_BUSY`（零 closeTarget），`targets` 仅对非缺省 owner 标 `[cu:<owner>]`。边界：不做跨命令互斥（同一页签并发 click/type 交叉仍靠调用侧纪律）；旧条目（无 owner）首次 touch 自动认领。

## 19. C4：bot challenge 识别与止损（V20261113004）

**面**：`goto`/`new` 导航后 + `flow` 每个 goto 步就绪后——只读页侧扫描（title / 正文 6KB / DOM 选择器 / Cookie 名 / 页侧全局变量五类信号），特征表 `lib/challenge.js WALLS` 数据化单点可热修（六墙 Cloudflare/Akamai/DataDome/PerimeterX/Imperva/AWS WAF + 通用 captcha 墙 + access denied 页）。**单墙命中 ≥2 类不同信号才判定**（多信号合取防误报：「页面恰好含单特征串」负样本零触发）；Cookie 走 `Network.getAllCookies`（含 httpOnly cf_clearance 类，失败 fail-soft 少一类信号）；响应头指纹（cf-ray 等）CDP 不回传未纳入。

**语义**（用户裁定 L201 精神）：默认=安全优先——命中即阻断：exit 1、码 `E_POLICY_DENIED`、消息前缀 `CHALLENGE_DETECTED`、接管提示（用户手工验证后重跑本命令）；**禁自解/禁连环重试**（Browse 铁律）。`--allow-challenge`=效率优先——不阻断仅提醒（exit 0），`--json` 成功 data 带 `challenge` 摘要（detected/allowed/wall/matched/waitedMs）。CF/Akamai/Imperva 类非交互盾先有限自愈等待（默认 15000ms，每 800ms 重检；`--challenge-wait-ms` 0~60000，0=不等待），等待后重检仍命中即按上述处置；交互墙（DataDome/PerimeterX/AWS WAF/captcha）不等待（白等=浪费预算）。

**挂点与边界**：`goto`/`new` 命令级（`new` 非 about:blank 先等页侧就绪 ≤8000ms，stdout 的 targetId 恒回显契约不变）；`flow` goto 步失败报告 `error.code=CHALLENGE_DETECTED`、JSON 失败信封码 `E_POLICY_DENIED`；flow 侧等待/放行还支持 `_meta.challengeWaitMs`/`_meta.allowChallenge`（CLI > _meta > 默认）。检测面不可读（evaluate 异常/非 http(s) 页）fail-soft **不误拦**；特征对抗本质——漏报不承诺全拦（自建/冷门盾不在表内），误报逃逸=`--allow-challenge` 或热修特征表；不做跨命令状态文件（短连接模型，单命令级即止）。审计 `action=challenge.blocked|allowed`（每次命中恰一行）。selftest #124：六墙+captcha+access denied 特征/零误报负样本/旗标双态/自愈等待 fake-CDP/flow 挂点/审计/本地 fixture 实弹双态。

## 20. C6：a11y 快照语义分组 `--group`（V20261113005）

**面**：`a11y --group`（**默认关**；无旗标输出逐字节不变——@eN 消费、--find/--diff、agent 行式习惯全依赖现行视图）。分组=**渲染层**：行数组、`@eN` 编号源（cdp.js 在报告行上物化）与树序都不动，编号连续性与默认视图一致；与 `--find/--diff/--cursor/--cursor-token/--out` 互斥（那些旗标自带输出视图）。

**分组**：landmark 行开组（main / navigation·nav / banner·header / contentinfo·footer / complementary·aside / region·section / search；嵌套 landmark 成子组，路径 `main > nav`），组外散行按**连续段**成 flow 组（**不重排**=树序保证）；组内同父+同深度+同角色+同标记的连续 run 合并一行 `role ×N [flags]: @e3 "名" | @e4 "名"`；冗余行折叠（InlineTextBox=父文本副本、ListMarker=视觉符号、无名 generic 包装；有 name/ref/flag/value 一律保留）；组内深度按秩压缩（折叠空洞不占缩进）；bounds 分组态省略。组头 `[path] "name" · N 行 · @eN`；单行 flow 组与全页唯一 flow 组不配组头（KISS 反噪声）。

**统计与边界**：`--json data.groupView={stats,groups[]}`；stats=groups/landmarkGroups/flowGroups/rows/lines/runs/folded/defaultChars/groupChars/reduction（行区字符缩减 %）。缩减率随页面结构：合成应用页实测 ≈53%（字符）/≈37%（空白 token 口径），无 landmark 的扁平页仅折叠+run 收益小（不承诺 30%）；真页实测 159 节点应用页：默认 --ref 7140 字符 → --group --ref 3456 字符（-51.6%，含摘要/引用行），@eN 序列 19/19 完全一致。验收 selftest #125（分组纯函数/默认 golden 逐字节/@eN 树序/缩减率/fake-CDP CLI/本地 fixture 实弹双形态）。

## 21. C5' 定位闸门族：nth / uniqueDefault / role name（V20261113006 #126）

**面（纯 flow JSON 层，CLI 零变更）**：①`target.nth`（非负整数 0 基，与 CLI `--nth` 同名同基）——页侧排序后取第 N 个过闸候选，越界=`TARGET_NOT_FOUND`+候选清单（tag/text/rect/frame；CLI/flow 排序链不同源，清单供自校对）；与 `unique` 互斥（校验期红）；仅 text/role 锚点层（domPath/grid/point 无候选序语义）。②`_meta.uniqueDefault`（缺省 true）——操作类（click/rightClick/type/select/scroll/drag）的 text/role target 默认注入 `unique:true`，多命中=`TARGET_AMBIGUOUS`（细分码对齐 CLI E_AMBIGUOUS，失败报告 error.kind=target）；逃逸优先级=target.nth/target.unique 显式 > 步骤级 `unique`（true/false）> `_meta.uniqueDefault:false` 全局还原；assert/wait/probe 不闸门（存在性语义天然宽容）。③`target.name`——role 层 aria 可及名组合锚（getByRole+name：aria-label>alt>textContent，空白归一；缺省 contains、对象形态/兄弟键 match 可 exact；须与 role 同用、不得与 text 同用）；role 层同享 unique/nth。④`uniqueGateInventory(flow)` 纯函数=存量预检影响清单（不参与回放/lint 判定）。

**边界**：unique 判定在页侧排序后（text=五键序 / role=文档序），CLI 与 flow 的「第 N 个」可能不同源——越界/ambiguous 一律附候选清单；历史 `TARGET_NOT_FOUND+ambiguous` 附加字段保留兼容；gate 遇确定性别名（ambiguous/nth 越界）立即红不空转。验收 selftest #126（vm 页侧 nth 双态+越界清单/uniqueDefault 注入+三级逃逸+inventory/role name 三态/细分码/存量 lint 零新红；实弹 fixture 双态，无浏览器跳过）。

## 22. C5' flow 表达力 V2：eval / set / cond / loop（V20261113008 #127）

**面（纯 flow JSON 层，CLI 零变更）**：①`eval{expr, var?}`=只读 JS 表达式求值（`Runtime.evaluate` returnByValue+awaitPromise，与 `wait --expr` 同口径）——静态沙箱拒绝 `process/require/fs/child_process/module` 与 `eval()/Function()/import()`（引号/注释/模板字面量内不算），命中=`E_POLICY_DENIED`；预算缺省 3000ms、上限 10000ms（`EVAL_TIMEOUT`）；表达式内变量经注入参数 `__vars.name` 读取（**禁止** `{{var}}` 拼接）；返回 undefined/unserializable 记 null 并告警。②`set{var, value}`=变量赋值（value 为 JSON 字面量，字符串/对象递归支持 `{{var}}` 插值）。③`cond{when, jump}`=条件跳步：`when` 三形态恰居其一——`{cond}`（wait/assert 同文法，数组=anyOf）/`{expr}`（只读 JS truthy）/`{var, equals?|notEquals?}`（Node 侧比较，对象走 JSON 比较、缺省 truthy）；`jump` 二选一——`{to:"label"}` 或 `{skip:N}`（正向跳过 N 步）。④`loop{times|over, count, itemVar?, indexVar?}`=受控循环——重复**后续 count 步**：`times` 1~50 或 `over` 遍历变量数组（itemVar=当前项、indexVar=当前遍序号 0 基，每遍重写）；全 flow 重复执行（loop 重复+cond 后退跳步）共享硬上限 50，超限 `LOOP_LIMIT_EXCEEDED` 诚实红。

**标签与语义**：`label` 为全原语通用可选字段（唯一性校验）——`cond.jump.to` 须引用存在的 label；禁从循环体外跳入重复体（循环帧未建立）；loop 体只允许严格嵌套。cond 跳到体尾 `end+1` = **跳出循环（break）**；自然走完体尾 = 下一遍/结束。变量作用域=`{{var}}` 在**步骤执行时**插值（存量 flow 启动时插值结果逐字节等价）；启动期仍 fail-fast（引用必须由 flow.vars/--var 或任一 set/eval/loop 帧变量提供），分支未覆盖的消费在步骤处 `VAR_MISSING`。lint 新增 M6（loop.times>10 / cond 后退跳步=高迭代 advisory）与 M7（eval/cond 表达式敏感关键词 advisory）；eval 返回值落报告前统一过 §16 `redact.text`（completedSteps/失败报告脱敏，vars 内原值仅供后续步骤消费）。全 flow 重复执行共享预算常量 `MAX_LOOP_ITERATIONS`（50）。**原语计数唯一真源=`lib/flow-engine.js` ACTIONS.length**（引擎错误文案动态派生；README/help/playbook 数字为引用副本，禁手写第二真源）。**不做 auto-wait**（2026-11-13 编排方批准：M1 lint 已强制前置闸门 + click `gate` 已有；轻量存在性等待会改变全部操作步失败时延、掩盖真红即时性——留 V3 重评）。验收 selftest #127（schema/沙箱/变量链/跳步正反/循环上限/lint M6/存量 flow 零回归/本地 fixture 新原语组合两连过）；#130 补 M7 表达式敏感关键词与 eval 返回值报告层脱敏断言（存量 8 flow 基线）。

## 23. C2：人机接力 handoff（V20261113009 #128）

**面**：单命令四形态（automation 组，第 48 命令 / 第 13 个 `--json` 放行）——默认 `--reason` start / `--wait <id>` / `--status [<id>]` / `--cancel <id>`；状态文件 `tmpdata/handoff/<id>.json`（`ho-<yyyyMMdd-HHmmss>-<4hex>`），Continue 信号默认 `<id>.continue`（`--signal` 可覆盖，touch 即确认），id 支持唯一前缀（多命中 E_AMBIGUOUS 不猜）。

**语义**：`waiting` 唯一活跃态 → `confirmed`（信号存在，优先级高于超时）/ `expired`（now≥deadline）/ `cancelled`；终态不可逆。活跃判据=`state==='waiting' ∧ now<deadline` 读者侧双字段即时判定（滞留 waiting 不永久堵死页签回收；tab-govern detectBusy 同口径）。`--wait` 进程内阻塞轮询（2s stat 信号；预算=deadline 单源，不接 `--timeout`），信号/超时当场写终态；start/status/list/cancel 入口惰性结算 + 24h 终态清扫（顺带删信号）。原子写=tmp+rename（jobs 先例）。

**横幅契约**：start 即返（CLI stdout 仅进程退出后可见——纯阻塞会把横幅困在进程里）；固定锚 `⚠⚠⚠ HUMAN REQUIRED`，含原因/页签/`touch "<signalPath>"` 全文命令行/`--status <id>`；`--json data` 同带 `banner`+`signalPath`（机器可靠提取；touch 错路径=协议死锁，故 jsonAllowed=true）。

**页签/留证**：全程零 activate/bringToFront（用户自己切）；等待期豁免 tab-govern 回收，超时自动回归正常治理；expired 保留页签不关（可能有人家半成品输入）。前后截图 best-effort（`Page.captureScreenshot` 2s，失败 evidence 记 null 不阻断；终态截图由 `--wait`/`--cancel` 当场尝试，status/list 惰性结算路径无 CDP 上下文如实记 null）；audit `handoff.created|confirmed|expired|cancelled` 每次迁移恰一行。

**边界**：无通知推送通道（agent 读横幅/文件自决转述，用户消息与 `--wait` 完成天然双通道幂等）；不做 done 动作（touch 零成本）；不做常驻守护；handoff 状态目录未进 quota 登记表（落 other=永不自动删，证据安全侧）。验收 selftest #128（状态机/原子写/清扫/四 action/CLI 两连过+超时红/detectBusy 联动/三计数）。

## 24. 平台适配分层（`lib/platform/`，V20261117 批0-3 #133~#136）

**三域**：`binaries`（ffmpeg/ffprobe 解析+探活，单实现）、`process`（/proc 探针/存活/进程组信号）、`browser`（默认 browserUrl/NAS 提示/beacon 基址/冻结恢复文案）——后两域双 impl（`linux.js` 基准 + `windows.js` 覆写）。**委托链**：`linux.impl.<域>` 冻结方法表 → `windows.impl.<域>` = `Object.create(linux.impl.<域>)` 原型委托，自有属性=覆写并登记 `OVERRIDES`；`platform/index.js` 加载期 `assertImpl` 契约自检（缺键即抛）+ 一行 `impl覆写=[...]` 日志。**已迁移**：批1 `lib/jobs.js` 探针/存活/信号、批2 `cdp-core`（默认 URL/NAS 提示）+ `record`（beacon）+ `tools/cdp`（恢复文案）；**批3 lint**：`lib/`（除 `lib/platform/`）与 `tools/` 禁裸 `process.platform`（selftest #136，白名单=空集；`install.js` 部署域与 `selftest/` 测试层豁免）。

## 25. 动态配置实例 `--config` 与平台层惰性化（V20261117005 批B/R3）

**面（全局 CLI flag，非子命令，49 命令计数不变）**：`cdp.js [--config <path>|--config=<path>] <cmd> ...`，位置无关（pre-parse 扫全 argv，两写法等价）。命中即 `lib/config.setConfigPath`：相对路径按**当刻 cwd** resolve（与 `bin` 键的 skill 根基准分属不同语义域），设后立即试读——文件不存在/JSONC 坏/schemaVersion 非法 → exit 1（E_USAGE 语义；pre-parse 早于 die 定义，故内联 stderr + exit，不静默回落主实例）。

**接线（时序硬点）**：`tools/cdp.js` 在 fs/path require 之后、**任何 lib require 之前**做轻量扫描（不走完整 parseArgs，避免吞子命令参数语义），并把 flag 对从 argv **剥离**——后续 `RAW_ARGV`/子命令 parseArgs 都看不到它（防未来命令同名旗标撞车）；剥离后的 `process.argv` 由 `--async` 作业转发，故 `setConfigPath` 同批写 `CHROMEUSE_CONFIG_PATH` 供子进程继承同一实例。

**平台惰性化（根治）**：`lib/platform/index.js` 的判定 / `assertImpl` 契约自检 / 冻结门面从**模块加载期**推迟到**首次 `platform()` 调用**（闭包缓存单例，`Object.freeze` 语义不变）——否则 `--config` 切 `environment` 后单例已按旧实例定死。现有调用点顶层只拿函数引用（cdp-core/jobs/record 等），首次真实调用都在命令执行期，行为零变化。`config.environment` 与物理平台不一致**允许**（跨平台语义测试/临时实例合法用法）：首次构造打一行 `log.warn`（stderr 回显）「正以 X 语义运行（PATH/exe 探测按 X 规则）」。

**边界**：`install.js`（部署域，装机目录实例语义）不接 `--config`、从不调 `setConfigPath`——默认实例路径语义不变（selftest 直读 `DIR/config.jsonc` 的断言同理；显式 `CHROMEUSE_CONFIG_PATH` 属用户主动行为）；无 `--config`/`CHROMEUSE_CONFIG_PATH` 时默认路径与行为逐字节等价。验收 selftest #137。

## 26. 浏览器 launch 模式 `browser-up` / `--auto-launch`（V20261117008 批C2/R2）

**面**：`cdp.js browser-up [--timeout ms=20000] [--proxy <url>]`（幂等拉起：`/json/version` 已就绪=复用现有实例）/ `--stop`（显式关停）/ `--status`（只读查询 state+实时就绪）；`--auto-launch` = **全局 flag（位置无关，pre-parse 剥离——同 `--config` 语义，防抢占子命令位）**：连接前若 browserUrl 主机为 127.0.0.1/localhost 才幂等 `ensure()`，非本地跳过并 warn（避免误启本地实例去连远端）。与 `browser-restart` 分工：up=**OS 级进程拉起**（无 keep-alive 环境如 Windows 桌面端）/ restart=**CDP 级重启**（Browser.close 依赖容器 keep-alive，治域损伤）。
**代理（V20261117014 ISSUE-3）**：`launchArgs` 第四参 → 尾部 `--proxy-server=<url>`；优先级 CLI `--proxy` > env `CHROMEUSE_BROWSER_PROXY` > config `proxy.httpProxy`，三者皆空不追加（逐字节同旧版）；仅 http/https/socks5 前缀（非法值 E_USAGE）；只影响被拉起实例（已启动需先 `--stop`），state 落脱敏值（`user:pass` → `***@`，写盘层再归一为 `<redacted:credentials>@`）。
**机制**（`lib/browser-launch.js`，平台差异全走 platform().browser）：`validateChromeConfig`（三键齐备；Firefox/Safari 前置拒绝；userDataDir 空/=`User Data` 特征拒绝）→ 幂等探测 + Chromium 标识校验（`Chrome/` 前缀，Edg/Brave 均含）→ `findBrowserExe`（Linux 绝对→PATH→目录表 / Windows 绝对→App Paths 注册表→目录表→PATH）→ `spawnBrowser`（detached+unref 常驻，args 数组不经 shell）→ 轮询就绪（--timeout 预算，默认 20s）→ state 原子落盘 `tmpdata/browser/launch-state.json`（pid/port/exe/userDataDir/startedAt）。
**stop 双路**：state.pid 进程组信号（SIGTERM→宽限→SIGKILL）→ 进程不在/state 丢失兜底 CDP `Browser.close`；均不可达 → `{stopped:false,method:'none'}` 如实报。**安全红线**：仅 Chromium 内核、独立 user-data-dir 强制（绝不 attach 日常实例；Chrome 136+ 亦要求）、启动失败不静默（发现序/端口占用/profile 锁排查指引）、debugPort≠browserUrl 端口一行 warn。连接失败联动：GQ-004 catch 在 NAS 提示后追加「可运行 browser-up（或 --auto-launch）」；冻结恢复文案桌面端行尾追加 browser-up 指针。验收 selftest #138（核心）/ #139（命令面/实链）。

## 27. flow 测试参与策略 `selftest.config.jsonc`（R4/V20261117011）

**面**：`webapps/<app>/selftest.config.jsonc`（可选件，缺省不建=全参与）→ `selftest/flow-policy.js` 单源读取；两级开关 `excludeApp`（整 app：全部 flow 出测试面 + 该 app 的 `selftest.js` 模块跳过）与 `excludeFlows`（basename 清单，二者互斥），有排除时 `reason` 必填。
**语义**：排除 ≠ 删除——资产层数量/零残留/镜像对断言保留，schema/lint/冻结基线（#18/#34/#44/#58/#74/#126/#127/#130）改在**参与集合**上工作（零配置时与全量等价）；启动后 #140 打一行「纳入 X / 排除 Y（app: reason）」，正常零 warn；#18b 凭据禁词仍全量扫（安全红线不豁免）。配置坏（解析/类型/互斥/清单与实存不符/reason 空）→ #140 fail；`lib/`、`tools/` 零引用（测试语义不进运行库）。分发/撤销见 install.md §0。

## 28. captureBeyondViewport 探测与 legacy 回退（ISSUE-1 / V20261118）
**单源**=`lib/beyond-probe.js` 头注释（双拍判定矩阵/88 实锤形态/fail-open 方向/缓存 key）；`scroll-shot` 长页惰性探测，判不支持时 A 路径改段级撑视口无 clip（清单 `via=A2`，失败仍落 jpeg 降级→B）；缓存 `tmpdata/state/beyond-viewport.json`（key=浏览器版本，手删即重探），验收 selftest #141。
