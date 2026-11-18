'use strict';
/*
 * chromeuse lib/platform/contract.js —— 平台层契约单源（冻结键集 + 加载期自检）
 *
 * 批次：批0（V20261117001）= binaries；批1（V20261117002）= process；批2（V20261117003）= browser
 * （契约按批生长，不提前摆空壳——空壳会稀释契约的防漂移价值）；批C1（V20261117007）= browser 扩 launch 三方法。
 *
 * 契约 = 「域 → 方法名数组」的冻结数据；impl（linux/windows）实现同名方法：
 *
 *   binaries.resolve() → {
 *     ffmpeg:  string,   // 候选绝对路径（缺失时也给期望路径——供离线命令/指引引用）
 *     ffprobe: string,
 *     source:  'config' | 'builtin' | 'none',
 *     exists:  { ffmpeg: boolean, ffprobe: boolean },  // 实际在位标记（resolve 不做 spawn 探活）
 *     hint:    string | null,                          // 缺失时的可操作中文指引（下载/放置/config 键）
 *   }
 *     解析序：① config.jsonc 的 bin.ffmpegPath / bin.ffprobePath（显式路径：相对=skill 根基准、绝对=原样）
 *             ② 内置 bin/ 探测（保留 .exe 探测——Windows 用户自行放置 ffmpeg.exe/ffprobe.exe 亦命中）
 *             ③ 全缺 → source:'none' + hint（不做 PATH/系统 ffmpeg 回退——2026-10-28 裁定：bin/ 单点真源）
 *
 *   binaries.probeVersion(bin) → boolean
 *     真探活：文件在位 AND spawnSync(bin, ['-version']) 5s 超时 exit 0；结果进程级缓存
 *     （沿 lib/scroll-shot.js 2026-10-28 ISSUE-4 语义：只判 existsSync 会把非 ELF/损坏文件误判为可用）。
 *
 * ── process 域（批1，V20261117002；实现自 lib/jobs.js 迁入，语义逐字等价） ──
 *
 *   process.procState(pid) → string|null
 *     /proc/<pid>/stat 状态字符（'R'/'S'/'Z'…）；Z=僵尸（视为死）；Windows/失败 → null（不可验证）。
 *   process.procCmdline(pid) → string[]|null
 *     /proc/<pid>/cmdline 按 NUL 切分（去空项）；Windows/失败 → null（调用方按「不据此判孤儿」降级）。
 *   process.procStartMs(pid) → number|null
 *     进程启动时刻 epoch ms（/proc/stat btime + stat 第 22 字段；USER_HZ=100 仅影响 120s 级判定）；失败 → null。
 *   process.alive(pid) → boolean
 *     kill(pid,0) 通（含 EPERM=存在但不同用户）AND procState !== 'Z'；Windows 继承本实现 + 覆写
 *     procState 恒 null → 等价「kill0 通即存活」。
 *   process.signalProcessGroup(pid, signal) → 'group'|'pid'|null
 *     Linux：整组 kill(-pid) 优先（detached spawn 的作业进程组）→ 'group'；失败落回单 pid → 'pid'；
 *     全失败 → null。Windows：仅单 pid kill → 'pid'/null（无 POSIX 进程组语义）。
 *     非法 pid（0/-1/非整数）一律 null（绝不误发信号）。
 *
 * ── browser 域（批2，V20261117003；实现自 cdp-core/record/tools 迁入，语义与文案逐字节等价） ──
 *
 *   browser.defaultBrowserUrl() → string
 *     CLI/config 均缺省时的 browserUrl（现两平台相同：http://127.0.0.1:9222）。
 *   browser.nasServiceHint(browserUrl) → string|null
 *     browserUrl 主机名精确命中 NAS 容器服务名（chrome-browser）→ 一行可操作提示；否则 null。
 *     文案按平台分（Linux=--url 指引；Windows=--init-config windows 指引）——文案逐字节沿用迁移前。
 *   browser.beaconBase(port) → string
 *     录制 beacon 基址：Linux='http://opencode:<port>'（容器网络内服务名互访）；Windows='http://127.0.0.1:<port>'。
 *   browser.manualRestartHint() → string[]
 *     冻结恢复命令两行原文（含原始缩进；printFreezeReport 直出）——两平台同值，Windows 不覆写。
 *
 * ── browser 域扩展（批C1/R2，V20261117007）：launch 模式三方法（发现/spawn/参数） ──
 *
 *   browser.findBrowserExe(launchCommand) → { path:string, source:'abs'|'path'|'table'|'app-paths' } | null
 *     发现浏览器可执行文件：绝对路径（含带分隔符的相对路径，按 cwd resolve）直通+存在校验；裸名按平台发现序——
 *     Linux：PATH 遍历 → 固定目录表（/usr/bin/google-chrome 等）；Windows（覆写）：App Paths 注册表 →
 *     %ProgramFiles%/%ProgramFiles(x86)%/%LOCALAPPDATA% 安装目录表 → PATH。返回 null = 未发现（调用方给发现序说明，
 *     不静默）。可选第二参 opts 仅供测试注入（fileExists/pathEnv/table/regQuery/env），业务调用只传 launchCommand。
 *   browser.spawnBrowser(exePath, args) → { pid:number|undefined, child:ChildProcess }
 *     detached 独立进程组 + stdio:'ignore' + windowsHide（禁 shell:true——args 数组不经 shell，路径空格安全）；
 *     unref 由调用方（lib/browser-launch.js）做。同步异常转可识别 Error（带 code）；异步 ENOENT 经 child
 *     'error' 事件由调用方收口。
 *   browser.launchArgs(exePath, port, userDataDir) → string[]
 *     平台无关纯函数：--remote-debugging-port / --user-data-dir / --no-first-run / --no-default-browser-check。
 *     纯参数数组（注入面为零）；userDataDir 独立性与非 Chromium 拒绝由调用方强制校验。
 *
 * 纪律：
 *   - 新契约方法先写 Linux impl，Windows 默认继承；Windows 需覆写时在 windows.js 覆写并登记 OVERRIDES。
 *   - impl 内部互调一律 `this.`（保证 Windows 覆写生效；模块级闭包直呼会绕过覆写）。
 *   - 平台无关业务代码不得出现 process.platform 判断（批3 lint 收口；本批先由 #133 源码锚点防回归）。
 */
const CONTRACT = Object.freeze({
  binaries: Object.freeze(['resolve', 'probeVersion']),
  process: Object.freeze(['procState', 'procCmdline', 'procStartMs', 'alive', 'signalProcessGroup']),
  browser: Object.freeze(['defaultBrowserUrl', 'nasServiceHint', 'beaconBase', 'manualRestartHint', 'findBrowserExe', 'spawnBrowser', 'launchArgs']),
});

/** 加载期契约自检（fail-fast）：逐域逐方法必须是 function，缺一即抛——开发期错误不许带病上线 */
function assertImpl(impl, label) {
  for (const domain of Object.keys(CONTRACT)) {
    const table = impl && impl[domain];
    if (!table || typeof table !== 'object') throw new Error(`platform[${label}] 缺契约域：${domain}`);
    for (const method of CONTRACT[domain]) {
      if (typeof table[method] !== 'function') throw new Error(`platform[${label}] 契约方法未实现：${domain}.${method}`);
    }
  }
}

module.exports = Object.freeze({ CONTRACT, assertImpl });
