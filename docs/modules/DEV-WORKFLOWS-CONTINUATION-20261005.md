# 新旧 MOD 接续（2026-10-05）

用户要求按 #277 分工接续新旧 MOD、审核待审 PR，外部受阻时推进其他独立任务；最终停止前发送结果邮件。zemeng 串行集成槽 `.worktrees/review-277`，分支 `codex/dev-workflows-continuation`；续交原 #277，初始 head `1a2affa64d991640ca890b1f6196f3617281191a`，main 基线 `330be3862eb7ba9b50709ec8ac0c6292ff7829fd`。保留原作者归属与提交。

## 本轮改动

- 组合 #280（包含 #278）的 Runtime、P5/feeds/通知修复，以及 #281 unknown 补丁观察修正：保留原 marker，不记录未知终态，覆盖重复核实、SQLite 重启和后续 applied。
- 组合 #279 MOD-35 与 #282：源码片段限于原工作区的有界常规文件；仓库外绝对/父路径/file URL/符号链接不返回片段；真实 Node TAP 的堆栈、多行错误、嵌套 subtest、带空格路径正确定位。
- MOD-33/36：发表报告总是传入新的可选 `expectedBaseSha`，GhCliProvider 在 POST 前核对 head/base。复现修复前审批期间 base 漂移仍 POST 一次；修复后零 POST，Runtime 保守等待核实。GitHub 前置读取与写入仍非原子事务。
- MOD-34 Runtime：较大的 CI 共享预算不再触发 Review 32k 单次输出上限而阻止整个宿主启动。只限制 Review 输出，保留 CI 预算；64k 配置启动及审批恢复通过。
- 两项 Desktop 门禁失败来自 Linux 夹具兼容：Windows 路径夹具显式用 win32 basename；环境断言验证各平台白名单，保留 SECRET_TOKEN/GITHUB_KEY 拒绝条件。未放宽生产权限。
- MOD-38 文档/注释纠正为已授权 Local 工作流，不计入比赛验收。无 wire operation、数据库迁移、新依赖或锁文件变化。

## 验证依据

Node 24.15.0 / npm 11.12.1；锁文件安装 `npm ci --ignore-scripts --no-audit --no-fund`。不执行 Electron 安装脚本，不代表真实 UI/native helper 验收。

初始组合 `npm run check` 完成架构、契约夹具、生成一致性、全 workspace 构建/类型及测试，仅上述两项 Desktop 夹具失败；Runtime 306/306，其余 workspace 零失败。修正后 Desktop 完整 342 通过/0 失败/6 跳过，DEV-WORKFLOWS 66/66，根 integration 17/17。最终完整门禁结果见 PR 最新回执，不能把初次失败说成通过。原始本机日志在 `/tmp/personalagent-review/`，未提交。

## 队列与真实完成条件

| 工作包 | 已推进 | 剩余 / 继续入口 |
| --- | --- | --- |
| #278/#280、P5/P7/通知回归 | 已评审、缺陷交 #281、组合消费；保留 Fact review、TrackingGrant 与 unknown 回执断言 | 非作者审核新修复与组合 head、CI 终态、main 集成 |
| MOD-35 (#279) | 已评审、边界与真实 TAP 修正交 #282，定位器 9/9；组合消费 | Potatos498/goo122 非作者评审与 main 集成 |
| MOD-33/34/36/38 (#277) | 公开端口、生产组合和离线链已有实现；本轮恢复/配置缺陷已修正 | 受信 gh 凭据、真实模型、Windows helper；完成 Actions 修复、COMMENT、标签和 Issue 回链真实读回 |
| MOD-37 | goo122 负责；当前无待审实现 PR | 审核后续交付，不代写其目录或另造接口事实源 |
| P5 MOD-27/28、P7 消费 | 当前源码已有正式来源、私有 Fact 审核、Laya 与持久恢复；旧 #273/#275 已合入 | 真实本机/模型/来源变更和 AgentArts 联动；私人出机保持原生授权，不以 Fake 判完成 |
| P6 MOD-16/18 | 保留 Windows 控制、patch/受限命令与恢复；本轮修正 MOD-18 丢 marker | Windows 普通用户设备、目标确认/接管、PowerShell/helper 实际应用和读回 |
| MOD-17 / #116 | Desktop public host/main 已有生产注册；本轮真实 Linux node:os→Runtime/Policy/ToolGateway→confirmed 读回 | Windows 生产授权、Desktop 展示、AgentArts 同请求闭环；不关闭 #116 |
| P8 / MOD-29～32 | 组合源码、必要门禁与交付证据；Competition 默认组合不变 | 受信 AgentArts 配置、真实 deployment/API/trace/评估及本机统一验收；当前会话无 Windows 设备或受信模型/云凭据注入端口 |
| MOD-19、PA-018 | 保持此前排除 | Windows 打包安装及 TraceGuard 治理不在当前包 |

MOD-17 Linux 本轮回执：task `d9be4481-cad0-426f-9259-75047815b437`，run 后缀 `:system-read`；工具 `computer.system.observe@1.0.0`，source=node:os，审批前执行数 0；审批后记录 confirmed/allow/executionStarted=true，任务 succeeded。采样 `2026-10-05T07:47:37.009Z`～`07:47:37.261Z`，251.92ms。脱敏 JSON SHA-256 `fa0564194acdebd4bfa399e1e04371665c0b90fcbab28e5402c37b13db6a5c4c`；本机 SQLite/JSON 保留在忽略的 `.cache/mod17-runtime-*`。不含原始 CPU/内存值、设备身份或凭据；Windows、Desktop UI、AgentArts 验证均为 false。

GitHub 插件评审、发布和邮件发送是开发执行证据，不计作产品 GhCliProvider/模型工作流真实外部验收。非作者评审后才合并；整体 Goal 未完成，外部验收缺项不得抹去。
