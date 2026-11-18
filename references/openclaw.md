# chromeuse openclaw —— openclaw 执行端手册（无 omo-slim 双端兼容）

> 定位：openclaw 的 agent（单模型、无 omo-slim 编排）用本 skill 驱动浏览器的最小操作手册。核心思路：**确定性回放优先（零模型、零成本、零漂移），AI 只做规划、蒸馏与 self-heal**——CLI-first + 产物即接口，opencode 与 openclaw 双端同一套 tools/。

## 判定树（接到浏览器任务先走这棵树）

```
1. 任务是什么？
   ├─ 既有 flow 覆盖的回归/录入（webapps/<app>/flows/ 有对应文件）→ ① 档：CLI 直调
   ├─ 新流程 / 一次性操作 → ② 档：交互探索（MCP 或 probe/exec/screenshot 组合）+ 顺产 flow 草案
   └─ 无浏览器条件 / 探索失败 → ③ 档：降级路径（网络域取证 / 非 UI 数据源），不硬刚 UI
2. ① 档执行：node tools/cdp.js flow replay <file>（见模板）→ 成功即完成；失败读结构化报告 self-heal
3. ② 档执行：probe 三通道 → targets 选标签 → screenshot 看态 → 只读 evaluate 定位 → flow 固化
4. 双端并发：执行前 probe 自检浏览器可达；长动作（replay/record）依赖 .chromeuse.lock 互斥
```

## CLI 直调模板（openclaw agent 直接执行的命令形态）

```bash
# 前置自检（秒级、零副作用；Node >=22 才可用工具层）
node --version && node tools/cdp.js probe
node tools/cdp.js targets                                  # 选标签（永不自动开/关既有 tab）
node tools/cdp.js identify --url <url>                     # 应用识别（matchers；exit 0 单命中/3 多命中问人/1 零命中）
# 白名单 flow 回放（推荐形态：指定 vars 注入实值，不落任何凭据）
node tools/cdp.js flow replay webapps/<app>/flows/<file>.flow.json --var 'k=v'
# 失败 → 读 tmpdata/flow-fail/flow-fail-*.json（attempts/candidates/截图）→ 修 flow → retry ≤1 → 再败交人工
# 录制学习（可选）：人类演示后蒸馏，协议见 references/distill.md
node tools/cdp.js record --duration 300000          # 默认全标签页录制；--target <选择器> 降级单页
```

## 白名单 flow（openclaw 侧执行纪律）

- openclaw 只回放**已入库且人机确认过**的 flow（references/distill.md 质量清单），不现场编造 flow 直接跑业务写操作。
- 实值经 `--var` 注入；flow 文件与命令行历史里不得出现凭据（#18b 禁词机检 + 人工纪律）。
- 业务写操作只走 Input 域（flow replay 已保证）；严禁 exec `Runtime.evaluate` 合成事件（isTrusted=false 红线跨端不变）。

## 审计要求

- 每次回放留存：命令行 + flow 文件 + 退出码 + 失败报告（若有）——openclaw 会话日志天然承载，flow 文件本身入库可追溯。
- watch 判定冻结的恢复命令**只能人工执行**（看门狗裁定不自动杀，跨端一致）。

## 安全边界（微信触发远程执行按不可信输入设防）

1. **命令注入面**：`--var k=v` 与文件路径一律作为**数据**传参（引号包裹、不拼 shell 字符串到 eval 类通道）。
2. **flow 来源可信**：只回放 webapps/ 库内 flow（经推广流程入库）；外部传入的 flow 文件先人工审 + `flow validate` + 禁词扫描再考虑执行。
3. **最小权限**：CDP 端口 9222/9224 无认证且禁映射宿主（红线 5）；beacon 用完即关（R34）；openclaw 容器与浏览器同内网即可，不新开通道。
4. **业务写操作闸门**：涉及单据/金额/状态机的 flow 首次执行必须在测试账套（webapps/erp_demo_test「测试账套」语境），结果人工验收后再复用。
5. **降级声明**：openclaw 侧无 chrome-devtools MCP 时少 a11y 快照便利（flow/screenshot/net 兜底），功能有梯度不归零。
