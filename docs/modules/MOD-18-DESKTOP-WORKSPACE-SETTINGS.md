# MOD-18 Desktop 编程工作区设置

> 维护入口（2026-10-07）：项目主要负责人为 zemeng；当前分工以 [模块分工](../../docs/MODULE_ASSIGNMENTS.md) 为准，最新状态见 [ROADMAP](../../docs/ROADMAP.md)。历史日期、作者和验收结论按原记录保留。

- Profile：`huawei_ict_agentarts`；负责人：zemeng；待非作者评审，尚未真实联合验收。
- 工作树：`mvp-assembly`，分支：`codex/mvp-assembly`。
- 范围：Desktop 可信组合与设置。复用 coding-tools，不修改公共 Schema 或业务连接器。

设置中的 Worktrees / 环境页面提供系统目录选择器，并分别声明工具结果发送 AgentArts、写入和受限命令许可。目录使用 Electron safeStorage 加密保存；许可仅在本次应用进程有效。新目录需重启装配，重启后重新授权。Renderer 只收到目录简称和能力状态。

可信宿主注册读取、枚举、预览、候选、条件应用补丁，以及固定的 Git 差异检查命令。应用补丁复用独占句柄、恢复目录 ACL 和原 SHA 校验；不可用时准确显示。命令不是通用终端或 OS 沙箱。移除早期 4 KB 限制，复用 coding-tools 默认 256 KiB 读取和既有预览限额；补丁只修改已有文件，命令运行固定 `git diff --check` 参数。工具执行继续经过 Runtime、Policy、ToolGateway。

普通产品启动不再自动公布固定会议夹具为编程能力。历史夹具验收需显式设置 `PA_DESKTOP_SYNTHETIC_FACT_SOURCE=1`。云端续答取消额外的 8 KiB 演示上限，统一使用既有 CoordinationContinuation 的 1 MiB JSON 边界；这不是外部模型上下文容量保证。Desktop 采用已有文字工具流程的八轮预算并在任务创建时持久绑定；审批恢复不会重置预算，历史任务保持四轮。

工作区许可绑定任务 checkpoint 和本次许可代次。撤销会取消本宿主在途调用并禁止后续执行、结果发送；重新授权不复活旧任务。已经发生的文件写入不会因撤销自动回滚，结果未知应通过既有恢复证据核实。

必要验证：专属宿主测试 1/1 通过，覆盖目录配置、进程重建后不继承许可、绑定读取、撤销及旧任务不能使用新许可；相关 JS 语法和差异检查通过。用实际设置组件及合成状态检查了浏览器布局。本轮未执行真实项目补丁、命令、Electron 或 AgentArts 联合验收，不据此宣布 MOD-18 或 MVP 完成。

## 原输入框的固定 Node 提案消费（2026-10-07 续接）

新增独立消费者证据沿现有 PR #302 交付，没有修改源码或重跑旧正式套件。
原 Worktrees 表单只开启工具结果出云及受限命令许可，写入与项目代码许可保持关闭；
原 panel 输入框提交两个任务，经实际 AgentArts Runtime factory/HTTP adapter 的
显式 Fake JSON 工具提案，再由实际 Runtime/Policy/ToolGateway 调用固定
`workspace.node_check`、真实 Node24.15.0 `--check`。没有诊断 HostTool 提交，
也没有 Fake 审批决定；原 main 的受控 routine policy 消耗真实任务/参数绑定单次 grant，
每个调用之后 usesRemaining 为0。

错误语法真实 exit1/passedfalse，正确语法 exit0/passedtrue；两任务的已确认命令结果
均可令编排任务 succeeded，界面仍分别显示“语法检查未通过”与“通过”，不混淆二者。
源文件的顶层写文件 canary 没有执行。Fake 云续发仅收到 recipeId/exitCode/passed，
没有 stdout/stderr、工作区或源路径。最终两次原提交、两次真实 Node、四次 Fake HTTP，
原 panel/CSP exit0、console/pageerror为零，撤销后 Node 不可用。

另一次独立失败路径在真实 Node 已 confirmed 后，显式延后续发前的第二次 Fake
credential read，再通过原 Worktrees 控件撤销许可。实际第二次出云门禁拒绝续发，
保留本地 confirmed record/Evidence、已消耗 grant 与 export-withheld；任务为
waiting_reconciliation/UNAUTHORIZED，原 panel 显示待核实并保留新草稿。
实际 Node1、HTTP仅initial1、credential read2；再消费三轮事件没有重做命令或续发。
撤销禁止未来动作与输出，未把已发生操作抹去或自动重试。

两项最终进程分别实际 exit0；Desktop main固定 blob
`741f8f42595baf2ddc3d697203bc5e3ea63e258d`，所用六个公开编译出口在各次前后相同，
root的主动expiry producer差异不参与此流程。私有工件位于 Desktop 工作树的
`workspace-node-proposal-*`，包括完整命令、JSON、原截图、失败 helper尝试及撤销原始
描述误写twice的保留文件/另份明确once纠正记录；没有将这些错误尝试记为最终通过。
HTTP/凭据端口、IPC/windows/safeStorage为明确Fake；没有真实云调用、原生function
calling、Electron/Windows加密或进程宿主、真实用户项目验收，不据此完成整个MOD-18。

执行前撤销的独立对照同样实际 exit0：原输入框已发 initial Fake HTTP并公布合法
node_check catalog，显式延后其合法提案回执；原控件撤销后放行，实际工具可用性复核
拒绝首次执行，任务为 failed/UNSUPPORTED_CAPABILITY。原 panel显示失败与权威错误、
发送可用且新草稿保留，console0；Node/执行记录/grant/续发均为0，initial HTTP1，
再消费三轮事件没有重试。证据 `workspace-node-proposal-before-revoke-consumer-*`；
权威错误仍为英文，此项不声称完成中文本地化，也不把前置拒绝写成已有操作待核实。
