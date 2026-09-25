# MOD-16-WINDOWS-EXECUTION-01：受限记事本操作核心

- Profile：`huawei_ict_agentarts`；MOD-16、PA-016；负责人 zemeng；非作者评审 goo122。
- 原核心基线：`main@4efa7f60feaaa007d73c80e7d90091e0caab3bc7`；本次诊断分支 `codex/zemeng/mod16-windows-manual-probe`（`#120`，起点 `f962e4d`，已含 `#117` 的写前时序修复）。
- 文件边界：`apps/windows-host/**` 与本文；MOD-17 的 `packages/windows-client/**` 和历史 `MOD-16-SYSTEM-OBSERVATION-01.md` 均不改。
- 当前状态：受限核心的合成探针仍未取得正向实机读回；Host 进程增量需 Windows 构建、Pipe/身份与授权链验收。生产能力 `unavailable`。共享接口及 Desktop 接线见 [#114](https://github.com/zemeng5208/PersonalAgent/issues/114)，provisional Host 帧 Schema 见 [#168](https://github.com/zemeng5208/PersonalAgent/pull/168)。

## 设计与边界

只对用户先行确认的前台记事本窗口做一次精确文本替换。普通用户权限；PID、进程启动时间、HWND 与 System32 可执行路径或精确 MSIX 包家族名共同绑定目标，预期文本不一致则拒绝。MSIX 还须 UIA 中恰好一个可识别且选中的标签；只接受单一 UIA ValuePattern 可编辑控件，并在替换后从当前目标控件重新读取。静态锁串行当前 Host 进程的输入。取消或用户改变前台/输入时让出控制；调用 `SetValue` 开始后任何异常或不符均为结果不确定，由受信路径再次读回，不能自动重试。结果不回显任何文本/路径/窗口名。

输入 tick 基线在 UIA 查找及首次读取预期文本前建立；执行前再次核对同一 tick、目标身份与当前预期文本。紧贴 `SetValue` 前重新发现已确认窗口的唯一选中标签与同一编辑控件，并复核文本、输入 tick 和前台；标签或控件已换则写前拒绝，不读取其他标签的文本。定向回归注入“首次读取后用户输入”及“不改变 tick 的程序改值”，两者均须在写前拒绝。UIA 读值与 `SetValue` 并非原子 CAS，用户输入 tick 也不是完整接管事件流；剩余窗口须在 Windows 实机验收并交 Runtime 的受信协调和恢复处理。

本增量在 `apps/windows-host/host/` 增加独立 Host 进程：读取 #168 的同源 Schema、当前用户 Pipe/对端身份和 nonce 会话绑定、短期 opaque 目标、写前持久 run 记录、断连取消及跨会话只读状态核实。Host 仅是执行端；`ConfirmedNotepadTarget` 仍可构造，Pipe 帧里的 `authorizationRef` 也不是授权凭证。Runtime/Policy/ToolGateway 的授权消费、跨进程调用仲裁、Desktop 受信确认与产品 Evidence 仍按 #114 由原负责人正式组合。未完成这些接线和真实验收时不能注册 capability。此包不改公共 Schema、Runtime/Policy/ToolGateway、Desktop 或根配置/锁文件。没有凭据适配；MOD-05 的 SecretStore 与 Windows 安全存储另需边界契约，不能把机器本地凭据当作授权。

## Windows 实机验收步骤与证据

在普通用户 Windows 会话中，从仓库根目录运行 `dotnet build apps/windows-host/manual/ManualNotepadProbe.csproj`，再运行 `dotnet run --no-build --project apps/windows-host/manual/ManualNotepadProbe.csproj` **一次**。探针创建随机合成文件并启动 System32 入口；启动前只快照已有 Notepad 的顶层 HWND/PID/启动时间，不读取标题或标签。随后寻找全局唯一且新增的可见顶层 HWND，可属于既有可信进程或新进程；旧 HWND 即使新增标签也始终排除。零新增窗口、身份不可核及多个新增窗口分别拒绝；不读取既有私人标签、窗口标题和内容，不切换标签。显示随机文本和 `CONFIRM` 提示前先复用核心的 `TryGetOnlyTab` 检查同一 HWND 的目标身份与唯一选中标签，多标签或结构不明直接拒绝。通过该检查后，操作者仍须目视核对完整随机文本，输入 `CONFIRM`，五秒内手动激活原窗口。核心仅读取该已确认前台 HWND 的单个编辑控件，精确核对随机全文后才可能写入；标记不符、多标签或无法识别单标签均写前拒绝。同时出现其他新窗口时不能把它当合成目标。探针不代表产品授权链。记录一次结果、退出码、脱敏目标身份与是否目视确认；不要记录私人内容或合成全文。随后按下列步骤补足负向和集成验收：

1. 记录 Windows/.NET/记事本版本、实际启动入口路径、完整 `dotnet build` 退出码；若 MSIX 身份、UIA 单标签或 ValuePattern 无法识别，记录拒绝并重新评审，不能将拒绝当成功。
2. 人工确认 HWND、PID、进程启动时间、预期文本和替换文本；测试缺确认、另一 PID、重启后的同 PID、背景窗口、第二编辑控件、只读控件、超过长度及预期文本变化均不发生替换。
3. 测量两次并发请求不会交错；在等待锁与操作前取消，确认未变更；在操作期间键盘输入/切换前台触发接管，确认停止并读回实际文本。UIA 调用中取消不能保证抢占执行，应记录 `ResultUnknown`，关闭自动重试。
4. 成功操作后独立从记事本 UIA 控件读回精确文本；失败、目标退出和取消后另行读回实际内容，明确 verified/unknown，而非仅看 `SetValue` 返回。关闭并重启应用后只应通过可信恢复流程核实，不重做不确定的写入。
5. 待 #114 的真实接口到位，走 AgentArts 提案→受信目标确认→Runtime/Policy/ToolGateway 一次性授权→Host→目标读回→任务持久化/重启恢复，另测撤销、过期、参数置换、无 capability、防 Local 静默回退。保存脱敏任务 ID、目标身份摘要、授权消费记录、读回结果、失败分支和重启状态；不保存实际文本、私人窗口名或凭据。

Windows 回执：旧探针的 System32 启动 PID 未暴露窗口，退出码 2，MSIX Notepad 11.2607.14.0 显示合成文件，未确认或写入。后续 `#120@e74d3efd` 使用 SDK 8.0.424 构建 exit 0、零警告零错误；一次探针发现 PID 41348 的合成随机全文，但同一窗口同时有多个既有私人标签，程序仍显示 `CONFIRM`，操作者输入 `NO` 后输出 `REFUSED: no manual confirmation`，shell exit 1。**该拒绝由操作者触发，旧代码并未在提示前自动拒绝多标签**；未执行 `SetValue` 或读回，未触碰旧标签。`#120@4dfae124` build exit 0、零警告零错误，但一次探针仅输出 `REFUSED: no unique new Notepad window; existing windows and tabs were not inspected`，shell exit 1；没有到达提示前单标签检查、人工确认、写入或读回。新增 HWND 快照修复尚未 Windows 编译或 UIA 实测，不能据旧回执断言目标确实创建了新窗口。若仅复用旧 HWND 的新标签，或 UIA 不暴露可信单标签与单个 ValuePattern，本轮只能验收拒绝；不能用合成结果宣称 PA-016 或整个 MVP 完成。历史 `MOD-16-SYSTEM-OBSERVATION-01` 是只读系统观测，不是本操作证据。
