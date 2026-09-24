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

MOD-08B 增加 `@personal-agent/knowledge/filesystem` 的脱机只读适配器。
可信宿主必须先完成用户授权，再以绝对路径显式绑定一个 Vault；搜索请求本身不能
指定根目录。适配器只读取 Vault 内普通 Markdown 文件，拒绝目录链接/符号链接、
路径越界、无效 UTF-8、超大或在读取中变化的文件；引用读回会重新校验内容摘要。
它不会写入、持久化正文、记录日志或发送云端。

当前采用每次查询重扫，最多 1000 篇、1000 个目录、16 层、每篇 512 KiB。
隐藏目录和文件不参与检索。超限或读失败会明确报错，不返回看似完整的部分结果。
这是脱机文件路径，不是 Obsidian Vault API 插件；在可对抗的并发文件替换环境中，
路径校验不能替代 OS 级沙箱。没有生产 Runtime/Policy 默认注入、真实私人 Vault 验收、
持久索引、写入或 LLM Wiki，因此生产 capability 仍 unavailable。

MOD-08C 新增可注入的 `@personal-agent/knowledge/tool`：固定名称
`knowledge.search`、范围 `knowledge:read`，由现有 ToolGateway 在执行前
检查 Policy 授权、任务、参数摘要和期限。可信宿主只能显式注入一个已绑定 Vault 的
`KnowledgePort`；工具参数只有查询文本与结果上限，不能指定 Vault 路径。
本片仅在合成 Vault 上验证，未在 Desktop/Runtime 默认注册，也没有向 AgentArts
发送私人内容。直接调用工具对象不是授权机制，生产必须通过现有 Gateway。

MOD-08D 增加插件侧只读适配器；持久索引与 LLM Wiki 留待后续工作包。接口保持 provisional，
调用方不得默认启用或失败回退 Fake。

MOD-08D 的 `@personal-agent/knowledge/obsidian` 是面向
[Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault) 的插件侧只读适配器，
由可信宿主显式传入 Vault、Vault ID 和允许的文件夹（`/` 表示明确选择整个 Vault）。
它使用 `getMarkdownFiles()`、`read()` 和 `getAbstractFileByPath()`，仅搜索范围内的
Markdown，返回内容摘要引用；文件修改、移动或删除后旧引用读回会被拒绝。
每次搜索最多 1000 篇、每篇 512 KiB，不建立持久索引、不写入或上传正文。
Obsidian 的单次 `read()` 不支持中途取消；适配器在调用前后检查取消和期限，
取消后丢弃返回内容。当前没有插件入口、用户选库流程或 Runtime 默认注册，
合成 Vault 测试不能替代真实插件和私人 Vault 验收。

MOD-08E 用合成 Vault 验证 Competition Runtime 显式注入 `knowledge.search` 后的
Fake 工具提案、本地审批和一次性执行；审批前不读取，真实云端提案仍在执行前拒绝。
审批拒绝时不检索，也不产生发往编排端的 continuation。
该测试不启用生产注册，不读取私人 Vault，也不允许将私人检索结果发给 AgentArts。
生产接线前必须另行确定用户选库授权和独立的云端发送范围/同意流程。
注意：本包的适配器本身不持久化正文，但现有 Runtime 会把确认后的工具结果
写入 SQLite 检查点。私人 Vault 接入前还需解决本地保留/WAL/备份和重启重放边界，
参见[ADR-0009 提案](../../docs/adr/0009-knowledge-data-boundary.md)。
