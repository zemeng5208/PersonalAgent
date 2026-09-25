# MOD-16-WINDOWS-EXECUTION-01：受限记事本操作核心

- Profile：`huawei_ict_agentarts`；MOD-16、PA-016；负责人 zemeng；非作者评审 goo122。
- 原核心基线：`main@4efa7f60feaaa007d73c80e7d90091e0caab3bc7`；本次诊断分支 `codex/zemeng/mod16-windows-manual-probe`（`#120`，起点 `f962e4d`，已含 `#117` 的写前时序修复）。
- 文件边界：`apps/windows-host/**` 与本文；MOD-17 的 `packages/windows-client/**` 和历史 `MOD-16-SYSTEM-OBSERVATION-01.md` 均不改。
- 当前状态：受限核心待 Windows 构建/实机验收；生产能力 `unavailable`。共享接口及 Desktop 接线阻塞见 [#114](https://github.com/zemeng5208/PersonalAgent/issues/114)。

## 设计与边界

只对用户先行确认的前台记事本窗口做一次精确文本替换。普通用户权限；PID、进程启动时间、HWND 与 System32 可执行路径或精确 MSIX 包家族名共同绑定目标，预期文本不一致则拒绝。MSIX 还须 UIA 中恰好一个可识别且选中的标签；只接受单一 UIA ValuePattern 可编辑控件，并在替换后从当前目标控件重新读取。静态锁串行当前 Host 进程的输入。取消或用户改变前台/输入时让出控制；调用 `SetValue` 开始后任何异常或不符均为结果不确定，由受信路径再次读回，不能自动重试。结果不回显任何文本/路径/窗口名。

输入 tick 基线在 UIA 查找及首次读取预期文本前建立；执行前再次核对同一 tick、目标身份与当前预期文本。紧贴 `SetValue` 前重新发现已确认窗口的唯一选中标签与同一编辑控件，并复核文本、输入 tick 和前台；标签或控件已换则写前拒绝，不读取其他标签的文本。定向回归注入“首次读取后用户输入”及“不改变 tick 的程序改值”，两者均须在写前拒绝。UIA 读值与 `SetValue` 并非原子 CAS，用户输入 tick 也不是完整接管事件流；剩余窗口须在 Windows 实机验收并交 Runtime 的受信协调和恢复处理。

源码未提供 pipe 服务、可执行入口或 ToolHost 包装；`ConfirmedNotepadTarget` 是 public DTO，调用者可以构造，因此它本身不构成授权安全边界。未来仅由受信 Runtime adapter 在消费授权后调用，并防止未经许可的模块引用；目前不能把该类库暴露为生产调用入口。此 PR 没有操作公共 Schema、Runtime/Policy/ToolGateway、Desktop 或根配置/锁文件。`DesktopActionPort`、1 MiB JSONL Named Pipe、当前用户 ACL/握手、跨进程资源锁、授权-目标绑定、runId 恢复及 Desktop 受信确认仍是 #114 的共享任务，未经发布不能注册 capability。没有凭据适配；MOD-05 的 SecretStore 与 Windows 安全存储另需边界契约，不能把机器本地凭据当作授权。

## Windows 实机验收步骤与证据

在普通用户 Windows 会话中，从仓库根目录运行 `dotnet build apps/windows-host/manual/ManualNotepadProbe.csproj`，再运行 `dotnet run --no-build --project apps/windows-host/manual/ManualNotepadProbe.csproj` **一次**。探针创建随机合成文件并启动 System32 入口；若窗口由新 MSIX 进程承担，只在启动后新建的 Notepad PID 中寻找唯一可见顶层 HWND，核对包身份、PID、进程启动时间。没有新窗口、复用既有进程/旧标签、多新窗口或身份不可读时拒绝；不读取既有私人标签、窗口标题和内容，不切换标签。操作者必须目视核对完整随机文本，输入 `CONFIRM`，五秒内手动激活原窗口。核心仅读取该已确认前台 HWND 的单个编辑控件，精确核对随机全文后才可能写入；标记不符、多标签或无法识别单标签均写前拒绝。同时出现其他新进程时不能把它当合成目标。探针不代表产品授权链。记录一次结果、退出码、脱敏目标身份与是否目视确认；不要记录私人内容或合成全文。随后按下列步骤补足负向和集成验收：

1. 记录 Windows/.NET/记事本版本、实际启动入口路径、完整 `dotnet build` 退出码；若 MSIX 身份、UIA 单标签或 ValuePattern 无法识别，记录拒绝并重新评审，不能将拒绝当成功。
2. 人工确认 HWND、PID、进程启动时间、预期文本和替换文本；测试缺确认、另一 PID、重启后的同 PID、背景窗口、第二编辑控件、只读控件、超过长度及预期文本变化均不发生替换。
3. 测量两次并发请求不会交错；在等待锁与操作前取消，确认未变更；在操作期间键盘输入/切换前台触发接管，确认停止并读回实际文本。UIA 调用中取消不能保证抢占执行，应记录 `ResultUnknown`，关闭自动重试。
4. 成功操作后独立从记事本 UIA 控件读回精确文本；失败、目标退出和取消后另行读回实际内容，明确 verified/unknown，而非仅看 `SetValue` 返回。关闭并重启应用后只应通过可信恢复流程核实，不重做不确定的写入。
5. 待 #114 的真实接口到位，走 AgentArts 提案→受信目标确认→Runtime/Policy/ToolGateway 一次性授权→Host→目标读回→任务持久化/重启恢复，另测撤销、过期、参数置换、无 capability、防 Local 静默回退。保存脱敏任务 ID、目标身份摘要、授权消费记录、读回结果、失败分支和重启状态；不保存实际文本、私人窗口名或凭据。

此前 Windows 设备上 `#120` build 为零警告零错误，但旧探针的 System32 启动 PID 未暴露窗口，退出码 2；MSIX Notepad 11.2607.14.0 显示合成文件窗口，未输入 `CONFIRM`，未执行 `SetValue` 或读回。本次修改尚未经过 Windows 编译或 UIA 实测。若系统只复用既有进程/旧标签，或 UIA 不暴露可信的单标签与单个 ValuePattern，则本轮只能验收安全拒绝，无法实测成功读回；不能用合成结果宣称 PA-016 或整个 MVP 完成。历史 `MOD-16-SYSTEM-OBSERVATION-01` 是只读系统观测，不是本操作证据。
