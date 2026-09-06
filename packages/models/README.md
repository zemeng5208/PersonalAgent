# Models

MOD-04 的模型端口和模型网关。`ModelGateway` 只接受显式配置的 Provider，并在请求前校验文本、工具调用和结构化输出能力；Provider 返回的 deployment、verification 和 usage 会随结果保留。

当前验证等级：

- `FakeModelProvider`：`mock`，仅用于无网络测试。
- `UnavailableModelProvider`：明确返回不可用。
- `PanguModelProvider`：`conditional` 的盘古 V2 文本适配器。使用可信宿主注入的 API Key、base URL 和部署模型；当前不声明流式、工具调用、结构化输出或视觉能力。

模型不能提供 `scopeRef`、凭据或执行函数。工具提案必须由 Agent 根据 Runtime 提供的工具描述重新校验。

Provider 使用盘古 OpenAI 格式的 `/api/v2/chat/completions` 非流式接口。单元测试只注入 Mock fetch，不发起网络请求；真实账号、Endpoint 和模型部署仍需单独授权验证，不能把本地 Mock 结果当作真实连通证据。
