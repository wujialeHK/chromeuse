'use strict';
/*
 * chromeuse lib/errors.js —— 统一错误码表 + 失败分类纯函数（V202611030001 B1a；零依赖）
 *
 * 定位：CLI 失败出口（tools/cdp.js 的三出口：die / return EXIT_ERR / throw→catch）共用的**码表单源**。
 * 本模块只做纯映射，不做 IO、不打印、不退出——发射与去重在 lib/envelope.js + tools/cdp.js。
 *
 * 码表（20 条）来源与微调（相对 v1 计划「17 码表」，v2 任务书授权按映射清晰度微调）：
 *   - 原 17 条保留：E_USAGE/E_CONN/E_HTTP/E_TIMEOUT/E_CDP/E_DISCONNECT/E_NO_TARGET/E_NOT_FOUND/
 *     E_AMBIGUOUS/E_REF_STALE/E_HIT_BLOCKED/E_FROZEN/E_QUOTA/E_BUDGET/E_CANCELLED/E_POLICY_DENIED/E_INTERNAL
 *   - 新增 E_LOCATE（定位链失败统一码：click/type/hover/drag/upload 的 locate 失败走它；细分码
 *     E_NOT_FOUND（零命中）/E_AMBIGUOUS（多命中不猜）预留给 B4 诊断增强与 B5 ref 解析，本批不发射）
 *   - 新增 E_IO（文件读/写/解析：写盘失败/ENOENT/EACCES/JSON 文件解析失败等，与 E_CDP 区分）
 *   - 新增 E_BUSY（并发/互斥锁占位；B1a 只做映射，实际拒绝语义由 B7 作业模型启用）
 *   - v1 计划里的 E_FAIL 不设：兜底统一为 E_INTERNAL（对齐既有 kind 语义，少一个近义码）
 *
 * 分类优先级（codeForMessage）：E_BUSY → E_TIMEOUT → E_DISCONNECT → E_CONN → E_CDP → E_NO_TARGET
 *   → E_IO → E_USAGE → E_INTERNAL。顺序即语义：文件/网络类特征词先于宽泛的「用法/需要」关键词，
 *   避免「读取/解析失败」被 E_USAGE 抢走（见 references/mechanisms.md §3 映射表）。
 */

const CODES = Object.freeze({
  E_USAGE:        { zh: '用法/参数错误', retryable: false, hint: '按 --help 修正参数后重试（本类错误重试同一命令不会成功）' },
  E_CONN:         { zh: '连接失败（浏览器不可达）', retryable: true, hint: '先 cdp.js probe / doctor 确认通道；容器/端口/sidecar 恢复后重试' },
  E_HTTP:         { zh: 'HTTP 层错误（/json/* 非 2xx）', retryable: true, hint: '查 browserUrl 与 sidecar 路由；502/503 多为容器未就绪，短暂退避后重试' },
  E_TIMEOUT:      { zh: '超时（命令/等待预算耗尽）', retryable: true, hint: '只读类可加大 --timeout 重试；写操作（click/type/drag/upload）勿盲目重试，先确认页面状态' },
  E_CDP:          { zh: 'CDP 协议错误', retryable: false, hint: '看 message 的协议错误原文；-32601 类域损伤用 cdp.js browser-restart 重置' },
  E_DISCONNECT:   { zh: '连接中断（WS 断开）', retryable: true, hint: '重连一次；反复中断查 chrome-browser 容器与网络' },
  E_NO_TARGET:    { zh: '未找到目标页面', retryable: false, hint: 'cdp.js targets 查看现有页签；显式 --target 或先 new 开页（工具永不自动开/关 tab）' },
  E_NOT_FOUND:    { zh: '零命中（预留：B4/B5）', retryable: false, hint: 'locator probe/suggest 收窄定位；核对文本/选择器' },
  E_AMBIGUOUS:    { zh: '多命中不猜（预留：B4/B5）', retryable: false, hint: '用 --nth N 显式选择，或用 container/更精确文本收窄' },
  E_REF_STALE:    { zh: '@eN 引用失效（预留：B5）', retryable: false, hint: '重拍快照取新 ref 后重试' },
  E_HIT_BLOCKED:  { zh: '命中被遮挡/禁用（预留：B4）', retryable: false, hint: '看 evidence 的 elementFromPoint 结果；先关弹窗/遮罩或改用 click-at 坐标' },
  E_FROZEN:       { zh: '浏览器冻结（watch 判定）', retryable: true, hint: '按 watch 输出的恢复命令处置；恢复前所有写操作都会失败' },
  E_QUOTA:        { zh: '产物配额超限（预留：B3）', retryable: true, hint: '先 cdp.js quota prune（B3）清理过期产物，或加大配额后重试' },
  E_BUDGET:       { zh: '时间/体积预算超限（预留）', retryable: false, hint: '缩小范围（--depth/--max-nodes/分段）或显式加大预算旗标' },
  E_CANCELLED:    { zh: '作业被取消（预留：B7）', retryable: false, hint: '确认取消意图；需要重跑时重新提交' },
  E_POLICY_DENIED:{ zh: '策略拒绝（白名单/红线）', retryable: false, hint: '按 message 指出的白名单/红线约束调整方案，重试同一命令不会通过' },
  E_INTERNAL:     { zh: '未分类内部错误', retryable: false, hint: '看 message/stderr；可复现时带命令与日志提 issue' },
  E_LOCATE:       { zh: '定位失败（元素/坐标不可用）', retryable: false, hint: '先 locator probe/截图确认；多候选用 --nth，被遮挡/禁用换策略（不盲试重试）' },
  E_IO:           { zh: '文件/IO 错误', retryable: false, hint: '核对路径存在/可写与磁盘空间；文件被占用时先释放再重试' },
  E_BUSY:         { zh: '互斥/并发占用', retryable: true, hint: '等持有者结束（message 含持有者信息）或稍后重试；勿并发跑同一互斥动作' },
});

