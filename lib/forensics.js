'use strict';
/*
 * chromeuse lib/forensics.js —— CDP 失效分型取证判定层（V202609300001 Phase 1）
 *
 * 来源：reports/CDP失效分型取证协议-oracle-20260930.md 交付物 1（8 层分型模型）+ 交付物 3（judgeLayers 伪代码）。
 * 纯函数单源（判例先例：lib/screenshot.js judgeMatrix——从 lib export 供 selftest require）：
 *   - parseSymptomChannel(symptom)：症状三元组（来源/目标页/错误码）→ 通道启发式 mcp|cdp|mixed|unknown
 *   - judgeLayers(evidence)：采集证据 → { layerVerdicts, verdictSummary, nextSteps }
 *
 * 8 层分型（层序=判别顺序，从外到内先排除廉价假设）：
 *   M  MCP 客户端层（长驻连接半开死亡——cdp.js 短连接每次新进程天然免疫，独立通道对照是唯一判据）
 *   A1 HTTP 探测面（sidecar 死/网络断；HTTP 502/504=sidecar 活、上游死→B）
 *   A2 WS 面（HTTP 活但 WS 握手/命令死——gateway Host 改写/webSocketDebuggerUrl 回写异常）
 *   B  浏览器进程层（进程死/DevTools handler 挂/per-target -32601 域损伤）
 *   C  renderer 冻结（持续型；取证时刻无法与 F 瞬时二选一——统一先按 F 处置，watch 收敛）
 *   D  合成器/截图通道（eval 活截图死；controlTab 三分：全局/单 tab/新 tab 冷启动）
 *   E  target/会话堆积（慢性退化维度，独立叠加不抢叶子分型；初始阈值待失效样本校准）
 *   F  页面主线程忙（"假失效"最高频源：单页死其他页活）
 *   G  页面侧元素级死亡（非 CDP 失效：通道全绿才允许判；任何浏览器重启无济于事）
 *
 * 语义红线（实施裁定）：
 *   - 判定恒 advisory：status ∈ confirmed|suspect|ruled-out|unknown，绝不触发任何恢复动作；
 *   - 置信度枚举 low|mid|high（spec 伪代码 mid-high 映射 high 侧）；E 阈值单条越界=low、多条=mid；
 *   - allGreen 需 page 探针证据（pages>0）——空矩阵不给 allGreen（无证据不判 G）；
 *   - -32601 域损伤签名补充判定（spec B 层卡片的代码化；伪代码未含，属只增不改）。
 */

/** E 层堆积初始阈值（oracle 定稿「待失效样本校准」；单源供 selftest 断言与 judgeLayers 共用） */
const E_LIMITS = { total: 12, pages: 6, serviceWorker: 4, attached: 2, wsLatencyAvgMs: 500 };

const LAYER_ORDER = ['M', 'A1', 'A2', 'B', 'C', 'D', 'E', 'F', 'G'];

/**
 * 症状三元组 → 通道启发式（纯函数）：--symptom 原文中找 mcp/cdp 字样。
 * 例："MCP 工具全 -32001" → mcp；"smoke-test: cdp.js / 默认页 / 无错误" → cdp；两者都提 → mixed。
 */
function parseSymptomChannel(symptom) {
  const s = String(symptom || '').toLowerCase();
  const mcp = /\bmcp\b|mcp工具|mcp 工具|mcp侧|mcp 侧/.test(s);
  const cdp = /\bcdp\b|cdp\.js|cdp工具|cdp 工具|cdp侧|cdp 侧/.test(s);
  if (mcp && cdp) return 'mixed';
  if (mcp) return 'mcp';
  if (cdp) return 'cdp';
  return 'unknown';
}

