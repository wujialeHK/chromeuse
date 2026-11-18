'use strict';
/*
 * chromeuse lib/redact.js —— 输出脱敏（redact）单源（B6b N7，V20261104004）
 *
 * 目标：同一套规则在**持久化之前**过滤四类出口（三同源 + 审计第二层）：
 *   ① stdout/stderr 文本（tools/cdp.js 的 console.log/console.error 包装，emit 前）
 *   ② stdout 信封（tools/cdp.js emitEnvelope：envelope.emit 前 redactDeep）
 *   ③ 落盘文件（tools/cdp.js 包装 fs.writeFileSync：JSON/文本写前；截图等 Buffer 原样）
 *   ④ 审计 JSONL（lib/audit.js record()：白名单之后第二层，见 references/mechanisms.md §16）
 * 统一原则：**脱敏必须在持久化之前**——绝不先写原文再事后清洗。
 *
 * 三层配置（config.jsonc `redact` 段；模板 schemaVersion 3 起）：
 *   secretsFile  KEY=VALUE 每行一个的本机凭据文件路径（# 注释；**凭据禁入 skill=红线 #8**，
 *                文件不可读/不存在 → fail-soft 告警并跳过）；CHROMEUSE_REDACT_SECRETS_FILE 可覆盖（部署/测试接缝）
 *   urlParams    URL query/fragment 参数名（大小写不敏感；默认见 DEFAULT_URL_PARAMS）
 *   patterns     追加正则字符串（`/re/flags` 或裸源）；内置 Authorization/Cookie/Bearer/JSON 敏感键模式恒生效
 *
 * 命中替换 `<redacted:NAME>`：NAME=参数名 / 内置模式名 / pattern#N / secretsFile 的 KEY。
 * 占位符输入（type 专用）：`type --text "%PASSWORD%"` → 真值只进 CDP Input.insertText；
 *   stdout/日志/JSON data 只出现 `<placeholder:PASSWORD>`（secretsFile 或同名环境变量提供真值）。
 *
 * 纪律：本模块纯函数为主、全程 fail-soft——任何解析/替换异常都返回原文，绝不阻断命令；
 * 默认开，`--no-redact` 由 tools/cdp.js 显式关闭（审计记一条 action=redact.disabled）。
 */
const fsDefault = require('node:fs');

/** 默认 URL 参数名（大小写不敏感；config.redact.urlParams 显式给出时以配置为准） */
const DEFAULT_URL_PARAMS = ['access_token', 'code', 'token', 'key', 'sign', 'sessionid', 'password'];

