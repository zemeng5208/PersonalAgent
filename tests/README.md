# 跨模块测试

模块单元测试放在各自 workspace 的 `test/`。这里只保存必须跨模块验证的测试：

- `architecture/`：目录、依赖方向、公共导出和循环依赖检查。
- `integration/`：多个核心模块组合后的 Fake 集成测试。
- `e2e/`：从应用入口开始的完整链路。
- `manual/`：需要真实账号、网络或付费模型的显式验收。
- `fixtures/`：不包含密钥、账号或私人数据的共享夹具。

跨模块接口测试必须固定接口目录中的冻结基线，并分别覆盖 capability 已公布、未公布、版本不兼容和 `UNSUPPORTED_CAPABILITY`。Fake 通过只证明接口形状与状态分支；盘古、AgentArts、真实账号、语音和 Windows 操作仍需在 `manual/` 中保留独立验收与读回证据。

不得把真实 Provider 测试加入默认 CI。目录在出现第一项真实测试时创建，不保留空占位目录。