/**
 * 失效分型判定（纯函数；spec 交付物 3 伪代码代码化）。
 * @param e {{
 *   symptomChannel?: 'mcp'|'cdp'|'mixed'|'unknown',
 *   http?: { ok: boolean, versionProbe?: { kind?: string, status?: number } },
 *   ws?: { connect?: boolean, getTargets?: boolean, wsLatency?: { avgMs?: number } | null },
 *   probeMatrix?: Array<{ eval: string, rawShot: string, url?: string, targetId?: string }>,  // eval/rawShot ∈ fmtProbeErr 值域 ok|timeout|error:<msg>
 *   controlTab?: { used?: boolean, shotProbe?: string | null },
 *   targets?: { total?: number, byType?: Record<string,number>, attachedCount?: number },
 * }}
 * @returns {{ layerVerdicts: Array<{layer,status,confidence,evidence}>, verdictSummary: string, nextSteps: string[] }}
 */
function judgeLayers(e) {
  const channel = (e && e.symptomChannel) || 'unknown';
  const matrix = (e && Array.isArray(e.probeMatrix)) ? e.probeMatrix : [];
  const pages = matrix.length;
  const http = (e && e.http) || {};
  const httpOk = !!http.ok;
  const vp = http.versionProbe || {};
  const ws = (e && e.ws) || {};
  const wsConnect = !!ws.connect;
  const wsGetTargets = !!ws.getTargets;
  const wsOk = wsConnect && wsGetTargets;
  const control = (e && e.controlTab) || {};
  const targets = (e && e.targets) || {};
  const byType = targets.byType || {};

  // allGreen（spec 字面：HTTP ok + WS ok + 页探针全绿）+ pages>0 守卫——空矩阵无探针证据不判 allGreen
  const allGreen = httpOk && wsOk && pages > 0 && matrix.every((p) => p && p.eval === 'ok' && p.rawShot === 'ok');

  const V = {};
  const set = (layer, status, confidence, evidence) => {
    V[layer] = { layer, status, confidence, evidence: evidence || [] };
  };

  /* ── 缺省态（保守 unknown；被下方分支覆写）── */
  set('M', 'unknown', 'low', ['M 需「cdp.js 独立对照全绿 + 症状在 MCP」双条件，当前证据不足']);
  set('A1', httpOk ? 'ruled-out' : 'unknown', httpOk ? 'high' : 'low',
    httpOk ? ['http.ok——gateway sidecar 已响应 HTTP（sidecar 进程与网络面存活）'] : ['HTTP 探测面未取得响应——sidecar/网络面无法确认']);
  set('A2', wsConnect ? 'ruled-out' : 'unknown', wsConnect ? 'high' : 'low',
    wsConnect ? ['ws.connect ok——WS 握手与 webSocketDebuggerUrl 回写正常'] : ['WS 面未建立（HTTP 面死或握手失败）']);
  set('B', 'unknown', 'low', ['browser 级命令未触达或未取得结果']);
  const anyEvalDead = pages > 0 && matrix.some((p) => p.eval !== 'ok');
  const anyShotDead = pages > 0 && matrix.some((p) => p.rawShot !== 'ok');
  set('C', pages ? (anyEvalDead ? 'unknown' : 'ruled-out') : 'unknown', 'low',
    pages ? ['probeMatrix 判定：' + (anyEvalDead ? '有页 eval 死——F(自愈型)/C(持续型) 瞬时不可分，watch 收敛' : 'eval 全活——renderer 未冻结')] : ['无 page 探针证据']);
  set('D', pages ? (anyShotDead ? 'unknown' : 'ruled-out') : 'unknown', 'low',
    pages ? ['probeMatrix 判定：' + (anyShotDead ? '有页截图死' : '截图全活——合成器/截图通道无异常')] : ['无 page 探针证据']);
  set('E', 'unknown', 'low', ['无 targets 数据']);
  set('F', pages ? (anyEvalDead ? 'unknown' : 'ruled-out') : 'unknown', 'low',
    pages ? ['probeMatrix 判定：' + (anyEvalDead ? '有页 eval 死' : 'eval 全活——无单页主线程忙证据')] : ['无 page 探针证据']);
  set('G', 'unknown', 'low', ['G 闸门=通道全绿，当前不满足或证据不足']);

  const nextSteps = [];

  /* ── 分支判定（spec 判定树顺序）── */
  if (allGreen) {
    set('B', 'ruled-out', 'high', ['Target.getTargets ×3 成功（wsLatency ' + ((ws.wsLatency && ws.wsLatency.avgMs) || '?') + 'ms）——browser 级命令响应正常']);
    if (channel === 'mcp') {
      set('M', 'confirmed', 'high', [
        'http.ok + ws.ok + probeMatrix 全绿（' + pages + ' 页）——cdp.js 独立短连接对照全绿',
        'symptomChannel=mcp——症状在 MCP 侧',
        '机理候选：MCP 长驻半开连接（gateway proxy_read_timeout 1h 掐空闲 WS + Puppeteer 不检测半开）；cdp.js 每次新进程天然免疫',
      ]);
      set('G', 'unknown', 'low', ['allGreen 过 G 闸门（必要非充分）但症状指向 MCP 层——页面侧无证据']);
      nextSteps.push('2a：不碰浏览器。取证留档后提低成本恢复：docker compose restart opencode（重置 MCP 长连接，不杀任何浏览器 tab——人工）；记录失效前浏览器空闲时长（验证 1h proxy_read_timeout 假设）');
    } else {
      set('G', 'suspect', 'mid', [
        'http.ok + ws.ok + probeMatrix 全绿（' + pages + ' 页）——通道级零异常',
        'symptomChannel=' + channel + '——非 MCP 来源；G=页面侧元素级死亡或症状误报',
      ]);
      nextSteps.push('2h：通道全绿=非 CDP 失效。转 module 即席取证协议（net 采集/console Log 域/单会话监听器盘点）；复核症状三元组是否误报。⚠ 任何浏览器重启无济于事（G 层特性），勿白杀用户 tab');
    }
    return finalize();
  }

  if (!httpOk) {
    const kind = vp.kind || 'unknown';
    if (kind === 'http') {
      const st = vp.status;
      set('B', 'confirmed', (st === 502 || st === 504) ? 'high' : 'mid', [
        'http.versionProbe kind=http' + (st ? ' status=' + st : ''),
        'sidecar 活、上游浏览器进程死/重启中（502/504 签名）',
        'keep-alive 循环 2s 拉起+冷启动 10-30s——短暂 502 属自愈窗内',
      ]);
      set('A1', 'ruled-out', 'high', ['HTTP 状态码来自 sidecar 代理响应——sidecar 进程与网络面存活']);
      nextSteps.push('2c→Step3：等 60s（keep-alive 拉起 ~2s+冷启动窗）后复跑取证；持续 502 → keep-alive 疑失效，人工线 docker restart chrome-browser（批准线 3️⃣）');
    } else {
      set('A1', 'confirmed', 'mid', [
        'http.versionProbe kind=' + kind + '——sidecar 自身/网络面不可达（conn/timeout）',
        'cdp-watch 自愈窗 30-60s（sidecar 探测失败自杀由 Docker 拉起重绑命名空间）',
      ]);
      nextSteps.push('2b：等 60s（cdp-watch 自愈窗 30-60s）复跑取证；仍死 → 人工 gateway restart：docker compose restart chrome-browser-gateway（只重启 sidecar 不杀浏览器 tab，批准线 1️⃣）');
    }
    return finalize();
  }

  if (!wsConnect) {
    set('A2', 'confirmed', 'mid', [
      'http.ok——HTTP 探测面活',
      'ws.connect 失败——WS 握手/路径异常（gateway Host 改写 / webSocketDebuggerUrl 回写损伤嫌疑；对照 http.webSocketDebuggerUrl 应为 gateway 地址）',
    ]);
    nextSteps.push('2c：新开连接复跑一次取证（排除单连接损伤）；仍死 → gateway restart（批准线 1️⃣）');
    return finalize();
  }

  if (!wsGetTargets) {
    set('B', 'confirmed', 'mid', [
      'http.ok + ws.connect ok——连得上',
      'Target.getTargets 失败——browser 级命令不动（DevTools handler 挂，影响所有 target）',
    ]);
    nextSteps.push('2c：重跑取证（新 WS 连接）确证非单连接损伤；若 per-target 域命令全 -32601 → 域损伤签名，提议 browser-restart（批准线 2️⃣，需用户确认无重要 tab 现场）');
    return finalize();
  }

  /* ── HTTP/WS 全活：per-target 矩阵分型 ── */
  const deadEval = matrix.filter((p) => p.eval !== 'ok');
  const shotDead = matrix.filter((p) => p.rawShot !== 'ok');
  const domain32601 = deadEval.length > 0 && deadEval.every((p) => /-32601/.test(String(p.eval)));
  set('B', domain32601 ? 'suspect' : 'ruled-out', 'mid', domain32601
    ? ['全页 eval 错误签名含 -32601——域损伤（进程活/HTTP/WS 活/per-target 域命令死；keep-alive 过渡态或 DevTools 损伤）']
    : ['Target.getTargets 活 + page 探针已触达——browser 级无异常证据']);

  if (pages === 0) {
    nextSteps.push('通道活但无 page 型 target 可探——用 cdp.js targets 核对清单（tab 全关/非 page 型堆积？）；复跑取证');
  } else if (deadEval.length > 0 && deadEval.length < pages) {
    set('F', 'suspect', 'mid', [
      '部分页 eval 死（' + deadEval.length + '/' + pages + '）——单页主线程忙签名（"CDP 整体失效"感知的最高频误判源）',
      '死页：' + deadEval.map((p) => p.url || p.targetId || '?').join(' , ').slice(0, 120),
    ]);
    set('C', 'unknown', 'low', ['F（秒~分级自愈）与 C（持续冻结）取证时刻无法瞬时二选一——统一先按 F 处置，watch 收敛判定']);
    if (shotDead.length) set('D', 'suspect', 'low', ['混合签名：' + shotDead.length + ' 页截图也死——随 F/watch 处置收敛']);
    nextSteps.push('2d：通道没坏。等 ≥10s 复跑轻探针（20s 自愈型常见；两次尝试间隔 ≥10s 不重击）；或起 watch --interval 10 --window 120 --max-seconds 150 后台观测；期间换健康 target 继续任务。watch exit 2 才升级为 C');
  } else if (deadEval.length === pages && shotDead.length > 0) {
    set('C', 'suspect', 'high', [
      '全部 ' + pages + ' 页 eval 死 + 截图死——broad-block 深度冻结签名',
      '死页：' + deadEval.map((p) => p.url || p.targetId || '?').join(' , ').slice(0, 120),
    ]);
    set('F', 'ruled-out', 'mid', ['范围=全量页——非单页主线程忙']);
    if (domain32601) set('B', 'suspect', 'mid', ['错误签名含 -32601——域损伤（keep-alive 过渡态/DevTools 损伤）与 C 并存嫌疑：browser-restart 域级深检可判']);
    nextSteps.push('2e：起 watch --interval 10 --window 120 --max-seconds 150 到 exit：期间自愈→自愈型冻结归档；exit 2 → 重启线（批准线 2️⃣ browser-restart 需确认现场 / 3️⃣ docker restart chrome-browser）');
  } else if (deadEval.length === 0 && shotDead.length > 0) {
    const dEv = [
      '全部页 eval 活 + 截图死（' + shotDead.length + '/' + pages + '）——合成器/截图通道签名',
      '截图死不影响业务操作（DOM 快照替代：exec \'Page.captureSnapshot\'）',
    ];
    if (control.used && control.shotProbe === 'ok') dEv.push('对照 tab 可截——非全局死：单 tab Surface 停滞/新 tab 冷启动嫌疑');
    else if (control.used && control.shotProbe && control.shotProbe !== 'ok') dEv.push('对照 tab 也死——全局截图通道异常嫌疑（D 全局）');
    else if (!control.used) dEv.push('对照 tab 未启用（--no-control-tab 或未触发）——全局/单 tab 未能细分');
    set('D', 'suspect', 'high', dEv);
    nextSteps.push('2f：读 controlTab 三分：新 tab 冷启动→退避等 ~5min（BACKOFF 硬帽）；单 tab 停滞→换 tab；全局死→重启线（取证已落盘）。非视觉任务用 DOM 快照继续');
  } else if (domain32601) {
    nextSteps.push('2c：-32601 域损伤签名——提议 browser-restart（批准线 2️⃣，需确认现场；幂等可重跑补域检）');
  } else {
    nextSteps.push('分型证据不足（混合/空签名）——复跑取证对照；或按 runbook 过渡期四条逐面排查（probe/targets/doctor/screenshot 对照）');
  }
  return finalize();

  /* ── E 独立叠加 + M 补充 + 汇总（分支共尾）── */
  function finalize() {
    const hasTargets = targets.total !== undefined;
    if (hasTargets) {
      const total = Number(targets.total) || 0;
      const sw = Number(byType.service_worker) || 0;
      const attached = Number(targets.attachedCount) || 0;
      const avgRaw = ws.wsLatency ? Number(ws.wsLatency.avgMs) : NaN;
      const avg = Number.isFinite(avgRaw) ? avgRaw : null;
      const breaches = [];
      if (total > E_LIMITS.total) breaches.push('targets.total=' + total + '>' + E_LIMITS.total);
      if (pages > E_LIMITS.pages) breaches.push('probeMatrix 页数=' + pages + '>' + E_LIMITS.pages);
      if (sw > E_LIMITS.serviceWorker) breaches.push('service_worker=' + sw + '>' + E_LIMITS.serviceWorker);
      if (attached > E_LIMITS.attached) breaches.push('attached=' + attached + '>' + E_LIMITS.attached);
      if (avg !== null && avg > E_LIMITS.wsLatencyAvgMs) breaches.push('wsLatency.avgMs=' + avg + '>' + E_LIMITS.wsLatencyAvgMs);
      set('E', breaches.length ? 'suspect' : 'ruled-out', breaches.length > 1 ? 'mid' : 'low',
        breaches.length ? breaches : ['各项阈值内（total≤' + E_LIMITS.total + ' / 页数≤' + E_LIMITS.pages + ' / sw≤' + E_LIMITS.serviceWorker + ' / attached≤' + E_LIMITS.attached + ' / wsLatency.avg≤' + E_LIMITS.wsLatencyAvgMs + 'ms）——初始阈值待失效样本校准']);
    }
    // M 补充（spec：症状在 MCP 但通道亦有死层 → M unknown——先修通道层）
    if (channel === 'mcp' && !allGreen && V.M.status !== 'confirmed') {
      set('M', 'unknown', 'low', ['症状在 MCP 但 cdp.js 通道亦有死层——先修通道层（A/B），M 无法独立判定（通道恢复后再做独立对照）']);
    }
    const layerVerdicts = LAYER_ORDER.map((l) => V[l]);
    const active = LAYER_ORDER.filter((l) => V[l].status === 'confirmed' || V[l].status === 'suspect');
    let summary;
    if (allGreen) {
      summary = '通道全绿（HTTP/WS/page 探针全过）——无 CDP 通道异常'
        + (active.length ? '；' + active.map((l) => l + ':' + V[l].status + '(' + V[l].confidence + ')').join('，') : '');
    } else {
      summary = active.length
        ? '分型（advisory）：' + active.map((l) => l + ':' + V[l].status + '(' + V[l].confidence + ')').join('，')
        : '分型证据不足（无 confirmed/suspect 层）';
    }
    summary += '。判定恒 advisory——不自动执行任何恢复动作，恢复动作按 playbook 分型映射表走批准线';
    return { layerVerdicts, verdictSummary: summary, nextSteps };
  }
}

module.exports = { E_LIMITS, LAYER_ORDER, parseSymptomChannel, judgeLayers };
