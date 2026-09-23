# @personal-agent/knowledge — provisional read-only port

Competition Profile 的 MOD-08A 只交付 `KnowledgePort.search` 契约及显式测试
`createFakeKnowledgePort`。可信宿主创建时绑定一个 Vault；消费者仅能以文字查询，
得到有上限的匹配行及 `vaultId/path/line/revision` 引用。引用中的 revision 是测试文档
内容的 SHA-256，不代表真实 Obsidian 文件版本。

Fake 只扫描传入的合成 Markdown 文本，不读取文件系统、不调用模型、不写入数据。
查询最多 128 字符、20 条结果；测试 Vault 最多 100 篇、每篇 256 KiB。
超出范围、取消及到期均明确报错。此包不注册 Runtime capability，不提供真实
Vault 授权、索引、同步、写入或 LLM Wiki。不能把 Fake 测试视为真实知识检索验收。

构建与测试：

```powershell
npm.cmd run build --workspace=@personal-agent/knowledge
npm.cmd run test --workspace=@personal-agent/knowledge
```

后续 MOD-08B 才设计真实 Vault 路径授权、越界与符号链接防护、索引更新及引用读回；
MOD-08C 再评估 LLM Wiki。接口目前为 provisional，调用方不得默认启用或失败回退 Fake。
