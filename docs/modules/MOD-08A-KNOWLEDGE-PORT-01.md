# MOD-08A：只读知识端口与测试 Vault

- 关联需求：PA-008
- Profile：`huawei_ict_agentarts`
- 基线：`origin/main@f56059a`
- 分支：`codex/mod-08a-knowledge-read`
- 负责人：`goo122`
- 评审者：`zemeng` 或其他已登记非作者协作者
- 状态：`review`，待非作者评审与集成

## 交付

- `@personal-agent/knowledge` 暴露 provisional `KnowledgePort.search`。
- `@personal-agent/knowledge/testing` 提供显式、纯内存测试 Vault。
- 搜索结果包含有界文本片段和精确测试引用（Vault、相对路径、行号、内容摘要）。
- 输入路径、查询、结果数量、取消和 deadline 在 Fake 边界校验。

## 不在本片

不接真实 Obsidian、不读私人笔记、不做文件写入/删除、模型总结或 LLM Wiki，
不注册 Runtime capability，也不发送 AgentArts。当前真实知识能力仍为 unavailable；
接口本身保持 provisional。

## 验收

- 模块测试覆盖命中和未命中、引用、截断、Vault 隔离、非法路径、取消与超时。
- 根构建顺序与锁文件登记 workspace，`npm run check` 与 `git diff --check` 通过。
- 真实 Vault 权限、符号链接、索引与变更读回另列 MOD-08B，不能由 Fake 结果替代。

## 本地验证

- `npm run build --workspace=@personal-agent/knowledge`：通过。
- `npm run test --workspace=@personal-agent/knowledge`：4/4 通过。
- `npm run check`：架构 3/3、合约夹具 4/4、生成类型、全工作区构建/类型检查/测试与根集成 7/7 通过；真实服务测试未启用。
- `git diff --check`：通过。
