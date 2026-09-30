# P6 编码工具真实本地验收

Profile：`huawei_ict_agentarts`。负责人 zemeng / P6；非作者评审 goo122。
使用新建的合成演示项目，但文件修改、PowerShell 独占写入、命令进程、SQLite、Runtime、Policy 与 ToolGateway 均为真实实现。没有 Fake 工具、伪造 authorizationRef 或云端调用。

## 执行

在当前工作树安装既有依赖、按根 build 顺序构建 Runtime 及 coding-tools 的依赖后执行：

```powershell
node tests/manual/coding/p6-runtime-acceptance.mjs (Get-Command pwsh).Source
```

要求普通 Windows 用户、PowerShell 7 和 Node 24。脚本在仓库 `.cache/p6-runtime-*` 排他创建新工作区、保护 ACL 的 recovery 目录、独立数据库和 `receipt.json`。不选择或读取真实用户项目，不清理历史验收文件。输出仅有相对回执目录、摘要和任务 ID；保留文件与数据库供复核。

脚本经公开 Runtime/Application 和 Client 端口发起已授权的演示工具任务，逐次读取实际审批 revision，再提交 `allow_once`。执行授权由真实 Runtime/Policy 生成并消费。验证读取与本地查找、补丁预览不改源文件、补丁实际应用、固定命令 stdout/exit、文件二次读回、执行 Evidence、取消不写入、旧源哈希拒绝，以及重启后已确认任务保持同一 ID/输入/执行记录而不重新写入。输入替换必须返回 `REVISION_CONFLICT`。

## 2026-09-30 实际结果

- 基线：`main@1d5718ab`；分支 `codex/p6-mvp-completion`。
- 新 Release 原生 Job helper 构建：0 警告、0 错误；`workspace-command.test.mjs` 8/8，0 跳过，包含取消/超时的真实进程树终结与根命令退出收尾。
- Runtime 与所需依赖定向构建通过；验收脚本 exit 0，回执 `.cache/p6-runtime-ga4x8u/receipt.json`。同目录的中文工作区、数据库和文件保留供 P8 复核。
- 工具链：.NET SDK 8.0.424；运行使用现有 bundled Node 24.19.0。安装使用宿主 npm 11.16.0 / Node 26.3.0，`--ignore-scripts`；仓库声明 Node 24.15.x / npm 11.12.x，本次未下载或更改全局工具，尚未在声明的精确补丁版本复验。

| 读回 | 实际结果 |
| --- | --- |
| before SHA-256 | `5ddbc6d1fc09ba29c255aa9c6044cac3ca75298aced82038f4b692dfb5f1b0f8` |
| after SHA-256 | `2c88b823f0fa58d95c63ebd862ead1bdc2c94d3e72a2feb98fcf21358244473f` |
| apply task | `8b7d83e0-2fac-4b1b-949a-fd2f02d7b26a`，`succeeded` |
| apply Evidence | `host-tool-8b7d83e0-2fac-4b1b-949a-fd2f02d7b26a`，执行 `confirmed` |
| command task | `f753bae0-9cd6-4d66-9ad8-dd44519906de`，exit 0，stdout `P6_AFTER_中文`，stderr 空 |
| stale source task | `b8264467-2d45-4a39-a042-5062f84603a0`，`waiting_reconciliation`，源文件与 recovery 未改变 |
| restart | 同一 apply task、同一持久执行记录、同一结果；未重放；参数替换拒绝 |

Runtime Evidence 的 `verification` 仍为 `conditional`。独立文件摘要、实际 stdout 和重启读回在此另行核验，不擅自提升公共 Evidence 等级。旧哈希的写工具失败被现有 Gateway 保守映射为 `RESULT_UNKNOWN`，继续等待核实；本脚本不改终态、不清除未知记录、不盲目重试。

## 原生命令收尾

Job helper 使用受信的明确 executable 启动根命令。根命令退出后先取得真实退出码、关闭此次 Job，再等待 stdout/stderr 排空，防止继承输出句柄的遗留子进程阻塞收尾；遗留进程仅限该 Job 的命令树。
旧 Release 在本机的新回归中同样通过，因此尚未复现该挂死；此增量是退出顺序的结构修正，不把未复现风险写成已确认现场故障。

## P8 交接与尚未完成项

- 工具仍由可信 composition 显式注册；没有新 Schema、wire operation、公开 DTO、迁移或依赖。复用 `createWorkspaceReadTool`、`createWorkspacePatchPreviewTool`、`createWorkspacePatchApplyTool`、`createWorkspaceCommandTool` 的公开出口；共享装配与 #219/#222 的补丁恢复由 P8 处理。
- 此回执证明真实本地工具链，尚未证明正式 Desktop 设置页/主对话消费、AgentArts 提案与云续接、Windows 选定应用 UIA 或整体 MVP。
- Windows 实机需要 P8 独占正式 Desktop/新记事本/F9 槽，分别确认窗口身份、目标过期/接管拒绝、写后读回、可信 Evidence 与桌面终态。
- 编码正式 Desktop 消费应保留现有工作区选择、精确能力公布、结果出云授权和 P8 恢复接线，不能用此 runner 代替用户入口。
