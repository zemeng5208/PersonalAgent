# Agents

MOD-04 第一阶段提供单主 Agent 的有界执行循环：模型返回最终回答或结构化工具提案，提案经工具描述和参数校验后，通过 `RuntimeToolInvoker` 发送公开的 `tool.invoke` 请求。

本包拥有 `AgentWorkerContext`、`AgentToolInvocation` 等消费端口，不依赖具体 Runtime 应用。Runtime 提供结构兼容的上下文和公共请求通道完成接入；这保持 `packages → apps` 的单向依赖边界。

执行边界包括 `maxSteps`、deadline、取消信号和一次默认提案修复机会；可信宿主可选传入 `maxTokens` 来增加本地 Token 预算。未配置时 Agent 不另设 Token 上限，仍受模型服务的上下文窗、输出限制和账户配额约束。授权引用由可信宿主通过 `authorizationRefFor` 提供，模型不得自行生成授权。工具返回 `unknown` 时必须由宿主转入 `waiting_reconciliation`，不能生成成功回答。

本包的测试只使用 Fake 模型、Fake 天气 Provider 和本地 Runtime；这不代表真实盘古或第三方平台已连通。
