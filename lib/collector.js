'use strict';
/*
 * chromeuse lib/collector.js —— 零依赖 HTTP 收数服务（beacon 子命令 / record 采集端共用）
 *
 * - 只收 POST；其余 404。/__stop 保留端点：record-stop 跨进程触发优雅停止
 *   （V202609080013：stopping 只挡 onStop 重入——/__stop 之后的 beacon payload 照常处理到 server close，
 *   防"停止窗口"丢数据；record 二次补尾依赖这一语义）
 * - 默认绑 0.0.0.0（架构 v3 NAS 路由修正）：chrome-browser 容器经 coding-envs 内网
 *   fetch http://opencode:9999 可达本容器；私网环境、无宿主端口映射（R34 暴露面可控、用完即关）
 * - onPayload 回调优先；否则打印截断预览；dumpDir 提供时逐条落盘
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const time = require('./time');

/**
 * 启动收数服务。opts：{ host, port, dumpDir, onPayload(url,text), onStop(), quiet }
 * 返回 Promise<{ server, port, payloads, stop }>；payloads = [{url, at, text}]
 */
function startCollector(opts) {
  const o = opts || {};
  const payloads = [];
  let stopping = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // sendBeacon/fetch 跨域上报（响应可读性；请求本身不受限）
    if (req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => { try { res.statusCode = 400; res.end(); } catch { /* 已断 */ } });
    req.on('end', () => {
      try { res.statusCode = 204; res.end(); } catch { /* 已断 */ }
      const text = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/__stop') {
        // stopping 只挡 onStop 重入（record.stopAll 自身另有 stopping 守卫）；payload 处理不挡——直到 server close
        if (o.onStop && !stopping) { stopping = true; o.onStop(); }
        return;
      }
      const item = { url: req.url, at: time.isoLocal(), text }; // at = 显示字段（配置时区，默认 UTC+8）
      payloads.push(item);
      if (o.dumpDir) {
        try {
          fs.mkdirSync(o.dumpDir, { recursive: true });
          // 文件命名时间戳单源 lib/time.js（配置时区）；payloads.length 单调递增保同秒唯一
          const f = path.join(o.dumpDir, `beacon-${time.formatStamp()}-${payloads.length}.json`);
          fs.writeFileSync(f, text);
          if (!o.quiet) console.log(`[beacon] ${req.url} ← ${text.length} 字节 → ${path.basename(f)}`);
        } catch (e) { log.warn('collector', `beacon 落盘失败：${e.message}`); console.error(`[beacon] 落盘失败：${e.message}`); }
      } else if (o.onPayload) {
        o.onPayload(req.url, text);
      } else if (!o.quiet) {
        console.log(`[beacon] ${req.url} ← ${text.length > 2000 ? text.slice(0, 2000) + '…' : text || '（空）'}`);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 9999, o.host || '0.0.0.0', () => {
      log.info('collector', `收数服务启动 http://${o.host || '0.0.0.0'}:${server.address().port}${o.dumpDir ? ` dump=${o.dumpDir}` : ''}${o.onPayload ? '（onPayload 管道）' : ''}`);
      resolve({
        server,
        port: server.address().port,
        payloads,
        stop: () => new Promise((r) => { stopping = true; try { server.close(() => { log.info('collector', `收数服务已停止（端口 ${server.address() && server.address().port || '已关'}）`); r(); }); } catch { r(); } }),
      });
    });
  });
}

module.exports = { startCollector };
