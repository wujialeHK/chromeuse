/*
 * chromeuse tools/recorder.js —— 浏览器侧录制注入资产（纯 IIFE，无模块系统；由 lib/record.js 注入）
 *
 * 主世界注入纪律（架构 v3）：IIFE 闭包 + 全 passive 监听 + capture 采集（不 preventDefault 不 stopPropagation）；
 * 布局读仅限语义事件时单次 getBoundingClientRect（scroll 热路径零布局读——window 滚动面维持；
 *   容器滚动面节流放行后单次 rect 读，容器标识必需，ora-20260917 题1 缺陷1 顺修）；密码字段录制端脱敏（红线 7）；
 * IME 感知：composition 期间 input 事件折叠，仅记录 compositionend/change 终值；
 * 产出格式 = 架构 v3 附录 A2（chromeuse-events/1），事件十四类：click/dblclick/contextmenu/input/change/keydown/scroll/
 * navigate/uiAppear（V202609080017 council A⁺ 定稿：UI 状态变迁捕获）+ mousedown/mousemove/mouseup/dragstart/drop
 * （V202609130003 council 裁决④：鼠标序列采集——button 位面/按下期 move 40ms·8px 双阈值节流/DnD types-only 标记）。
 * + paste/copy/cut（ora-20260917 题1 步骤1：剪贴板三事件——clipboardPolicy 三档脱敏（text 默认/masked/meta）+
 *   password 目标恒 *** + policy 元字段 + files types-only）+ keydown 白名单扩展（ora-20260917 题1 步骤2：
 *   Playwright codegen 规则本土化——组合键全录 ctrl/alt/meta + 非打印白名单 + 修饰位面 ctrl/alt/meta/shift 平铺 + code）。
 * + 定位素材采集（V202609220001，TODO【录制定位素材增强：语义事件采集 domPath+aria 名】Jev 吸收终审定稿）：
 *   语义动作事件（LOCATE_TYPES 白名单：click/dblclick/contextmenu/input/change/paste）随事件回传 item.locate
 *   定位素材（稳定 CSS path + aria role/name），Node 侧剥离落独立素材文件（paths.locateMaterialsPath 单源）——
 *   供蒸馏直接抄作定位四层链③层兜底。终审铁律：不进 flow schema、不进回放执行链、事件流
 *   chromeuse-events/1 形状零变化（item.locate 由 Node 侧 delete 后才入 events）。
 * 分层录制（ora-20260917 题1 步骤4）：CFG.inputProfile——semantic 默认档（上述全部）/ full opt-in（CLI --full-input：
 *   wheel 200ms 累计节流/focusin/focusout/auxclick/F1-F12 keydown）；full 档事件=取证原料，蒸馏默认不映射 flow。
 * 重复注入免疫（window.__chromeuseRecorder 哨兵）。
 * 多 target（V202609080013）：每条事件双标 tab（tab-N 别名）+ targetId（稳定标识），由 CFG 注入；
 * pagehide / visibilitychange→hidden 时同步终刷（binding/sendBeacon 双通道）——多 target 后关 tab 是常态，防丢尾部 ≤200ms 队列。
 * docId（V202609080015）：每文档实例唯一代际标识——seq 每文档从 1 重计，跨整页导航靠 docId 与旧文档事件隔离（采集端去重键四元）。
 * uiAppear（V202609080017）：click/dblclick/keydown(Enter)/contextmenu（V202609170001 spec 定稿：右键自定义菜单
 * 捕获，spec 全文见 references/playbook.md §右键菜单 uiAppear 触发面）触发双时刻采样（t1=700ms/t2=1800ms，累积并集、t2 后单发射），
 * 差集 = 采样交互元素键集 − lastStable 基线（键 tag|id|cls|text，不含 rect）；顶层帧 load+600ms 打底基线；
 * iframe 自身 load 后 ~700ms 首采样发射（triggerType:'load'）；scoped 选择器禁 * 遍历（仅 DOM 规模指纹允许 * 计数）；
 * 质量批 #4 修复（V20260910，实弹 rec-2026-09-10_05-09-47）：frame 容器（role:'frame'）是跨文档容器——其内容在
 * iframe 文档内、主文档键集永远不含它，旧键差集 + 零 items 抑制双杀导致 11 个 uiAppear 0 frame。
 * 修复 = 零 items 抑制豁免 + rect 保留 iframe 真值 + 新 frame（seenFrames 未登记）首现即 appeared + 排序加成防 8 容器截断；
 * 打底时已常驻的 frame 登记 seenFrames 视为旧（防常驻 iframe 误报）。
 * 配额纪律：候选 >8000 放弃采样、DOM >50000 降级只 walk 容器门命中子树、≤8 容器×≤12 items。
 */