const CODE_LIST = Object.freeze(Object.keys(CODES));
const CODE_SET = new Set(CODE_LIST);

/** kind（lib/cdp-core.js 的 6 类）→ 码表映射；未知 kind 返回 null（交给消息模式兜底） */
function codeForKind(kind) {
  return ({
    usage: 'E_USAGE', conn: 'E_CONN', http: 'E_HTTP', timeout: 'E_TIMEOUT',
    cdp: 'E_CDP', disconnect: 'E_DISCONNECT',
  })[kind] || null;
}

/* 消息模式表（顺序即优先级；全部大小写不敏感）。die() ~120 处调用点不逐点改，
 * 靠这里做初分类——新增文案若落 E_INTERNAL，优先补关键词而不是给每个调用点加 code。 */
const MESSAGE_RULES = [
  { code: 'E_BUSY', re: /持锁|锁被占用|另一动作|正在运行|busy|locked by/i },
  // 注意：不能裸匹配 /timeout/——大量用法文案含旗标名「--timeout」（如「--timeout 缺值」是 E_USAGE）
  { code: 'E_TIMEOUT', re: /超时|timed\s+out/i },
  { code: 'E_DISCONNECT', re: /连接中断|已断开|WS 断开|socket hang up|ECONNRESET|disconnect/i },
  { code: 'E_CONN', re: /无法连接|连接失败|不可达|浏览器通道|CDP 通道|探活失败|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|fetch failed/i },
  { code: 'E_CDP', re: /CDP 协议|协议错误|-32601|-32000|Unsupported method|Invalid parameters|evaluate 异常/i },
  { code: 'E_NO_TARGET', re: /未找到匹配的页面 target|无任何 page 类型标签|需要?\s*--target|--target 必填/i },
  { code: 'E_IO', re: /写盘失败|落盘失败|无法写入|磁盘|空间不足|ENOSPC|EACCES|EPERM|EISDIR|ENOENT|读取\/解析失败|读取失败|加载失败|文件不存在|不存在：|未找到录屏产物/i },
  { code: 'E_USAGE', re: /用法|需要|缺值|至少|二选一|仅支持|须为|不接受值|不可用|为空|无效|非法|至多一种|成对|只能|未发现任何|解析失败|校验失败|非 chromeuse-/i },
];

/** 消息模式初分类；无命中 → E_INTERNAL（兜底，不静默成功） */
function codeForMessage(message) {
  const s = String(message == null ? '' : message);
  for (const r of MESSAGE_RULES) if (r.re.test(s)) return r.code;
  return 'E_INTERNAL';
}

/** 综合分类：kind 优先（cdp-core 的 6 类语义权威），但 kind=usage 时允许消息模式改判更具体的码
 *  （如 resolveTarget 的「未找到匹配的页面 target」→ E_NO_TARGET）。 */
function codeFor(arg) {
  if (!arg || typeof arg !== 'object') return codeForMessage(arg);
  const { kind, message } = arg;
  const byKind = codeForKind(kind);
  const byMsg = codeForMessage(message);
  if (byKind === 'E_USAGE' && byMsg !== 'E_INTERNAL' && byMsg !== 'E_USAGE') return byMsg;
  return byKind || byMsg;
}

/** 进程退出码 → 码（main().then / exit hook 兜底用）：2=watch 冻结，其余非 0=E_INTERNAL */
function codeForExit(exitCode) {
  return Number(exitCode) === 2 ? 'E_FROZEN' : 'E_INTERNAL';
}

/** 非幂等动作（v1 计划 §难点 5）：超时/连接类错误**不**默认建议重试（红线 #10 熔断同向） */
const NON_IDEMPOTENT = Object.freeze(['click', 'click-at', 'type', 'key', 'hover', 'drag', 'upload']);

/** retryable 判定：码表标可重试 且 当前命令不在非幂等表（--json 信封字段用） */
function isRetryable(code, cmd) {
  const meta = CODES[code];
  if (!meta || !meta.retryable) return false;
  return !NON_IDEMPOTENT.includes(String(cmd || ''));
}

/** 重试建议退避（仅在 retryable=true 时随信封输出；v1 计划：retryable=true 必带 backoffMs） */
function backoffMs(code) {
  return ({ E_CONN: 3000, E_HTTP: 5000, E_TIMEOUT: 2000, E_DISCONNECT: 2000, E_BUSY: 5000, E_FROZEN: 30000 })[code] || 0;
}

function isCode(code) { return CODE_SET.has(String(code || '')); }

module.exports = {
  CODES, CODE_LIST, CODE_SET, MESSAGE_RULES, NON_IDEMPOTENT,
  codeForKind, codeForMessage, codeFor, codeForExit, isRetryable, backoffMs, isCode,
};
