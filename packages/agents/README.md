# Agents

MOD-04B（后续负责人 `zemeng`）当前继承 MOD-04 历史工作包的单主 Agent 有界执行循环：模型返回最终回答或结构化工具提案，提案经工具描述和参数校验后，通过 `RuntimeToolInvoker` 发送公开的 `tool.invoke` 请求。历史实现由 `goo122` 交付，归属不追溯改写。

本包拥有 `AgentWorkerContext`、`AgentToolInvocation` 等消费端口，不依赖具体 Runtime 应用。Runtime 提供结构兼容的上下文和公共请求通道完成接入；这保持 `packages → apps` 的单向依赖边界。当前 Agent API 为 `provisional`，`AgentRunOptions.model` 仍接受具体 `ModelGateway`；计划中的 ModelPort、ToolExecutionPort 与 CoordinationPort 尚未交付，均为 `unavailable`。

执行边界包括 `maxSteps`、deadline、取消信号和一次默认提案修复机会；可信宿主可选传入 `maxTokens` 来增加本地 Token 预算。未配置时 Agent 不另设 Token 上限，仍受模型服务的上下文窗、输出限制和账户配额约束。授权引用由可信宿主通过 `authorizationRefFor` 提供，模型不得自行生成授权。工具返回 `unknown` 时必须由宿主转入 `waiting_reconciliation`，不能生成成功回答。

本包的测试只使用 Fake 模型、Fake 天气 Provider 和本地 Runtime；这不代表真实盘古或第三方平台已连通，也不构成模型工具调用冻结证据。状态与待交付端口见[当前接口目录](../../docs/interfaces/CURRENT_INTERFACE_CATALOG.md)。

Runtime Application 可通过 `AgentRunOptions.initialMessages` 注入已由 Runtime 选定的对话上下文。Agent 只负责把这些消息与当前目标组成模型请求；恢复任务时，已持久化的 `agent-loop` 检查点优先于新的初始消息，避免重复执行或改变原有工具提案。