/** 内置模式（恒生效；config.redact.patterns 为追加）。keep=保留前缀捕获组序号（替换只命中值）。 */
const BUILTIN_PATTERNS = [
  // Authorization / Proxy-Authorization 头（容忍 JSON 序列化后的 "Authorization":"Bearer …" 与转义形态 \"Authorization\":\"…\"）
  { name: 'authorization', re: /\b((?:proxy-)?authorization\s*(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)([^\r\n"'\\;,}]+)/gi, keep: 1 },
  // Cookie / Set-Cookie 整行值
  { name: 'cookie', re: /\b((?:set-)?cookie\s*(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)([^\r\n"'\\;,}]+)/gi, keep: 1 },
  // 裸 Bearer/Basic 凭据（无头名场景，如 console 打印 body）
  { name: 'bearer', re: /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, keep: 1 },
  // JSON/表单体里的敏感键（access_token/password/secret/api_key…；容忍两侧引号与嵌入 JSON 的转义引号）
  { name: 'sensitive-json', re: /((?:\\?["'])?(?:access_token|refresh_token|id_token|password|passwd|secret|api[_-]?key)(?:\\?["'])?\s*:\s*(?:\\?["'])?)([^"'\\\r\n]+)/gi, keep: 1 },
];

const MARK = (name) => `<redacted:${name}>`;

/* ── 配置解析（纯函数；坏输入 fail-soft） ── */

/** `/re/flags` 或裸源 → RegExp（恒全局；flags 校验，非法抛错由调用方 fail-soft） */
function parsePatternSource(src) {
  const str = String(src == null ? '' : src).trim();
  if (!str) throw new Error('空模式');
  const m = /^\/([\s\S]*)\/([a-z]*)$/i.exec(str);
  let body = str;
  let flags = '';
  if (m) { body = m[1]; flags = m[2]; }
  if (!/^[dgimsuvy]*$/.test(flags)) throw new Error(`非法标志「${flags}」`);
  if (!flags.includes('g')) flags += 'g';
  return new RegExp(body, flags);
}

/** KEY=VALUE 解析（每行一个；# 注释/空行跳过；坏行计入 warnings） */
function loadSecrets(file, fsImpl) {
  const fsi = fsImpl || fsDefault;
  const warnings = [];
  const entries = [];
  if (!file) return { entries, warnings };
  let text;
  try { text = fsi.readFileSync(String(file), 'utf8'); }
  catch (e) {
    warnings.push(`redact.secretsFile 不可读（fail-soft，已忽略）：${file}（${(e && (e.code || e.message)) || 'unknown'}）`);
    return { entries, warnings };
  }
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) { warnings.push(`redact.secretsFile 第 ${i + 1} 行非 KEY=VALUE（已跳过）`); continue; }
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!name || !value) { warnings.push(`redact.secretsFile 第 ${i + 1} 行 KEY/VALUE 为空（已跳过）`); continue; }
    entries.push({ name, value });
  }
  return { entries, warnings };
}

/**
 * redact 配置段 → 规则集（纯函数；可注入 fs/env 供 selftest）。
 * @param {{secretsFile?:string,urlParams?:string[],patterns:string[]}} [section]
 * @param {{env?:object,fs?:object,secretsFile?:string,enabled?:boolean}} [opts]
 */
function normalize(section, opts) {
  const o = opts || {};
  const raw = section && typeof section === 'object' ? section : {};
  const warnings = [];

  let urlParams;
  if (Array.isArray(raw.urlParams)) {
    urlParams = raw.urlParams.map((v) => String(v).trim()).filter(Boolean);
  } else {
    if (raw.urlParams !== undefined) warnings.push('redact.urlParams 须为数组（已回退默认值）');
    urlParams = DEFAULT_URL_PARAMS.slice();
  }
  const urlSet = new Set(urlParams.map((v) => v.toLowerCase()));

  const patterns = [];
  if (raw.patterns !== undefined && !Array.isArray(raw.patterns)) {
    warnings.push('redact.patterns 须为数组（已忽略）');
  } else {
    for (const [i, p] of (Array.isArray(raw.patterns) ? raw.patterns : []).entries()) {
      if (typeof p !== 'string' || !p.trim()) { warnings.push(`redact.patterns[${i}] 非法（须非空字符串，已跳过）`); continue; }
      try { patterns.push({ name: `pattern#${i + 1}`, re: parsePatternSource(p), keep: 0 }); }
      catch (e) { warnings.push(`redact.patterns[${i}] 正则非法（fail-soft，已跳过）：${e.message}`); }
    }
  }

  const env = o.env || process.env;
  let secretsFile = o.secretsFile !== undefined ? o.secretsFile
    : (env.CHROMEUSE_REDACT_SECRETS_FILE !== undefined ? env.CHROMEUSE_REDACT_SECRETS_FILE : raw.secretsFile);
  secretsFile = secretsFile == null ? '' : String(secretsFile).trim();
  const secrets = loadSecrets(secretsFile, o.fs);
  warnings.push(...secrets.warnings);

  return {
    enabled: o.enabled !== false,
    urlParams, urlSet,
    patterns,
    secrets: secrets.entries,
    secretsFile,
    warnings,
  };
}

/* ── 替换原语（纯函数 + fail-soft） ── */

function allPatterns(rules) { return [].concat(BUILTIN_PATTERNS, rules.patterns || []); }

function applyPatterns(out, rules) {
  const all = allPatterns(rules);
  for (const p of all) {
    const keep = Number.isInteger(p.keep) ? p.keep : 0;
    out = out.replace(p.re, (...args) => {
      if (keep > 0) {
        const prefix = args[keep];
        if (typeof prefix !== 'string') return MARK(p.name);
        return prefix + MARK(p.name);
      }
      return MARK(p.name);
    });
  }
  return out;
}

/** 文本脱敏：secrets 字面值 → URL 凭据/参数 → 内置+自定义模式（重复调用幂等） */
function text(input, rules) {
  try {
    if (typeof input !== 'string' || !input) return input;
    const r = rules || getRules();
    if (!r || r.enabled === false) return input;
    let out = input;

    // ① secretsFile 字面值（长值优先，防短值先吃掉长值的前缀）
    for (const s of (r.secrets || []).slice().sort((a, b) => b.value.length - a.value.length)) {
      if (!s.value) continue;
      out = out.split(s.value).join(MARK(s.name));
    }

    // ② URL 内嵌凭据 user:pass@
    out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@?#]+)@/gi, `$1${MARK('credentials')}@`);

    // ③ URL query/fragment 参数（?a=1&access_token=x#token=y）
    out = out.replace(/([?&#])([A-Za-z0-9_.~-]+)=([^&#\s"'<>]*)/g, (m, sep, key, val, offset, whole) => {
      if (!r.urlSet || !r.urlSet.has(String(key).toLowerCase())) return m;
      if (String(val).startsWith('<redacted:')) return m; // 幂等
      // 空值分支：下一个字符是 '<'（已替换）时不再重复包（replace 回调的 offset/whole 参数）
      if (!val && typeof whole === 'string' && whole.slice(offset + m.length).startsWith('<redacted:')) return m;
      return `${sep}${key}=${MARK(key)}`;
    });

    // ④ 内置 + 自定义正则
    out = applyPatterns(out, r);
    return out;
  } catch {
    return input; // fail-soft：脱敏失败绝不阻断输出
  }
}

/** URL 专用（语义同 text；保留函数名便于调用点自解释） */
function url(input, rules) { return text(input, rules); }

/** 深拷贝 + 逐 string 脱敏（纯函数，不改原对象；Buffer/Date/Error 等非 plain 原样） */
function deep(value, rules) {
  const r = rules || getRules();
  if (!r || r.enabled === false) return value;
  try { return walk(value, r, new Map(), new Set(), 0); }
  catch { return value; }
}

function walk(v, r, seen, stack, depth) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return text(v, r);
  if (typeof v !== 'object') return v;
  if (depth > 16) return v;
  // 真环 → '[circular]'（防 JSON.stringify 抛错）；共享引用（非祖先）→ 复用同一克隆
  if (stack.has(v)) return '[circular]';
  if (seen.has(v)) return seen.get(v);
  stack.add(v);
  if (Array.isArray(v)) {
    const arr = [];
    seen.set(v, arr);
    for (const x of v) arr.push(walk(x, r, seen, stack, depth + 1));
    stack.delete(v);
    return arr;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) { stack.delete(v); return v; }
  const out = {};
  seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = walk(v[k], r, seen, stack, depth + 1);
  stack.delete(v);
  return out;
}

/* ── 占位符输入（type --text "%PASSWORD%"） ── */

/** 整串 `%KEY%` → KEY；否则 null */
function placeholderName(input) {
  const m = /^%([A-Za-z_][A-Za-z0-9_]*)%$/.exec(String(input == null ? '' : input));
  return m ? m[1] : null;
}

/**
 * 解析占位符：secretsFile 优先，其次同名环境变量；未命中返回 hit:false + warning（按字面量输入）。
 * @returns {{hit:boolean,key?:string,value:string,source?:string,warning?:string}}
 */
function resolvePlaceholder(input, rules, env) {
  const raw = String(input == null ? '' : input);
  const key = placeholderName(raw);
  if (!key) return { hit: false, value: raw };
  try {
    const r = rules || getRules();
    const sec = (r.secrets || []).find((s) => s.name === key);
    if (sec && sec.value) return { hit: true, key, value: sec.value, source: 'secretsFile' };
    const e = env || process.env;
    const ev = e[key];
    if (typeof ev === 'string' && ev !== '') return { hit: true, key, value: ev, source: 'env' };
    return { hit: false, key, value: raw, warning: `占位符 %${key}% 未在 secretsFile/环境变量中找到，已按字面量输入` };
  } catch {
    return { hit: false, key, value: raw, warning: `占位符 %${key}% 解析失败（fail-soft），已按字面量输入` };
  }
}

/* ── 进程级规则实例（CLI 单点；tests 可 configure/reset） ── */
let cached = null;
let forcedEnabled = null; // null=默认 true；false=--no-redact

function loadConfigSafe() {
  try { return require('./config').loadConfig(); } catch { return null; }
}

function getRules() {
  if (!cached) {
    const cfg = loadConfigSafe();
    cached = normalize(cfg && cfg.redact, { enabled: forcedEnabled !== false });
  }
  if (forcedEnabled === false) cached.enabled = false;
  return cached;
}

/** 显式开/关（tools/cdp.js 解析 --no-redact 后调用；须在首次输出前） */
function setEnabled(v) {
  forcedEnabled = v !== false;
  if (cached) cached.enabled = forcedEnabled;
}

/** 注入规则集（selftest：直接用合成配置，不落盘） */
function configure(section, opts) {
  cached = normalize(section, opts);
  if (forcedEnabled === false) cached.enabled = false;
  return cached;
}

function reset() { cached = null; forcedEnabled = null; }

module.exports = {
  DEFAULT_URL_PARAMS, BUILTIN_PATTERNS, MARK,
  parsePatternSource, loadSecrets, normalize,
  text, url, deep, placeholderName, resolvePlaceholder,
  setEnabled, getRules, configure, reset,
};
