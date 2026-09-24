# Windows Host: 记事本受限文本操作核心

此目录目前只包含 Windows 专用类库，**没有可启动的服务、Named Pipe、ToolGateway 注册或生产 capability**。目标 Profile 为 `huawei_ict_agentarts`；本地执行不能由 AgentArts 的成功响应或 Renderer 文本直接触发。共享端口和授权入口见 [#114](https://github.com/zemeng5208/PersonalAgent/issues/114)。

`NotepadAction.ReplaceTextAsync` 的目标仅为前台、非提权、系统目录 `notepad.exe` 中**恰好一个**支持 UI Automation `ValuePattern` 的可编辑控件。可信调用方须在用户确认后传入窗口句柄、PID、进程启动时间和精确预期文本；最多替换 4096 个 UTF-16 code unit，且必须完全匹配当前文本。静态信号量串行化本进程所有输入；执行前核对窗口身份、前台和上次输入 tick，变更后再次读回目标控件。取消、窗口切换或用户输入导致让出控制；变更开始后的任何失败返回 `ResultUnknown`，不可盲目重试。返回内容不包含窗口标题、路径或文本。

这只是 Host 内部的防护，尚无可信 Runtime 调用入口；传入 `ConfirmedNotepadTarget` **不代表**授权证据，也没有跨进程资源锁、持久化 runId、重启恢复或人工确认 UI。未来接口必须由 Runtime/Policy/ToolGateway 消费授权，并经受信 Desktop 展示目标确认。UIA `ValuePattern` 并不适用于所有版本记事本；多控件、不可访问控件或 MSIX 路径均拒绝。读回只证明当前控件文本等于新值，不证明文件保存、模型提案或完整任务完成。`GetLastInputInfo` 与前台窗口检查不能捕获所有并发接管，实机仍需有意插入输入/窗口切换验证。

构建要求 Windows 及 .NET 8 Windows Desktop SDK：`dotnet build apps/windows-host/WindowsHost.csproj`。Linux 环境没有 .NET SDK，不能执行或声称构建与 UIA 实测。详情及手工验收见 [模块记录](../../docs/modules/MOD-16-WINDOWS-EXECUTION-01.md)。

普通用户可从仓库根目录执行 `dotnet run --project apps/windows-host/manual/ManualNotepadProbe.csproj` 进行一次手工探测。程序只启动一个新记事本进程和新建的随机合成临时文本文件；必须亲眼确认窗口文本，输入 `CONFIRM` 后在五秒内手动切回该窗口。结果为 `Verified` 时还需目视确认，再关闭记事本且不保存。若系统把新标签页放在已有记事本进程、应用路径不符合 System32 或不提供单一 ValuePattern，本探测将拒绝，不能另选已有私人窗口重试。此程序不经过产品授权链，仅供测试，不能作为生产入口；探测并非 PA-016 的端到端验收。
