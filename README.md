# PersonalAgent

面向 Windows 的私人 Agent 助理：以动态悬浮球为入口，由盘古主导推理，结合个人知识、平台连接器与受控电脑操作，提供主动提示和有限自动执行。

项目面向华为 ICT 创新赛准备。核心方向是版本化个人世界状态、事实—决策—计划依赖和事件触发的最小计划修复；盘古与 AgentArts 是模型和云端编排平台，不替代本地授权、执行、读回和 Evidence。

## 当前状态

截至 2026-09-09，MOD-01/02/03/25 及 MOD-04/05 的离线增量已集成；PR #31 已加入 Runtime-owned 会话上下文，PR #34 已完成非作者评审、CI 和合并，Desktop 已通过公开 task/conversation/approval 查询恢复状态。只冻结 [Core Runtime Profile 1](docs/interfaces/CURRENT_INTERFACE_CATALOG.md) 的消息、任务、会话和审批只读查询子集。

整套协议、模型工具调用和 Agent 编排**尚未冻结**。盘古 Provider 当前仅声明非流式文本能力；原生 function calling 未提供，文字 JSON 工具提案没有真实盘古→审批→工具→读回闭环证据。AgentArts、记忆、知识、MCP、Skills、语音、Windows Host 等缺少生产提供者的能力统一登记为 unavailable。尚无完整生产闭环。

## 文档入口

- [产品需求 PRD](docs/PRD.md)：产品范围、需求编号、优先级和验收条件。
- [架构设计](docs/ARCHITECTURE.md)：模块、进程、协议、数据与技术验证项。
- [模块分工](docs/MODULE_ASSIGNMENTS.md)：32 个主模块及 MOD-04A/04B 独占工作面；`Potatos498` 的 MOD-20～26 保持不变。
- [公共开发协议](docs/DEVELOPMENT_PROTOCOL.md)：`goo122` 维护的任务、事件、工具、连接器契约与联调交付要求。
- [当前接口目录](docs/interfaces/CURRENT_INTERFACE_CATALOG.md)：逐接口冻结状态、生产可用性、证据和未提供能力。
- [协作开发规范](CONTRIBUTING.md)：任务分配、分支、PR、评审和完成标准。
- [开发计划与进度](docs/ROADMAP.md)：阶段门槛、首批工作包和当前状态。
- [Agent 协作规则](AGENTS.md)：在本仓库工作的自动化开发者必须遵循的约束。

阅读顺序：PRD → 模块分工 → 当前接口目录 → 公共开发协议 → 架构 → 协作规范 → 开发计划。`goo122` 与 `zemeng` 从同一冻结接口提交使用 Fake 独立开发；`Potatos498` 保持原连接器分工。实现变更必须关联需求编号和验收证据。

## 开发入口

默认通过分支与 Pull Request 协作，不直接向主分支提交实现。当前基线为 Node.js 24.15.0、npm 11.12.1；开发依赖由 package-lock.json 锁定。

在仓库根目录运行（PowerShell 中如脚本策略阻止 npm，可使用 npm.cmd）：

```sh
npm ci
npm run check
npm run dev
npm run demo:protocol
npm run demo:runtime
```

check 校验生成类型一致性，按依赖顺序构建并执行严格类型检查与全部工作区测试。dev 是一次性存储示例；demo:protocol 展示 mock 消费者取消往返和连接器注册；demo:runtime 展示持久任务、检查点、进度和终态事件。这些不是桌面、模型或真实平台启动命令。

MOD-02 接入入口：[contracts](packages/contracts/README.md)、[client](packages/client/README.md)、[testkit 六场景与验证](packages/testkit/README.md)。

MOD-03 接入入口：[Runtime 任务核心](apps/runtime/README.md)。

MOD-05 接入入口：[授权策略](packages/policy/README.md)、[工具网关](packages/tool-gateway/README.md)、[连接器宿主](packages/connector-host/README.md)。

接口状态以 [当前接口目录](docs/interfaces/CURRENT_INTERFACE_CATALOG.md) 为准。Schema 中存在但握手未公布的 operation 不可调用；Fake 成功不能提升为生产可用。

当前源码入口为 packages/storage/src，保留的 src/.gitkeep 不承载另一套实现。模块测试和夹具位于 packages/storage/test；开发缓存与验证产物位于项目内 .cache，并已忽略。详见 [存储包说明](packages/storage/README.md)。

文档相对链接以仓库内位置为准；不在可公开内容中记录个人绝对路径、账号或密钥。