(function () {
  'use strict';
  if (window.__chromeuseRecorder) return; // 双注入/多帧注入幂等
  var CFG = window.__CHROMEUSE_RECORDER_CFG || {};
  var BEACON = CFG.beaconUrl || 'http://127.0.0.1:9999/beacon';
  var SESSION = CFG.session || '';
  var TAB = CFG.tab || '';           // tab-N 别名（attach 顺序分配；关了重开=新别名）
  var TARGET_ID = CFG.targetId || ''; // CDP targetId（跨导航稳定标识）
  var RE_INJECT = !!CFG.reInject;    // V202609090003 批2：哨兵/重连路径（跳过初始 load-navigate 发射 + uiAppear 静默重打底——防重注入伪事件污染时间线）
  // 分层录制档位（ora-20260917 题1 步骤4）：semantic 默认档 / full opt-in；CFG.inputProfile 由 lib/record.js
  // makeInitScript 注入（CLI --full-input），非法/缺省回退 semantic = 零新增监听（过度录制边界，报告 1.3/1.7）
  var PROFILE = CFG.inputProfile === 'full' ? 'full' : 'semantic';
  // 剪贴板脱敏三档（ora-20260917 题1 步骤1，报告 1.5.2）：text（默认，内容截 200 入流）/ masked（恒 *** 保留 len）/
  // meta（仅 len 内容零入流）；CFG.clipboardPolicy 由 makeInitScript 注入（config recorder.clipboardPolicy /
  // CLI --clipboard-policy），非法值回退默认 text
  var CLIP_POLICY = (CFG.clipboardPolicy === 'masked' || CFG.clipboardPolicy === 'meta') ? CFG.clipboardPolicy : 'text';
  // 文档代际（V202609080015）：seq 是 IIFE 闭包私有计数器、每个文档独立从 1 起——同 target 同 frame
  // 跨整页导航后新文档早期事件 (targetId,frame,1/2/…) 会与旧文档撞去重键被静默丢弃（第二轮实录实锤）。
  // DOC_ID 每文档实例唯一，采集端去重键升级四元 (targetId,frame,docId,seq) 后代际隔离。
  var DOC_ID = Math.random().toString(36).slice(2, 10);
  var seq = 0;            // 本 frame 内单调递增（去重键 = targetId + ':' + frame + ':' + docId + ':' + seq）
  var queue = [];
  var flushTimer = null;
  var lastScroll = 0;

  function framePath() {
    var parts = [];
    try {
      var w = window;
      while (w && w.frameElement) {
        var fe = w.frameElement;
        parts.unshift(fe.name || fe.id || 'iframe');
        w = w.parent;
      }
    } catch (e) { /* 跨域上界：到此为止 */ }
    return 'main' + (parts.length ? '>' + parts.join('>') : '');
  }
  var FRAME = framePath();

  function descriptor(el, ev) {
    var d = {
      tag: el && el.tagName ? String(el.tagName).toLowerCase() : '?',
      id: (el && el.id) || '',
      cls: '', role: '', text: '', rect: null,
      dpr: window.devicePixelRatio,
    };
    try { d.cls = String((el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '')).slice(0, 60); } catch (e) { /* SVG 特例 */ }
    try { if (el.getAttribute) d.role = el.getAttribute('role') || ''; } catch (e) { /* 无属性 */ }
    try { d.text = String((el.innerText !== undefined ? el.innerText : el.textContent) || '').trim().slice(0, 80); } catch (e) { /* 只读兜底 */ }
    try {
      var r = el.getBoundingClientRect(); // 语义事件时单次布局读（纪律允许项）
      d.rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { /* rect 缺失不致命 */ }
    if (ev && Number.isFinite(ev.clientX)) d.point = { x: Math.round(ev.clientX), y: Math.round(ev.clientY) };
    return d;
  }

  /* ── 定位素材采集（V202609220001，终审定稿六约束逐条落地）──
   * ① 事件类型白名单门控：LOCATE_TYPES 动作族（click/dblclick/contextmenu/input/change/paste）才采——
   *    mousemove/scroll/wheel/mousedown/mouseup 等热路径与序列事件零采集（send 第三参不传 el）；
   * ② 成本预算：页侧事件时刻计算（e.target 在手必活、O(depth) 属性读；descriptor 同事件已做 rect 布局读，
   *    本模块 innerText 复用同一次 layout flush——零额外重排、零网络往返，逐事件亚毫秒、仅门控型触发，
   *    整段录制 +200ms 级总量级达标。Node 侧回查方案否决：每事件 Runtime.evaluate 5~50ms 往返超预算，
   *    且弹出层/菜单收起后元素已失（uiAppear 双时刻采样的存在本身即证明 DOM 是易变物）、素材质量更差；
   * ③ 哨兵门控双层：注入期 CFG.locateOn（record.js --no-sentinel → false；缺省开，旧 CFG 兼容）+
   *    Node 侧接收期 sentinel.state==='OK' 才收（SUSPECT/LOST 自动停采、恢复自动续采；fail-soft
   *    不影响录制主链路——门控不过仅丢素材）；
   * ④ 生成规则显式：path 段恒 tag:nth-of-type(n)（恒带序号、结构确定，nth-of-type 优先）；稳定 id 作
   *    '#id' 锚点段并截断爬升（截断到稳定祖先——锚点之上的不稳定层不进 path）；动态 class/框架生成属性
   *    （layui*、react-*、ng-*、css-*、styled-* 前缀与长哈希段）永不入 path，目标元素自带动态类 →
   *    dynamicCls:true 标记（提示蒸馏优先用 aria/语义字段）；aria/role/name 字段排布恒先于 domPath
   *    （09-21 chatgpt 改版实证：id 级 domPath 整代漂移而 aria/语义层存活）；条目 collectedAt 时间戳
   *    由 Node 侧信封盖（lib/time.js isoLocal，last-verified 惯例打标）；
   * ⑤ 跨 iframe/SVG 完整路径不进首版 MV：素材天然 frame 局部（每 frame 独立 recorder 实例，path 只爬
   *    本文档、frame 标识随事件条目 frame 字段回传，不做跨 frame 拼接）；SVG 目标降级 degraded:'svg'
   *    （无 domPath，aria/text 照记）；连续同型同目标（输入连击）按 lastLocateKey 去重。
   * 纯函数（dynamicClsToken/elHasDynamicCls/stableIdToken/nthOfType/buildStablePath/ariaOf/
   * locateMaterial/locateDedupeKey）零闭包依赖——selftest #62 提取直测（#45 extractDue 模式），
   * DOM 依赖面收窄到 parentNode/parentElement/children/id/tagName/className/nodeType 最小面（合成 fake 可直跑）。 */
  var LOCATE_ON = CFG.locateOn !== false; // ③ 注入侧哨兵门控（缺省开：旧 CFG 无该字段不破兼容）
  var LOCATE_TYPES = { click: 1, dblclick: 1, contextmenu: 1, input: 1, change: 1, paste: 1 }; // ① 动作族白名单
  var lastLocateKey = '';

  /** 动态 class token 判定（纯函数 #62 直测）：layui*、react-*、ng-*、css-*、styled-* 前缀（框架生成/
      运行期注入）、≥16 位纯字母数字含数字的哈希段视为动态；普通业务类（btn/task-item/gongqi_tabpage）不动 */
  function dynamicClsToken(cls) {
    var s = String(cls || '').toLowerCase();
    if (!s) return false;
    if (/^layui/.test(s) || /^react-/.test(s) || /^ng-/.test(s) || /^css-/.test(s) || /^styled-/.test(s)) return true;
    if (/^[a-z][a-z0-9]*-[0-9a-f]{8,}$/.test(s)) return true; // css-modules/构建期哈希段
    return s.length >= 16 && /^[a-z0-9]+$/.test(s) && /\d/.test(s); // 纯哈希状 token（css-modules hex-only 变体）
  }
  function elHasDynamicCls(el) {
    try {
      var raw = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '');
      var toks = String(raw).split(/\s+/);
      for (var i = 0; i < toks.length; i++) if (dynamicClsToken(toks[i])) return true;
    } catch (e) { /* 判定失败按非动态（fail-soft） */ }
    return false;
  }
  /** 稳定 id 判定（纯函数 #62）：空/框架生成（layui 前缀、react 前缀、:rN: 形态）/≥16 位哈希状 id 不作锚点 */
  function stableIdToken(id) {
    var s = String(id || '').trim();
    if (!s) return false;
    if (/^layui/.test(s) || /^react/.test(s) || /^:r/.test(s)) return false;
    if (/^[0-9a-f]{16,}$/i.test(s)) return false;
    return true;
  }
  /** nth-of-type 位次（纯函数 #62）：同 tag 兄弟中的位次（恒 ≥1，CSS :nth-of-type 同口径）——
      parentNode.children 索引遍历（真 DOM HTMLCollection 与合成 fake 数组双兼容） */
  function nthOfType(el) {
    var p = el.parentNode;
    if (!p || !p.children) return 1;
    var tag = String(el.tagName || '').toUpperCase();
    var n = 0;
    for (var i = 0; i < p.children.length; i++) {
      if (String((p.children[i] && p.children[i].tagName) || '').toUpperCase() === tag) {
        n++;
        if (p.children[i] === el) return n;
      }
    }
    return 1;
  }
  /** 稳定 path 生成（纯函数 #62 直跑）：段恒 tag:nth-of-type(n)；爬升遇稳定 id → '#id' 锚点段并截断
      （④ 截断到稳定祖先：锚点之上的层不进 path）；深度 ≤32 / 长度 ≤260 超限截断打标（fail-soft）。
      返回 { path, truncated }；truncated ∈ null | 'depth-limit' | 'length-limit' */
  function buildStablePath(el) {
    var MAX_DEPTH = 32, MAX_LEN = 260;
    var segs = [], truncated = null, cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < MAX_DEPTH) {
      depth++;
      var id = '';
      try { id = String(cur.id || '').trim(); } catch (e) {}
      if (stableIdToken(id)) { segs.unshift('#' + id); break; } // 稳定祖先锚点：截断爬升
      segs.unshift(String(cur.tagName || '*').toLowerCase() + ':nth-of-type(' + nthOfType(cur) + ')');
      cur = cur.parentElement || null;
    }
    if (depth >= MAX_DEPTH && cur && cur.nodeType === 1) truncated = 'depth-limit'; // 深度帽优先打标（32 段 nth-of-type 恒超长度帽——length 只在未触深度帽时打标，两分支均可观测）
    var path = segs.join('>');
    if (path.length > MAX_LEN) { path = path.slice(0, MAX_LEN); if (!truncated) truncated = 'length-limit'; }
    return { path: path, truncated: truncated };
  }
  /** aria role/name 解析（纯函数 #62；思路借鉴 Jev snapshot.js——MIT 已核 2026-09-22，仅借鉴思路
      不复制代码，按素材规则重写）：role = 显式 role 属性 > 标签/type 推断小表；
      name = aria-label > aria-labelledby（≤3 id 解析）> 可见文本 > value > title > placeholder > alt */
  function ariaOf(el) {
    var role = '', name = '';
    try { role = String((el.getAttribute && el.getAttribute('role')) || '').trim(); } catch (e) {}
    if (!role) {
      var tag = String(el.tagName || '').toLowerCase();
      if (tag === 'button' || tag === 'summary') role = 'button';
      else if (tag === 'a') role = 'link';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'input') {
        var t = 'text';
        try { t = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase() || 'text'; } catch (e2) {}
        role = (t === 'checkbox' || t === 'radio') ? t : (t === 'button' || t === 'submit' || t === 'reset' ? 'button' : 'textbox');
      }
    }
    try { name = String((el.getAttribute && el.getAttribute('aria-label')) || '').trim(); } catch (e3) {}
    if (!name) {
      try {
        var refs = String((el.getAttribute && el.getAttribute('aria-labelledby')) || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
        var parts = [];
        var doc = el.ownerDocument;
        if (!doc && typeof document !== 'undefined') doc = document;
        for (var i = 0; i < refs.length; i++) {
          var lab = null;
          try { lab = doc.getElementById(refs[i]); } catch (e4) {}
          var lt = lab ? String(lab.textContent || '').trim() : '';
          if (lt) parts.push(lt);
        }
        name = parts.join(' ');
      } catch (e5) {}
    }
    if (!name) { try { name = String((el.innerText !== undefined ? el.innerText : el.textContent) || '').trim().slice(0, 80); } catch (e6) {} }
    if (!name) { try { name = String(el.value || '').slice(0, 80); } catch (e7) {} }
    if (!name) { try { name = String((el.getAttribute && el.getAttribute('title')) || '').trim(); } catch (e8) {} }
    if (!name) { try { name = String((el.getAttribute && el.getAttribute('placeholder')) || '').trim(); } catch (e9) {} }
    if (!name) { try { name = String((el.getAttribute && el.getAttribute('alt')) || '').trim(); } catch (e10) {} }
    return { role: role, name: String(name || '').slice(0, 120) };
  }
  /** 素材条目组装（纯函数 #62）：aria/role/name 字段恒排布在 domPath 之前（④ aria 优先——字段排布
      体现）；SVG 目标降级 degraded:'svg'（⑤ 完整路径不进首版 MV）；目标带动态类 → dynamicCls:true */
  function locateMaterial(el) {
    if (!el || el.nodeType !== 1) return null;
    var aria = ariaOf(el);
    var id = '', testid = '', text = '';
    try { id = String(el.id || '').trim(); } catch (e) {}
    try {
      testid = String((el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy'))) || '');
    } catch (e2) {}
    try { text = String((el.innerText !== undefined ? el.innerText : el.textContent) || '').trim().slice(0, 80); } catch (e3) {}
    var entry = { aria: aria }; // ④ aria/role/name 恒第一字段（优先级排布）
    var isSvg = false;
    try { isSvg = !!el.namespaceURI && String(el.namespaceURI).indexOf('svg') !== -1; } catch (e4) {}
    if (isSvg) {
      entry.degraded = 'svg'; // ⑤ SVG：无 domPath，aria/text 语义字段照记
    } else {
      var p = buildStablePath(el);
      entry.domPath = p.path;
      if (p.truncated) entry.truncated = p.truncated;
    }
    if (id && stableIdToken(id)) entry.id = id;
    if (testid) entry.testid = String(testid).slice(0, 80);
    if (text) entry.text = text;
    if (elHasDynamicCls(el)) entry.dynamicCls = true; // ④ 动态类显式标记（蒸馏优先 aria）
    return entry;
  }
  /** 连续同型同目标去重键（纯函数 #62）：同字段输入连击折叠为一条（成本预算②的条目数闸） */
  function locateDedupeKey(type, entry) {
    return type + '|' + (entry && (entry.domPath || entry.degraded) || '') + '|' + (entry && entry.id || '') + '|' + ((entry && entry.aria && entry.aria.name) || '') + '|' + (entry && entry.text || '');
  }

  function send(type, extra, el) {
    var item = { seq: ++seq, t: Date.now(), type: type, frame: FRAME, docId: DOC_ID, tab: TAB, targetId: TARGET_ID, session: SESSION };
    // 定位素材（V202609220001）：白名单门控 + 注入侧哨兵开关 + 连击去重；素材随批次回传（item.locate），
    // Node 侧剥离落独立素材文件——事件流 chromeuse-events/1 形状零变化（终审铁律）
    if (el && LOCATE_ON && LOCATE_TYPES[type]) {
      var m = locateMaterial(el);
      var k = m ? locateDedupeKey(type, m) : '';
      if (m && k !== lastLocateKey) { item.locate = m; lastLocateKey = k; }
    }
    if (extra) for (var k2 in extra) if (Object.prototype.hasOwnProperty.call(extra, k2)) item[k2] = extra[k2];
    queue.push(item);
    if (!flushTimer) flushTimer = setTimeout(flush, 200);
    return item; // 返回条目（uiAppear triggerSeq 引用触发事件的 seq——V202609080017；V202609170001 修复：
                 // 旧写法 flushTimer 已挂起时提前 return undefined → 连击/密集流下 triggerSeq 恒 0，
                 // 同帧邻近关联静默失效。现恒返回 item，队列/flush 行为不变）
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    var body = JSON.stringify({ batch: queue.splice(0) });
    // 优先 CDP binding 通道（V202609080014）：HTTPS 页面向 http://opencode:9999 sendBeacon 会被
    // Chrome 混合内容策略静默拦截（实测 tab-1 https 零事件）；binding 走 CDP 会话不经页面网络栈。
    // 不存在（旧注入）/抛错 → 回落 sendBeacon（http 页面主通道）→ 再 fetch 兜底；双通道靠 (targetId,frame,seq) 去重幂等。
    try {
      if (typeof window.__chromeuseBeacon === 'function') {
        window.__chromeuseBeacon(body);
        return;
      }
    } catch (e) { /* 落 sendBeacon 兜底 */ }
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(BEACON, body)) return;
    } catch (e) { /* 落 fetch 兜底 */ }
    try { fetch(BEACON, { method: 'POST', body: body, keepalive: true }).catch(function () {}); } catch (e) { /* 采集尽力而为 */ }
  }

 /* 终刷（V202609080013）：pagehide / visibilitychange→hidden 时同步终刷清空现队列——
     多 target 后关 tab 是常态，仅靠 200ms 定时器会丢尾部队列；binding/sendBeacon 均为卸载期可靠通道 */
  function flushOnLeave() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
  }
  window.addEventListener('pagehide', flushOnLeave, { capture: true, passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushOnLeave();
  }, { capture: true, passive: true });

  /* 凭据脱敏：密码字段一律 "***"（红线 7；可扩展 autocomplete cc-* 等）。
     contenteditable 分支（ora-20260917 题1 缺陷2）：富文本元素无 value 属性（el.value 恒 undefined）——
     旧实现 input/change 照发但 value 恒空串 = 知发生不知内容；现 isContentEditable 时走 textContent
     同款脱敏管线（password 判定仍最前——富文本元素带 type=password 属性恒 ***，安全侧倾斜；截 200 与
     value 路径同口径），与 input/textarea 的 value 路径并列。事件字段结构不变，蒸馏侧零感知。 */
  function maskedValue(el) {
    try {
      var t = el && el.getAttribute && String(el.getAttribute('type') || '').toLowerCase();
      if (t === 'password') return '***';
      if (el && el.isContentEditable) return String(el.textContent || '').slice(0, 200); // 富文本：textContent 顶替 value
      return String(el.value || '').slice(0, 200);
    } catch (e) { return ''; }
  }

  var composing = false;
  document.addEventListener('compositionstart', function () { composing = true; }, { capture: true, passive: true });
  document.addEventListener('compositionend', function (e) {
    composing = false;
    send('input', { target: descriptor(e.target, e), value: maskedValue(e.target), ime: true }, e.target); // IME 折叠后的终值
  }, { capture: true, passive: true });

  document.addEventListener('click', function (e) {
    var item = send('click', { target: descriptor(e.target, e) }, e.target); // 第三参 el：定位素材采集入口（V202609220001）
    uiaSchedule('click', item ? item.seq : 0, { x: e.clientX, y: e.clientY }); // uiAppear 触发面（触发点供邻近排序；V202609080017）
  }, { capture: true, passive: true });

  document.addEventListener('dblclick', function (e) {
    var item = send('dblclick', { target: descriptor(e.target, e) }, e.target);
    uiaSchedule('dblclick', item ? item.seq : 0, { x: e.clientX, y: e.clientY });
  }, { capture: true, passive: true });

  // contextmenu（V202609100001 实锤补盲）：右键操作（示例ERP OS 右键订单号搜索）此前是采集盲区；
  // 事件结构参照 click（descriptor 自带 point）——record.js/events.js 零改动，新类型透传。
  // uiAppear 第四触发面（V202609170001 spec 定稿）：右键自定义菜单的 DOM 出现走同一双时刻采样，
  // 与 click 同构（连击各自排布不取消 pending、无去抖）；triggerSeq=同帧 contextmenu seq（时间轴邻近关联）、
  // triggerPoint 透传供容器邻近加权；未 preventDefault 时原生菜单不入页面 DOM → 空 diff 不发射天然抑制。
  document.addEventListener('contextmenu', function (e) {
    var item = send('contextmenu', { target: descriptor(e.target, e) }, e.target);
    uiaSchedule('contextmenu', item ? item.seq : 0, { x: e.clientX, y: e.clientY });
  }, { capture: true, passive: true });

  /* ── 鼠标序列采集（V202609130003，council 合议裁决④）：mousedown/mouseup + 按下期 mousemove + HTML5 DnD 标记 ──
   * 目的：① rightClick 录制闭环——回放侧 rightClick 已落地（V202609130002）、录制侧 contextmenu 已有（V202609100001），
   *   补 button 位面维度后录↔放 round-trip 才完整；② 按下期 move 轨迹 = drag 识别与聚合的原料
   *   （聚合留给【drag 阈值标定】条目——本批只采集不聚合，事件先落流）；③ 真 dragstart 出现 = 真拖动强信号
   *   （librarian 定论：纯鼠标序列不进 drag pipeline，dragstart/drop 是聚合判定的强信号）。
   * 纪律：全 passive + capture、只读采集不合成（isTrusted 红线）；descriptor()/send() 与既有事件同构、零依赖。
   */
  var MOUSE = { MOVE_MIN_MS: 40, MOVE_MIN_DX: 8 }; // 按下期 move 采样双阈值：40ms 或 8px 位移，先到先采
  var dragging = null; // null = 未按下；按下期 = { button, lastT, lastX, lastY }（上次采样基准）
  /** button 位面（0 左/1 中/2 右）：rightClick 录制闭环依赖；异常值一律归 0（左） */
  function buttonOf(e) { return (e.button === 2 || e.button === 1) ? e.button : 0; }
  /** 按下期 move 采样判定（纯函数——selftest #45 以合成事件流模拟双阈值先到先采；不读写闭包状态）：
      距上次采样 ≥40ms 或 位移（欧氏平方）≥8² 即采 */
  function moveSampleDue(lastT, lastX, lastY, now, x, y) {
    var dx = x - lastX, dy = y - lastY;
    return (now - lastT >= MOUSE.MOVE_MIN_MS) || (dx * dx + dy * dy >= MOUSE.MOVE_MIN_DX * MOUSE.MOVE_MIN_DX);
  }
  document.addEventListener('mousedown', function (e) {
    dragging = { button: buttonOf(e), lastT: Date.now(), lastX: e.clientX, lastY: e.clientY };
    send('mousedown', { button: buttonOf(e), target: descriptor(e.target, e) });
  }, { capture: true, passive: true });
  // mousemove：全程监听但未按下即返回（热路径一次引用比较，零布局读）；按下期按双阈值节流采样——轨迹用于
  // drag 识别与聚合，非全程画面采集
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    if (!moveSampleDue(dragging.lastT, dragging.lastX, dragging.lastY, Date.now(), e.clientX, e.clientY)) return;
    dragging.lastT = Date.now(); dragging.lastX = e.clientX; dragging.lastY = e.clientY;
    send('mousemove', { button: dragging.button, target: descriptor(e.target, e) });
  }, { capture: true, passive: true });
  document.addEventListener('mouseup', function (e) {
    dragging = null; // 按下期结束（mouseup 本身必录——按钮序列原始位面，不依赖 dragging 状态）
    send('mouseup', { button: buttonOf(e), target: descriptor(e.target, e) });
  }, { capture: true, passive: true });
  /** HTML5 DnD 标记：只记 DataTransfer types 不记数据（防敏感内容入流——红线同密码字段脱敏） */
  function dndTypes(e) {
    try {
      var ts = e.dataTransfer && e.dataTransfer.types;
      var out = [];
      for (var i = 0; ts && i < ts.length && out.length < 8; i++) out.push(String(ts[i]).slice(0, 40));
      return out;
    } catch (e2) { return []; }
  }
  document.addEventListener('dragstart', function (e) {
    send('dragstart', { types: dndTypes(e), target: descriptor(e.target, e) });
  }, { capture: true, passive: true });
  document.addEventListener('drop', function (e) {
    send('drop', { types: dndTypes(e), target: descriptor(e.target, e) });
  }, { capture: true, passive: true });

  document.addEventListener('input', function (e) {
    if (composing) return; // IME 期间折叠
    send('input', { target: descriptor(e.target, e), value: maskedValue(e.target) }, e.target);
  }, { capture: true, passive: true });

  document.addEventListener('change', function (e) {
    if (composing) return;
    send('change', { target: descriptor(e.target, e), value: maskedValue(e.target) }, e.target);
  }, { capture: true, passive: true });

  /* ── 剪贴板监听（ora-20260917 题1 步骤1，报告 1.5 设计定稿）──
   * paste：clipboardData 在事件处理器内同步可读（规范保证，零权限）；getData('text/plain') 后过 clipMask 脱敏；
   * copy/cut：clipboardData 是写入面读不到默认内容 → 内容源 = 选区 window.getSelection().toString()
   *   （copy 时刻选区尚未清除，零权限）；cut 同构（后续 input/change 自然记录删除结果）。
   * 脱敏三档 CLIP_POLICY（报告 1.5.2）：text（默认）非 password 目标内容截 200 入流（maskedValue 同口径）+ len
   *   原始全长；masked 恒 ***（保留 len）；meta 仅 len（内容零入流）。
   * password 目标恒 ***（红线 7——paste 到密码框时 clipboardData 是明文密码，独立过 type=password 判定）。
   * files：只记类型名 ≤8×40 字符（红线同 DnD dndTypes——文件内容不入流）。
   * 每事件带 policy 元字段（蒸馏/取证可感知脱敏档位——防"看到内容误当全量"）。 */
  /** password 目标判定（maskedValue 同款 type=password 口径——paste/copy text 字段独立过同一判定；
      不复用 maskedValue 本体：其 el.value/textContent 分支对剪贴板场景语义不符，且 selftest #54 直测要求其自包含） */
  function isPasswordTarget(el) {
    try {
      var t = el && el.getAttribute && String(el.getAttribute('type') || '').toLowerCase();
      return t === 'password';
    } catch (e) { return false; }
  }
  /** 剪贴板文本脱敏纯函数（selftest #56 直测）：policy 三档 + password 判定单点。
      len 恒为原始全长不截断（"粘了多少"独立取证信号——Excel 500 行 vs 粘单号一眼可分），截断只作用于 text */
  function clipMask(raw, policy, password) {
    var len = (typeof raw === 'string') ? raw.length : 0;
    if (password || policy === 'masked') return { text: '***', len: len }; // password 判定优先于一切档位（红线 7）
    if (policy === 'meta') return { text: '', len: len };                  // meta 档：内容零入流，仅长度
    return { text: String(raw || '').slice(0, 200), len: len };            // text 档（默认）：截 200 与 maskedValue 同口径
  }
  /** 粘贴类型名（types-only 红线——ClipboardEvent 的 clipboardData.types，同 dndTypes 口径 ≤8×40 字符） */
  function clipTypes(e) {
    try {
      var ts = e.clipboardData && e.clipboardData.types;
      var out = [];
      for (var i = 0; ts && i < ts.length && out.length < 8; i++) out.push(String(ts[i]).slice(0, 40));
      return out;
    } catch (e2) { return []; }
  }
  /** 选区文本（copy 时刻选区尚未清除，零权限；password 框选区浏览器天然返回掩码/空——isPasswordTarget 双保险兜底） */
  function selectionText() {
    try { return String((window.getSelection && window.getSelection().toString()) || ''); } catch (e) { return ''; }
  }
  document.addEventListener('paste', function (e) {
    var raw = '';
    try { raw = String((e.clipboardData && e.clipboardData.getData('text/plain')) || ''); } catch (e2) { raw = ''; } // 事件内同步读取，异常尽力而为
    var m = clipMask(raw, CLIP_POLICY, isPasswordTarget(e.target));
    send('paste', { target: descriptor(e.target, e), text: m.text, len: m.len, files: clipTypes(e), policy: CLIP_POLICY }, e.target);
  }, { capture: true, passive: true });
  document.addEventListener('copy', function (e) {
    var m = clipMask(selectionText(), CLIP_POLICY, isPasswordTarget(e.target));
    send('copy', { target: descriptor(e.target, e), text: m.text, len: m.len, policy: CLIP_POLICY });
  }, { capture: true, passive: true });
  document.addEventListener('cut', function (e) {
    var m = clipMask(selectionText(), CLIP_POLICY, isPasswordTarget(e.target));
    send('cut', { target: descriptor(e.target, e), text: m.text, len: m.len, policy: CLIP_POLICY });
  }, { capture: true, passive: true });

  /* ── full 档扩展监听（ora-20260917 题1 步骤4：分层录制 opt-in；PROFILE==='full' 才注册——semantic 默认档零注册）──
   * 过度录制边界（报告 1.3/1.7）：wheel（滚轮是输入、scroll 是结果——结果位面 semantic 已覆盖，输入位面归 full；
   *   200ms 窗口 trailing 累计 delta 压缩——事件膨胀预算 <20%）；focusin/focusout（焦点变迁取证——click/keydown
   *   descriptor 隐含焦点上下文的显性化）；auxclick（中键业务罕见，button 位面取证补盲）。
   * F1-F12 keydown 在下方 keydown handler 内按 PROFILE 分流（full 档才记）。
   * full 档事件 = 取证原料，蒸馏默认不映射 flow（同鼠标序列"原料不消费"先例）。 */
  if (PROFILE === 'full') {
    var wheelAcc = { dx: 0, dy: 0, el: null, timer: null };
    window.addEventListener('wheel', function (e) {
      wheelAcc.dx += e.deltaX || 0; wheelAcc.dy += e.deltaY || 0; wheelAcc.el = e.target;
      if (wheelAcc.timer) return; // 窗口已开：只累计不发射（trailing 统一发射——无损压缩）
      wheelAcc.timer = setTimeout(function () {
        var dx = Math.round(wheelAcc.dx), dy = Math.round(wheelAcc.dy), el = wheelAcc.el;
        wheelAcc.timer = null; wheelAcc.dx = 0; wheelAcc.dy = 0; wheelAcc.el = null;
        if (!dx && !dy) return; // 零累计不发（防噪声）
        send('wheel', { dx: dx, dy: dy, target: (el && el.nodeType === 1) ? descriptor(el) : null });
      }, 200);
    }, { capture: true, passive: true });
    document.addEventListener('focusin', function (e) { send('focusin', { target: descriptor(e.target, e) }); }, { capture: true, passive: true });
    document.addEventListener('focusout', function (e) { send('focusout', { target: descriptor(e.target, e) }); }, { capture: true, passive: true });
    document.addEventListener('auxclick', function (e) {
      var b = buttonOf(e); // button 位面（0 左/1 中/2 右）；经临时变量发射，不与 mouse 序列三记录点的源码计数（selftest #45）耦合
      send('auxclick', { button: b, target: descriptor(e.target, e) });
    }, { capture: true, passive: true });
  }

  /* ── keydown 白名单（ora-20260917 题1 步骤2，Playwright codegen _shouldGenerateKeyPressFor 本土化）──
   * 治录放不对称：回放侧 dispatchKey 已支持组合键（modifiers 位掩码，V202609130002）+ 非打印键（KEY_CODES），录制此前只录 Enter/Tab。
   * 判定纯函数 shouldRecordKey（selftest #55 直测）四象限：
   *   ① 组合键全录：ctrl/alt/meta 任一为 true（含 Ctrl+V——paste 事件另有痕，双记录可接受字段互证；Shift 单独不触发——
   *      Shift+a 的 e.key='A' 是打印字符走 input，逐键记录=keylogger 化，报告 1.7 注记；Shift 位面在组合键记录里照实采字段）；
   *   ② Enter/Tab 现状保留（uiAppear 触发面/300ms 去抖语义不动）；
   *   ③ 非打印键白名单（对照回放侧 dispatchKey KEY_CODES 清单——录放闭环）：Escape/Arrow×4/PageUp/PageDown/Home/End/ContextMenu；
   *   ④ 其余不记：单字符打印键（input 值语义覆盖）/纯修饰键/Backspace/Delete（Playwright："changing input,
   *      will handle it there"——报告 §4 不做清单）/F1-F12（归 full 档，上方 PROFILE 分流）。
   * 事件字段补修饰位面平铺布尔 ctrl/alt/meta/shift（蒸馏映射 flow key 原语 'Control+s' 语法——回放侧 parseKeyModifiers
   * 已就绪 Alt=1/Ctrl=2/Meta=4/Shift=8）+ code（物理键码，取证对照用）。 */
  var NONPRINT_KEYS = { Escape: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, ContextMenu: 1 };
  function shouldRecordKey(key, repeat, ctrl, alt, meta) {
    if (repeat) return false;                                // 长按重复恒不录（优先级最高）
    if (ctrl || alt || meta) return true;                    // ① 组合键全录（shift 字段照录，但不单独触发）
    if (key === 'Enter' || key === 'Tab') return true;       // ② 现状语义键保留（uiAppear 触发面不动）
    return !!NONPRINT_KEYS[key];                             // ③ 非打印白名单；④ 其余不记
  }
  document.addEventListener('keydown', function (e) {
    var isFnKey = PROFILE === 'full' && /^F([1-9]|1[0-2])$/.test(String(e.key)); // F1-F12 归 full 档（semantic 不录）
    if (!shouldRecordKey(e.key, e.repeat, e.ctrlKey, e.altKey, e.metaKey) && !isFnKey) return;
    var item = send('keydown', {
      key: e.key, code: e.code || '',
      ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey, shift: !!e.shiftKey, // 修饰位面平铺（蒸馏→'Control+s' 语法）
      target: descriptor(e.target, e),
    });
    if (e.key === 'Enter') { // uiAppear 触发面：Enter 300ms 去抖（连按只采样最后一次）——现状语义零改动
      enterLastSeq = item ? item.seq : 0;
      if (enterTimer) clearTimeout(enterTimer);
      enterTimer = setTimeout(function () { enterTimer = null; uiaSchedule('enter', enterLastSeq); }, UIA.ENTER_DEBOUNCE);
    }
  }, { capture: true, passive: true });

  // scroll（ora-20260917 题1 缺陷1 顺修）：scroll 事件不冒泡但 capture 能收到内部容器滚动（target=容器元素）——
  // 旧实现一律读 window.scrollX/Y，容器滚动时 window 坐标恒不变 → 每次内部滚动都发"坐标没变"的误导性常值
  // 事件（比不记更糟：蒸馏/取证读到假滚动污染流）。修复 = scrollFace 纯函数按事件 target 分滚动面：
  //   ① 元素面（nodeType===1）：读该元素 scrollTop/scrollLeft 真值 + descriptor 容器标识（蒸馏区分窗口/容器
  //      滚动的唯一依据，chromeuse-events/1 不 bump——可选字段 contextmenu 先例）；取不到坐标如实降级不发
  //      事件（不发明数据）；节流按容器 WeakMap 各自 500ms（互不压制、容器移除自动回收）。
  //   ② window/document 面：保持现路径（window.scrollX/Y + 单变量 500ms 节流，零布局读纪律不变）。
  /** 滚动面分类纯函数（selftest #53 直测；零全局引用——元素判定走 nodeType===1，document=9/window=undefined
      天然落 window 面）：返回 {face:'element',x,y,el} | {face:'window'} | {face:'unknown'}（降级面） */
  function scrollFace(e) {
    var tgt = e && e.target;
    if (tgt && tgt.nodeType === 1) { // 元素滚动面（内部容器）
      var sx = tgt.scrollLeft, sy = tgt.scrollTop;
      if (typeof sx === 'number' && isFinite(sx) && typeof sy === 'number' && isFinite(sy)) {
        return { face: 'element', x: Math.round(sx), y: Math.round(sy), el: tgt };
      }
      return { face: 'unknown' }; // 元素面取不到坐标：如实降级（不发明数据——不发误导性事件）
    }
    return { face: 'window' }; // window/document 滚动面：现路径
  }
  var elScrollAt = new WeakMap(); // 元素滚动面节流：按容器各记上次发射时刻（WeakMap 防长会话容器增删泄漏）
  window.addEventListener('scroll', function (e) {
    var c = scrollFace(e);
    if (c.face === 'unknown') return; // 降级：无坐标不发事件
    var now = Date.now();
    if (c.face === 'element') {
      var lastEl = elScrollAt.get(c.el) || 0;
      if (now - lastEl < 500) return; // 先节流后 descriptor（布局读只在放行后发生，≤2 次/秒/容器）
      elScrollAt.set(c.el, now);
      send('scroll', { x: c.x, y: c.y, target: descriptor(c.el) });
      return;
    }
    if (now - lastScroll < 500) return;
    lastScroll = now;
    send('scroll', { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) });
  }, { capture: true, passive: true });

  /* ── uiAppear：UI 状态变迁捕获（V202609080017，council A⁺ 定稿） ──
   * 触发面：click / dblclick / keydown(Enter，300ms 去抖) / contextmenu（V202609170001，无去抖与 click 同构）；
   * 连击各自排布不取消 pending，空 diff 不发射；
   * scroll/input/change 不触发。双时刻采样 t1=700ms / t2=1800ms，累积并集（appearSet 按 sig 追加、rect 取 t2 终值），
   * t2 完成后单发射；settled = t2 与 t1 的 DOM 规模指纹（querySelectorAll('*').length——唯一允许 * 的地方）相同。
   * 差集 = 采样交互元素键集 − lastStable（键 = tag|id|cls|text，不含 rect）；基线缺失时 items=快照全集 + baseline:'missing'。
   * 性能纪律：批量只读循环内无写操作（单次 walk 一次强制布局）；采样全在 setTimeout 回调内，不阻塞事件 flush。
   */
  var UIA = {
    T1: 700, T2: 1800,                    // 双时刻采样点（ms，自触发时刻起算）
    SEL: 'a,button,input,select,textarea,[role],[onclick],[tabindex],li', // scoped 交互元素选择器（禁 * 遍历）
    MAX_CAND: 8000,                       // 候选配额：超出放弃本次采样（fail-soft）
    MAX_DOM: 50000,                       // DOM 规模：超出降级为只 walk 容器门命中子树
    MAX_CONTAINERS: 8, MAX_ITEMS: 12,     // 发射上限：≤8 容器 × ≤12 items
    TEXT_MAX: 24, CTEXT_MAX: 60, CLS_MAX: 80,
    ENTER_DEBOUNCE: 300                   // keydown(Enter) 去抖
  };
  var ROLE_GATES = { menu: 1, listbox: 1, dialog: 1, dropdown: 1, panel: 1, nav: 1 };
  // V202609090003 uiAppear 质量批 #3：cls 关键词 → role 推断表（token 级匹配，命中即返回映射 role）
  var CLS_ROLE_MAP = [
    ['dropdown', 'menu'], ['toolbar', 'toolbar'], ['treeview', 'tree'], ['tabpage', 'tabs'],
    ['layui-layer', 'dialog'], ['modal', 'dialog'], ['drawer', 'dialog'], ['panel', 'panel'],
    ['task-item', 'taskbar'], ['app-item', 'app-grid'],
    // V20260910 扩充（实弹 rec-2026-09-10_05-09-47 unknown×11 治理）：winui 专有类 + 示例ERP实测 cls。
    // 注意既有映射不动；winui-task-item 含 'task-item' 子串、gongqi_tabpage 含 'tabpage' 子串，
    // 按序本可由前两条命中——显式登记以自文档化（token 级 indexOf 语义不变）。
    ['winui-desktop-item', 'desktop'], ['winui-helper-menu', 'menu'], ['winui-helper-switch', 'menu'],
    ['winui-task-item', 'taskbar'], ['gongqi_tabpage', 'tabs'],
  ];
  var lastStable = null;        // 基线：交互元素键集（key → true）；null = 尚未打底
  var seenEver = {};            // 容器 sig 历史全集：命中 → repeat:true（toggle 语义）
  var seenFrames = {};          // V20260910 #4 修复：frame 容器 sig 已知集——打底时已常驻 + 已发射过的 iframe。
                                // 与 seenEver 分立：seenEver 只在发射时登记，而 frame 的 appeared 判定
                                // 不能走主文档键集差集（跨文档内容不在键集里，见 uiaEmit 注释），
                                // 须在打底时刻就登记常驻 iframe，否则每次 uiAppear 都会误报常驻 frame。
  var enterTimer = null;        // Enter 去抖
  var enterLastSeq = 0;

  function uiaKeyOf(tag, id, cls, text) { return tag + '|' + id + '|' + cls + '|' + text; }

  /** cls 截断（V202609090003 质量批 #6）：取前 3 个 token 去哈希噪声（css-1x2y3z 类），再按 CLS_MAX 截断 */
  function uiaClsTrim(el) {
    var raw = '';
    try { raw = String((el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '')); } catch (e) {}
    return raw.split(/\s+/).filter(Boolean).slice(0, 3).join(' ').slice(0, UIA.CLS_MAX);
  }

  /** cls token → role（V202609090003 质量批 #3）：命中 CLS_ROLE_MAP 即返回映射 role，未命中 null */
  function uiaClsRole(el) {
    var cls = '';
    try { cls = String((el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '')).toLowerCase(); } catch (e) {}
    if (!cls) return null;
    for (var i = 0; i < CLS_ROLE_MAP.length; i++) {
      if (cls.indexOf(CLS_ROLE_MAP[i][0]) !== -1) return CLS_ROLE_MAP[i][1];
    }
    return null;
  }

  /** 容器门（beta）：div/ul/nav 且 ≥2 可见子元素，或 role∈门集；返回推断的 role 或 null（非容器）。
      V202609090003 质量批 #3：vis≥2 时优先查 cls 关键词映射（dropdown→menu/layui-layer→dialog 等） */
  function uiaContainerRole(el) {
    var role = '';
    try { role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase(); } catch (e) {}
    var tag = '';
    try { tag = String(el.tagName || '').toLowerCase(); } catch (e) {}
    if (role && ROLE_GATES[role]) return role;
    if (tag === 'div' || tag === 'ul' || tag === 'nav') {
      var vis = 0;
      var kids = null;
      try { kids = el.children; } catch (e) {}
      for (var i = 0; kids && i < kids.length && vis < 2; i++) {
        var r = null;
        try { r = kids[i].getBoundingClientRect(); } catch (e) {}
        if (r && r.width >= 1 && r.height >= 1) vis++;
      }
      if (vis >= 2) {
        if (role) return role;                    // 有 role 但不在门集：保留原值
        var clsRole = uiaClsRole(el);
        if (clsRole) return clsRole;              // cls 关键词映射优先于标签推断
        return tag === 'nav' ? 'nav' : (tag === 'ul' ? 'list' : 'unknown'); // 无 role 按标签推断，未知记 unknown
      }
    }
    return null;
  }

  function uiaVisibleRect(el) {
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) {}
    if (!r || r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  /** items 嵌套归并（V202609090003 质量批 #1）：B 的 rect 被 A 包含（B 面积 ≥80% 落入 A）且（text 相同或
      B.text 空）→ 丢 B；a/button 优先保留（B 是 a/button 而 A 不是 → 改丢 A）。消灭「导出」×3 式 li>a>div 三层同位堆叠 */
  function uiaDedupeNested(cand) {
    var drop = {};
    for (var i = 0; i < cand.length; i++) {
      var b = cand[i];
      for (var j = 0; j < cand.length; j++) {
        if (i === j) continue;
        var a = cand[j];
        var ix = Math.max(0, Math.min(b.rect.x + b.rect.w, a.rect.x + a.rect.w) - Math.max(b.rect.x, a.rect.x));
        var iy = Math.max(0, Math.min(b.rect.y + b.rect.h, a.rect.y + a.rect.h) - Math.max(b.rect.y, a.rect.y));
        var bArea = b.rect.w * b.rect.h;
        if (bArea <= 0 || (ix * iy) / bArea < 0.8) continue;
        var sameOrEmpty = (b.item.text === a.item.text) || !b.item.text;
        if (!sameOrEmpty) continue;
        var bPri = (b.item.tag === 'a' || b.item.tag === 'button') ? 1 : 0;
        var aPri = (a.item.tag === 'a' || a.item.tag === 'button') ? 1 : 0;
        if (bPri > aPri) { drop[a.key] = true; } // B 优先级更高 → 改丢 A（B 可能随后被更外层丢，drop 集合兜底）
        else { drop[b.key] = true; break; }      // A 同级或更高 → 丢 B
      }
    }
    return cand.filter(function (c) { return !drop[c.key]; });
  }

  /** 两矩形交集占 A 面积比（容器抑制用） */
  function uiaContainment(a, b) {
    var ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    var iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    var aArea = a.w * a.h;
    return aArea > 0 ? (ix * iy) / aArea : 0;
  }

  /** 容器加权排序（V202609090003 质量批 #5）：新键数（相对 lastStable；基线缺失=全集）为主、
      与 trigger point 距离为辅（点击点附近的弹出层优先）——确定性打分，禁声明序耦合 */
  function uiaWeightedSort(conts, triggerPoint) {
    function score(c) {
      var newCount = 0;
      for (var i = 0; i < c.cand.length; i++) {
        if (!lastStable || !lastStable[c.cand[i].key]) newCount++;
      }
      if (!lastStable) newCount = c.cand.length;
      if (c.role === 'frame' && !seenFrames[c.sig]) newCount += 1; // V20260910 #4 修复：新 frame 视同含新键参与排序——
                                                                   // frame 主文档侧 cand 常为空（内容跨文档），
                                                                   // 不加成会被新 items 容器压到 8 容器截断线之外
      var d = 5000;
      if (triggerPoint && Number.isFinite(triggerPoint.x) && Number.isFinite(triggerPoint.y)) {
        var dx = Math.max(0, Math.max(c.rect.x - triggerPoint.x, triggerPoint.x - (c.rect.x + c.rect.w)));
        var dy = Math.max(0, Math.max(c.rect.y - triggerPoint.y, triggerPoint.y - (c.rect.y + c.rect.h)));
        d = Math.sqrt(dx * dx + dy * dy);
      }
      return newCount * 10000 - Math.min(d, 5000);
    }
    conts.sort(function (p, q) { return score(q) - score(p) || q.cand.length - p.cand.length; });
  }

  /** 单次采样：返回 { quotaExceeded, degraded, keys:{key:true}, containers:[{sig,role,rect,text,items}] }。
      批量只读循环内无写操作——scoped 查询+rect 读取一次完成（单次强制布局）。
      V202609090003 质量批：#1 容器内 items 嵌套归并 / #2 容器抑制（零 items 不发射+内层同 role 包含跳过）
      与 rect 收缩为 cand 包围盒 / #4 主文档把可见 iframe 收为 role:'frame' 容器（rect+src 摘要）/
      #5 触发点邻近加权排序（triggerPoint 自 uiaSchedule 传入） */
  function uiaSampleOnce(triggerPoint) {
    var out = { quotaExceeded: false, degraded: false, keys: {}, containers: [] };
    var domCount = 0;
    try { domCount = document.querySelectorAll('*').length; } catch (e) {} // DOM 规模指纹（唯一允许 * 处）
    if (domCount > UIA.MAX_DOM) out.degraded = true;
    // ① 交互元素集（scoped；降级模式下跳过全页扫描，只从容器子树收集）
    var els = null;
    if (!out.degraded) {
      try { els = document.querySelectorAll(UIA.SEL); } catch (e) { els = null; }
      if (els && els.length > UIA.MAX_CAND) { out.quotaExceeded = true; return out; } // 配额纪律：放弃本次采样
    }
    var items = []; // {key, item:{tag,text,cls,rect}, rect}
    function collectItem(el) {
      var tag = '', id = '', cls = '', text = '';
      try { tag = String(el.tagName || '').toLowerCase(); } catch (e) {}
      try { id = el.id || ''; } catch (e) {}
      cls = uiaClsTrim(el); // 质量批 #6：前 3 token 去哈希噪声
      try { text = String((el.innerText !== undefined ? el.innerText : el.textContent) || '').trim().slice(0, UIA.TEXT_MAX); } catch (e) {}
      var rect = uiaVisibleRect(el);
      if (!rect) return;
      var key = uiaKeyOf(tag, id, cls, text);
      if (out.keys[key]) return;
      out.keys[key] = true;
      items.push({ key: key, item: { tag: tag, text: text, cls: cls, rect: rect }, rect: rect });
    }
    if (els) { for (var i = 0; i < els.length; i++) collectItem(els[i]); }
    // ② 容器门扫描（scoped 查询 div,ul,nav,[role]——非 * 遍历）
    var contEls = null;
    try { contEls = document.querySelectorAll('div,ul,nav,[role]'); } catch (e) { contEls = null; }
    var conts = [];
    if (contEls) {
      for (var j = 0; j < contEls.length && conts.length < UIA.MAX_CONTAINERS * 6; j++) {
        var ce = contEls[j];
        var crole = uiaContainerRole(ce);
        if (!crole) continue;
        var crect = uiaVisibleRect(ce);
        if (!crect) continue;
        var ctext = '';
        try { ctext = String((ce.innerText !== undefined ? ce.innerText : ce.textContent) || '').trim().slice(0, UIA.CTEXT_MAX); } catch (e) {}
        var cid = '', ccls = '', ctag = '';
        try { cid = ce.id || ''; } catch (e) {}
        ccls = uiaClsTrim(ce); // 质量批 #6
        try { ctag = String(ce.tagName || '').toLowerCase(); } catch (e) {}
        conts.push({
          sig: uiaKeyOf(ctag, cid, ccls, ctext) + '|' + crole,
          role: crole, rect: crect, text: ctext,
          el: ce, cand: []
        });
      }
    }
    // 质量批 #4 跨文档关联：主文档把可见 iframe 元素收为 role:'frame' 容器（rect + src 摘要）——
    // click 的 uiAppear 出现 frame 容器即明示"点击开了 iframe 层"，与该 iframe 的 load 首采样衔接。
    // V20260910 修复配套（见文件头）：frame 容器零 items 豁免 + rect 不收缩 + 新 frame 首现即 appeared
    // + 排序加成（uiaWeightedSort）——四处缺一，单收进 conts 会被后处理/差集/截断三路静默吞掉（实弹实证）
    if (window === window.top) {
      var ifr = null;
      try { ifr = document.querySelectorAll('iframe,frame'); } catch (e) { ifr = null; }
      for (var f = 0; ifr && f < ifr.length && conts.length < UIA.MAX_CONTAINERS * 6 + 4; f++) {
        var fe = ifr[f];
        var frect = uiaVisibleRect(fe);
        if (!frect) continue;
        var fid = '', fsrc = '';
        try { fid = fe.id || fe.name || ''; } catch (e) {}
        try { fsrc = String(fe.src || '').slice(0, UIA.CTEXT_MAX); } catch (e) {}
        conts.push({
          sig: uiaKeyOf('iframe', fid, '', fsrc) + '|frame',
          role: 'frame', rect: frect, text: fsrc ? 'iframe ' + fsrc : 'iframe',
          el: fe, cand: []
        });
      }
    }
    // ③ 容器排序：item 多者前（有意义的弹出层），截 ≤8；降级模式在容器子树内补收集 items
    if (out.degraded && conts.length) {
      for (var k = 0; k < conts.length; k++) {
        try {
          var sub = conts[k].el.querySelectorAll(UIA.SEL);
          for (var m = 0; m < sub.length && conts[k].cand.length < UIA.MAX_ITEMS; m++) collectItem(sub[m]);
        } catch (e) { /* 子树收集尽力而为 */ }
      }
    }
    for (var a = 0; a < items.length; a++) {
      var it = items[a];
      var cx = it.rect.x + it.rect.w / 2, cy = it.rect.y + it.rect.h / 2;
      for (var b = 0; b < conts.length; b++) {
        var cr = conts[b].rect;
        if (cx >= cr.x && cx <= cr.x + cr.w && cy >= cr.y && cy <= cr.y + cr.h) { conts[b].cand.push(it); break; }
      }
    }
    // 质量批后处理：#1 嵌套归并 → 空文本 items 过滤（V202609100001）→ #2① 零 items 容器不发射（frame 豁免）→ #2③ rect 收缩为 cand 包围盒（frame 不收缩）
    var kept = [];
    for (var c1 = 0; c1 < conts.length; c1++) {
      var cc = conts[c1];
      cc.cand = uiaDedupeNested(cc.cand);
      // V202609100001 空文本 items 过滤：图标类纯视觉元素对蒸馏无用（实弹空文本 items 占 28%）——
      // items 内丢弃；frame 不滤（cand 本就常空，豁免逻辑在下方零 items 分支）
      if (cc.role !== 'frame') cc.cand = cc.cand.filter(function (c) { return !!c.item.text; });
      var emptyCand = !cc.cand.length;
      if (emptyCand && cc.role !== 'frame' && !cc.text) continue; // 零 items 且容器无文本 → 丢弃（含 baseline:'missing' 场景）
      // 零 items 但容器 text 非空 → 保留（items=[]，rect=容器自身——下游蒸馏按容器 text 消费）
      // V20260910 #4 修复：frame 零 items 豁免保留——frame 是跨文档容器，内容在 iframe 文档内、
      // 主文档 SEL 采样永远进不了它的 cand（主文档可见 items 的中心若已被更早容器 rect 覆盖则归属前者），
      // 不豁免 = 实弹 11 uiAppear 0 frame 的第一根因
      if (cc.role !== 'frame' && cc.cand.length) {
        var bx = cc.cand[0].rect, bb = { x: bx.x, y: bx.y, w: bx.w, h: bx.h };
        for (var c2 = 1; c2 < cc.cand.length; c2++) {
          var r2 = cc.cand[c2].rect;
          var nx = Math.min(bb.x, r2.x), ny = Math.min(bb.y, r2.y);
          bb.w = Math.max(bb.x + bb.w, r2.x + r2.w) - nx; bb.h = Math.max(bb.y + bb.h, r2.y + r2.h) - ny;
          bb.x = nx; bb.y = ny;
        }
        cc.rect = bb;
      } // frame 保留 iframe 真实 rect：cand 只是主文档侧偶然落入的 items，收缩会失真且空 cand 时无从收缩
      kept.push(cc);
    }
    // #5 触发点邻近加权排序 → #2② 内层容器抑制（rect ⊆ 已收录容器 ≥95% 且 role 同 → 跳过）→ 截 ≤8
    uiaWeightedSort(kept, triggerPoint);
    var final = [];
    for (var c3 = 0; c3 < kept.length && final.length < UIA.MAX_CONTAINERS; c3++) {
      var cand = kept[c3];
      var covered = false;
      for (var c4 = 0; c4 < final.length; c4++) {
        if (final[c4].role !== cand.role) continue;
        if (uiaContainment(cand.rect, final[c4].rect) >= 0.95) { covered = true; break; }
      }
      if (!covered) final.push(cand);
    }
    out.containers = final.map(function (c) {
      return { sig: c.sig, role: c.role, rect: c.rect, text: c.text, cand: c.cand.slice(0, UIA.MAX_ITEMS) };
    });
    return out;
  }

  /** 双时刻采样调度（t1/t2 独立 setTimeout，共用闭包累积状态；连击各自排布——互不取消）。
      V202609090003 质量批 #5：triggerPoint（click/dblclick 的 clientX/Y）透传采样做邻近加权 */
  function uiaSchedule(triggerType, triggerSeq, triggerPoint) {
    var t1Dom = -1;
    var acc = {};       // 累积并集：容器 sig → 容器（rect/items 取后采样终值）
    var accOrder = [];  // sig 首现顺序（发射稳定）
    var t1Keys = null;  // t1 键集（settled 比较用 DOM 指纹；键集供基线合并）
    function merge(s) {
      for (var i = 0; i < s.containers.length; i++) {
        var c = s.containers[i];
        if (!acc[c.sig]) { acc[c.sig] = c; accOrder.push(c.sig); }
        else { acc[c.sig].rect = c.rect; acc[c.sig].text = c.text; acc[c.sig].cand = c.cand; } // rect 取 t2 终值
      }
    }
    setTimeout(function () { // t1
      try {
        var s1 = uiaSampleOnce(triggerPoint);
        if (s1.quotaExceeded) return; // 配额放弃：本次不发射（键集也不更新基线）
        t1Dom = 0;
        try { t1Dom = document.querySelectorAll('*').length; } catch (e) {}
        merge(s1);
        t1Keys = s1.keys;
      } catch (e) { /* 采样失败静默——下时刻兜底 */ }
    }, UIA.T1);
    setTimeout(function () { // t2：合并 + 差集 + 单发射 + 基线更新
      try {
        var s2 = uiaSampleOnce(triggerPoint);
        if (!s2.quotaExceeded) merge(s2);
        var domCount = 0;
        try { domCount = document.querySelectorAll('*').length; } catch (e) {}
        var settled = (t1Dom >= 0 && t1Dom === domCount);
        uiaEmit(acc, accOrder, triggerType, triggerSeq, settled, t1Keys === null ? null : s2.quotaExceeded ? t1Keys : s2.keys);
      } catch (e) { /* 尽力而为 */ }
    }, UIA.T2);
  }

  /** 差集 + 发射：appeared 容器 = 含 ≥1 新 item 键（相对 lastStable）的容器；items=容器采样快照全集；
      基线缺失 → 全容器发射 + baseline:'missing'；空 diff 不发射；seenEver 命中 → repeat:true；随后更新基线 */
  function uiaEmit(acc, accOrder, triggerType, triggerSeq, settled, curKeys) {
    var baselineMissing = (lastStable === null);
    var outContainers = [];
    for (var i = 0; i < accOrder.length; i++) {
      var c = acc[accOrder[i]];
      var appeared = baselineMissing;
      if (!baselineMissing) {
        // V20260910 #4 修复：frame 容器 appeared 判定不走主文档键集差集——iframe 的内容在另一文档，
        // 主文档键集永远不含它（iframe 内元素由 iframe 自身 recorder 实例独立采样发射），
        // 差集对 frame 恒为空 = 第二根因。新 frame（seenFrames 未登记）首现即 appeared。
        if (c.role === 'frame' && !seenFrames[c.sig]) appeared = true;
        if (!appeared) {
          for (var j = 0; j < c.cand.length; j++) { if (!lastStable[c.cand[j].key]) { appeared = true; break; } }
        }
      }
      if (!appeared) continue;
      var items = [];
      for (var k = 0; k < c.cand.length; k++) {
        items.push({ tag: c.cand[k].item.tag, text: c.cand[k].item.text, cls: c.cand[k].item.cls, rect: c.cand[k].item.rect });
      }
      outContainers.push({ sig: c.sig, role: c.role, rect: c.rect, text: c.text, repeat: !!seenEver[c.sig], items: items });
    }
    // 基线更新（每次采样完成后）：本次键集并入 lastStable
    if (curKeys) {
      if (lastStable === null) lastStable = {};
      for (var kk in curKeys) if (Object.prototype.hasOwnProperty.call(curKeys, kk)) lastStable[kk] = true;
    }
    if (!outContainers.length) return; // 空 diff 不发射
    for (var s = 0; s < outContainers.length; s++) {
      seenEver[outContainers[s].sig] = true; // seenEver 签名防重复（toggle 语义）
      if (outContainers[s].role === 'frame') seenFrames[outContainers[s].sig] = true; // V20260910 #4：frame 已发射即登记（同 frame 不再因 frame 语义重复 appeared）
    }
    var ev = { triggerSeq: triggerSeq || 0, triggerType: triggerType, settled: !!settled, containers: outContainers };
    if (baselineMissing) ev.baseline = 'missing';
    send('uiAppear', ev);
  }

  // 顶层帧：load+600ms 打底一次基线（不发射）；iframe：自身 load 后 ~700ms 首采样并发射（triggerType:'load'，triggerSeq:0）
  if (window === window.top) {
    var uiaBaseline = function () {
      setTimeout(function () {
        try {
          var s = uiaSampleOnce();
          if (s.quotaExceeded) return;
          lastStable = {};
          for (var k in s.keys) if (Object.prototype.hasOwnProperty.call(s.keys, k)) lastStable[k] = true;
          // V20260910 #4：打底时刻已可见的 iframe = 常驻 frame（示例ERP OS layui-layer-iframe 常驻实测），
          // 登记 seenFrames 视为旧——此后首次点击不得把它们当"新开的 iframe 层"误报
          for (var fi = 0; fi < s.containers.length; fi++) {
            if (s.containers[fi].role === 'frame') seenFrames[s.containers[fi].sig] = true;
          }
        } catch (e) { /* 打底失败 → 后续 baseline:'missing' 降级 */ }
      }, 600);
    };
    if (document.readyState === 'complete') uiaBaseline();
    else window.addEventListener('load', uiaBaseline, { capture: true, passive: true, once: true });
  } else {
    var uiaIframeFirst = function () {
      setTimeout(function () {
        try {
          var s = uiaSampleOnce();
          if (s.quotaExceeded) return;
          if (RE_INJECT) { // V202609090003 批2：重注入静默重打底（不发伪 load uiAppear）
            lastStable = {};
            for (var kk in s.keys) if (Object.prototype.hasOwnProperty.call(s.keys, kk)) lastStable[kk] = true;
            return;
          }
          var acc = {}, order = [];
          for (var i = 0; i < s.containers.length; i++) { acc[s.containers[i].sig] = s.containers[i]; order.push(s.containers[i].sig); }
          uiaEmit(acc, order, 'load', 0, false, s.keys); // 单时刻采样：settled=false
        } catch (e) { /* 尽力而为 */ }
      }, 700);
    };
    if (document.readyState === 'complete') uiaIframeFirst();
    else window.addEventListener('load', uiaIframeFirst, { capture: true, passive: true, once: true });
  }

  // navigation：history API 包装 + popstate + load（录导航轨迹）
  function nav(kind) {
    send('navigate', { url: String(location.href).slice(0, 300), kind: kind });
  }
  try {
    var push = history.pushState, replace = history.replaceState;
    history.pushState = function () { var r = push.apply(this, arguments); nav('pushState'); return r; };
    history.replaceState = function () { var r = replace.apply(this, arguments); nav('replaceState'); return r; };
  } catch (e) { /* history 不可包装时降级 */ }
  window.addEventListener('popstate', function () { nav('popstate'); }, { capture: true, passive: true });
  window.addEventListener('hashchange', function () { nav('hashchange'); }, { capture: true, passive: true });
  if (document.readyState === 'complete') { if (!RE_INJECT) nav('load'); } // reInject：静默重注入不发伪 load-navigate
  else window.addEventListener('load', function () { if (!RE_INJECT) nav('load'); }, { capture: true, passive: true, once: true });

  window.__chromeuseRecorder = {
    version: 'chromeuse-events/1', frame: FRAME, tab: TAB, targetId: TARGET_ID, flush: flush,
    // V202609090003 批2：beat()——哨兵探针用（只读零布局：返回文档代际/事件序号/frame 路径，供活性与一致性核验）
    beat: function () { return { docId: DOC_ID, seq: seq, frame: FRAME }; },
  };

  /* 存量同源子帧补注入（主世界自传播；新挂 frame 由 initScript 自动覆盖——S1 实测） */
  if (window === window.top && window.__CHROMEUSE_RECORDER_SRC) {
    var propagate = function () {
      try {
        (function walk(d) {
          var fr = d.querySelectorAll('iframe,frame');
          for (var i = 0; i < fr.length; i++) {
            var inner = null;
            try { inner = fr[i].contentDocument; } catch (e) { /* 跨域跳过 */ }
            if (inner && inner.defaultView && !inner.defaultView.__chromeuseRecorder) {
              var s = inner.createElement('script');
              s.textContent = 'window.__CHROMEUSE_RECORDER_CFG=' + JSON.stringify(CFG) + ';' + window.__CHROMEUSE_RECORDER_SRC;
              try { (inner.head || inner.documentElement).appendChild(s); } catch (e) { /* CSP 拒入则跳过 */ }
            }
            if (inner) walk(inner);
          }
        })(document);
      } catch (e) { /* 遍历失败不致命 */ }
    };
    setTimeout(propagate, 500);
    setTimeout(propagate, 2500);
  }
})();
