# Windows Host: 记事本受限文本操作核心

此目录包含受限 Windows 类库和 `host/` 中的独立进程入口。Host 消费 [#168](https://github.com/zemeng5208/PersonalAgent/pull/168) 的 provisional `0.1.0` 内部 Schema；**尚无 Runtime/Policy/ToolGateway 正式调用方、Desktop 受信确认或生产 capability**。目标 Profile 为 `huawei_ict_agentarts`；本地执行不能由 AgentArts 的成功响应、Renderer 文本或单独的 `authorizationRef` 触发。共享授权与正式组合仍见 [#114](https://github.com/zemeng5208/PersonalAgent/issues/114)。

`NotepadAction.ReplaceTextAsync` 的目标仅为前台、非提权、System32 经典记事本或包身份精确为 `Microsoft.WindowsNotepad_8wekyb3d8bbwe` 的 MSIX 记事本中**恰好一个**支持 UI Automation `ValuePattern` 的可编辑控件。MSIX 还须恰好一个可识别且选中的 UIA 标签；无法识别即拒绝。可信调用方须在用户确认后传入窗口句柄、PID、进程启动时间和精确预期文本；最多替换 4096 个 UTF-16 code unit，且必须完全匹配当前文本。静态信号量串行化本进程所有输入；执行前核对窗口身份、前台和上次输入 tick，变更后再次读回目标控件。取消、窗口切换或用户输入导致让出控制；变更开始后的任何失败返回 `ResultUnknown`，不可盲目重试。返回内容不包含窗口标题、路径或文本。

这只是 Host 内部的防护，尚无可信 Runtime 调用入口；传入 `ConfirmedNotepadTarget` **不代表**授权证据，也没有跨进程资源锁、持久化 runId、重启恢复或人工确认 UI。未来接口必须由 Runtime/Policy/ToolGateway 消费授权，并经受信 Desktop 展示目标确认。UIA `ValuePattern` 和标签结构并不适用于所有版本记事本；多控件或不可访问控件均拒绝。读回只证明当前控件文本等于新值，不证明文件保存、模型提案或完整任务完成。`GetLastInputInfo` 与前台窗口检查不能捕获所有并发接管，实机仍需有意插入输入/窗口切换验证。

构建要求 Windows 及 .NET 8 Windows Desktop SDK：`dotnet build apps/windows-host/WindowsHost.csproj`。Linux 环境没有 .NET SDK，不能执行或声称构建与 UIA 实测。详情及手工验收见 [模块记录](../../docs/modules/MOD-16-WINDOWS-EXECUTION-01.md)。

普通用户可从仓库根目录执行 `dotnet run --project apps/windows-host/manual/ManualNotepadProbe.csproj` 进行一次手工探测。程序创建随机合成临时文本文件，启动 System32 `notepad.exe`，启动前快照已有 Notepad 顶层 HWND/PID/启动时间；之后只接受全局唯一、身份可信且新增的可见顶层 HWND（可属于既有 PID），从不选择旧 HWND 的新标签。不读取既有私人标签、窗口标题或文本。零新增窗口、身份不可核及多个新增窗口分别拒绝。显示随机文本和 `CONFIRM` 提示前复用核心的 UIA 单标签检查，目标含多个标签或结构无法判清即拒绝。唯一新窗口仍须亲眼确认完整随机合成文本，输入 `CONFIRM` 后在五秒内手动切回。结果为 `Verified` 时还须目视确认，再关闭记事本且不保存。若新标签页落入旧 HWND、MSIX 未暴露唯一标签或不提供单一 ValuePattern，本探测拒绝，不能切到私人窗口重试。此程序不经过产品授权链，仅供测试，不能作为生产入口；探测并非 PA-016 的端到端验收。

定向时序回归：Windows 上运行 `dotnet run --project apps/windows-host/test/WindowsHost.Timing.csproj`，受控交错在预期文本读取后改变输入 tick，以及不改变 tick 的程序改值，两者均必须在写前拒绝。写入前还会重新查找已确认窗口中唯一选中的标签及同一编辑控件，再检查精确文本、输入 tick 和前台身份。UIA 读取和 `SetValue` 之间没有原子 compare-and-swap；这些复核仍不能捕获所有接管，不能用此回归代替真实交互验收。

Host 进程的受信启动、Pipe 对端检查、目标观察、run 日志和恢复边界见 [host/README.md](host/README.md)。仅构建或运行 Host 不发布 `computer.notepad.replace_text`；产品侧必须先让 Runtime/Policy/ToolGateway 消费授权，再由可信主进程启动并绑定 Host。Windows 打包安装不属于此工作包。
