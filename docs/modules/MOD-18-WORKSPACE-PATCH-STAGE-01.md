# MOD-18-WORKSPACE-PATCH-STAGE-01

- Profile：`huawei_ict_agentarts`；负责人 `zemeng`；非作者评审 `goo122`；状态 `review`。
- 前置：PR #112 的只读预览已合入 main；本包只触及 `packages/coding-tools/**` 与本记录。

`workspace.stage_text_patch@1.0.0` 是显式注册的 `local_write` 工具，要求
`workspace:read` 和 `workspace:write`。输入沿用只读预览的规范路径、原文件
SHA-256 和顺序文本编辑；工具复核原文件后，在可信工作区根下排他创建
`.pa-stage-*.patch`，读回候选摘要并再次复核原文件。原文件始终不写、不重命名、
不覆盖，因此外部编辑器的并发修改不会被此工具抹掉。候选文件的相对路径
单独返回，不能呈现为已应用的补丁。ToolGateway/Policy 决定授权并消费授权引用，
本包不创建授权或绕过审批；未在 Runtime/Desktop 生产组合中注册。

当前 `ToolGateway` 对写入中的任何异常都统一映射 `RESULT_UNKNOWN`，Runtime
将其置于 `waiting_reconciliation`。即使本工具在候选创建前识别冲突，
上层也不能区分写前安全拒绝和写后未知结果；请 `goo122` 明确分阶段错误
和对账接口。Runtime `tool.invoke` 当前未传递 `userPresent`，本工具依赖
现有审批与参数绑定授权；若需独立在场校验，也由 Runtime/Policy 接线。

真正把候选覆盖到原文件需要跨进程的原子条件替换或可信独占文件能力；
Node 跨平台 API 中仅用 stat/hash + rename 存在最终检查后的竞态，故本包
没有提供 `workspace.apply_text_patch`。`ArtifactPort` 仍 unavailable，
候选文件也不是完整 Artifact。恶意进程并发替换授权工作区目录的路径竞态
与 Windows ACL/metadata 保留尚未真实验收。

定向验证：Node 24.15.0 下 coding-tools build 与候选文件测试；测试仅使用
系统临时目录的合成 UTF-8 文件，覆盖经 ToolGateway/Policy 单次授权创建、
读回、原文件不变、过期哈希、缺 scope、取消、越界和链接。未重跑已合并的
只读测试、全仓检查或真实用户工作区测试。
