#!/usr/bin/env node
/* selftest/fixtures/grid/serve.js —— C9 虚拟化网格 fixture 零依赖静态服务
 *
 * 用法：node serve.js [port]   （port=0 让内核分配空闲端口；启动后 stdout 打印 `PORT=<n>`）
 * 只读服务 fixture 目录（fixture.html + vendor/*.js），不落盘、不联网。
 * selftest 起停：spawn 本脚本 → 读 PORT= 行 → 用随机端口 URL 开页签 → 跑完 SIGTERM。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 0);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel = '';
  try { rel = decodeURIComponent(String(req.url || '/').split('?')[0]); } catch (e) { rel = '/'; }
  if (rel === '/') rel = '/fixture.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found: ' + rel); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const port = server.address().port;
  console.log('PORT=' + port);
  console.log('[grid-fixture] serving ' + ROOT + ' at http://0.0.0.0:' + port + '/');
});

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
