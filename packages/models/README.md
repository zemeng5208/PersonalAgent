# Models

MOD-04 的模型端口和模型网关。`ModelGateway` 只接受显式配置的 Provider，并在请求前校验文本、工具调用和结构化输出能力；Provider 返回的 deployment、verification 和 usage 会随结果保留。

当前验证等级：

- `FakeModelProvider`：`mock`，仅用于无网络测试。
- `UnavailableModelProvider`：明确返回不可用。
- `PanguModelProvider`：`conditional` 的盘古 V2 文本适配器。使用可信宿主注入的 API Key、base URL 和部署模型；当前不声明流式、工具调用、结构化输出或视觉能力。

模型不能提供 `scopeRef`、凭据或执行函数。工具提案必须由 Agent 根据 Runtime 提供的工具描述重新校验。

`StructuredToolProvider` 是显式的文字 JSON 提案适配器。它将工具目录写入宿主协议提示，严格校验 JSON、提案字段和参数，再交回 Agent；不声明盘古原生 function calling 已验证。Runtime Application 注入工具时为盘古启用该适配。`ModelGateway` 统一强制截止时间与取消，并对非协议异常脱敏；无响应的 Provider 也不能无限阻塞调用。

离线验收和真实验收入口见 [MOD-04/05 验收记录](../../docs/modules/MOD-04-05-ACCEPTANCE.md)。流式输出和 PA-012 专业 Agent 委派仍未完成。

Provider 支持盘古原生 `/api/v2/chat/completions` 和 ModelArts MaaS 的 OpenAI 兼容 Endpoint（例如 `https://api.modelarts-maas.com/openai/v1`，适配器会追加 `/chat/completions`）非流式接口。单元测试只注入 Mock fetch，不发起网络请求；真实账号、Endpoint 和模型部署仍需单独授权验证，不能把本地 Mock 结果当作真实连通证据。

`maxOutputTokens` 是可选的本地请求预算。未配置时 Pangu 请求不发送 `max_tokens`，由实际模型服务执行其自身的上下文窗、输出上限和账户限流；显式配置时网关仍校验为正整数并传给 Provider。
