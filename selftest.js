#!/usr/bin/env node
'use strict';
/*
 * chromeuse selftest.js —— 结构自检入口（thin wrapper；习惯用法 `node selftest.js` 不变）
 * 实现已拆分至 selftest/ 目录：common.js（共享断言框架/helper）+ main.js（通用测试 + webapp 导入清单）
 * + webapps/<slug>.js（webapp 专属断言模块——某 webapp 失效只改对应文件或 main 移除导入，测试仍可运行）。
 * 静态校验；在线验证属 references/install.md §3 会话内步骤。
 * CJS，Node >=16，零第三方依赖。退出码：0 = 全过（warn 不影响）；1 = 任一 fail。
 */
require('./selftest/main.js');
