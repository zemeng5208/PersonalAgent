# MOD-18-WORKSPACE-PATCH-WRITE-01

- Profile：`huawei_ict_agentarts`；负责人 `zemeng`；非作者评审 `goo122`；状态 `review`。
- 前置：PR #112 的只读预览已合入 main；本包只触及 `packages/coding-tools/**` 与本记录。

`workspace.apply_text_patch@1.0.0` 是显式注册的 `local_write` 工具，要求
`workspace:read` 和 `workspace:write`。输入沿用只读预览的规范路径、原文件
SHA-256 和顺序文本编辑；工具先预览，再在目标目录内排他创建临时文件，
替换前复核目录、文件身份和原始字节摘要，替换后通过现有受限 reader
读回候选摘要。过期哈希、越界、敏感路径、链接、取消和超时不得返回成功。
ToolGateway/Policy 决定授权并消费授权引用，本包不创建授权或绕过审批；
未在 Runtime/Desktop 生产组合中注册，未调用真实 AgentArts。

当前 `ToolGateway` 对写入中的任何异常都统一映射 `RESULT_UNKNOWN`，
Runtime 将其置于 `waiting_reconciliation`。即使本工具在写前识别冲突，
上层也不能在现有接口中区分写前安全拒绝和写后结果未知；请 `goo122`
明确分阶段写入错误及对账接口。Runtime 的 `tool.invoke` 当前未传递
`userPresent`，本工具因此依赖现有显式审批与参数绑定授权，descriptor
的 `requiresPresence` 为 false；若需独立在场校验，也由 Runtime/Policy 接线。

本包只能防止替换前观察到的并发修改。其他编辑器不遵守应用锁时，最终
哈希检查与重命名之间仍有竞态；Node 跨平台 API 未提供带原文件摘要条件
的原子替换。Windows ACL 等元数据的保留尚未真实验收。`ArtifactPort`
仍 unavailable，写入的读回结果由 Runtime 内部 Evidence 记录，不能将
此片标记为完整编程工具或 MVP。

定向验证：Node 24.15.0 下 coding-tools build 与新写入测试；测试仅使用
系统临时目录中的合成 UTF-8 文件，覆盖经 ToolGateway/Policy 的单次授权
写入、读回、过期哈希、缺 scope、取消、越界、链接和清理。未重跑已合并的
只读测试、全仓检查或真实用户工作区测试。
