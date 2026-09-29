# Windows Host 内部进程（provisional）

此进程只消费 `packages/contracts/schema/windows-host.json` 的 `0.1.0` 帧。构建时从
公共 contracts 拷贝该 Schema 到 Host 输出目录；缺失或版本不符时启动前拒绝。
当前分支叠加 #117/#120；必须与 #168 合并后的同源 Schema 配合，不复制另一份 DTO。

可信 Desktop/Runtime 组合方启动 `WindowsHost.PipeBridge.exe --host <Host.exe绝对路径>`。
Bridge 生成随机 `pa_<32位小写十六进制>` Pipe 名，启动 Host 并传入
`--pipe <name> --client-pid <Bridge自身PID>`。Bridge 持有实际 Pipe client handle，
经 Win32 `GetNamedPipeServerProcessId` 核对它启动的 Host PID、进程起始时间与 session；
验证通过后只在标准错误流写一次 `VERIFIED`，失败写 `REFUSED` 并拒绝转发。
标准输入/输出原样透传 #168 JSONL，不引入第二套业务帧。Node 调用方必须等待
`VERIFIED` 后才发送 `hello`，不能将进程启动或随机 Pipe 名当成身份验证。
Bridge 退出时结束其 Host；Host 也监视绑定的 Bridge 进程，避免强制终止后留下
等待连接且占住互斥锁的孤儿进程。

Host 限当前用户 Pipe ACL，连接时核对对端 Bridge PID、进程启动时间与 Windows
session；收到并校验 `hello` 后、发送 `hello_ack` 前，以该已读取消息的身份核对
用户 SID，然后执行 `hello → hello_ack → bind` nonce 会话绑定。Pipe 名/启动参数本身不是授权；
同用户其他进程仍可直接调用 Windows UIA，所以 Host 不宣称 OS 沙箱。

`observe` 只接受本会话建立后新增、身份可信、当前前台、全局唯一且单标签的
Notepad 顶层窗口；跨会话进程、旧 HWND 中的新标签、多标签及无法核验来源的窗口均明确拒绝。
Host 只返回短期随机 `targetRef`，不返回或记录标题、正文、HWND/PID。
无法观察时使用 Schema 中的 `observation_refused`（包含 `UNAUTHORIZED`、`TARGET_AMBIGUOUS`、
`TARGET_STALE`、`TIMEOUT`），不会用断连伪造拒绝。断连后目标引用立即失去执行效力。

审批前的只读 `target_ready` 帧复用目标的 HWND/PID、进程起始、窗口身份、唯一标签、
唯一可见启用可写 UIA 文本控件结构（候选异常即 fail closed）、前台与有效期检查。目标有效回 `target_ready_result(ready=true, expiresAt)`，目标失效或结构异常回
`ready=false, errorCode=TARGET_STALE`，过期回 `ready=false, errorCode=TIMEOUT`。它不读取正文、
不新建或续期目标、不激活窗口，也不消费授权。

`execute` 帧中的 `authorizationRef` 不构成授权；正式调用方必须先在 Runtime 的
Policy/ToolGateway 中完成任务、工具、参数摘要、目标与期限的授权消费。Host 只接受
已绑定的可信 Pipe 对端，把同一 `taskId/runId/toolName/toolVersion/authorizationRef/
argumentsDigest/targetRef` 和本地文本摘要记入用户范围的追加日志；日志无正文、路径、
窗口名或 HWND。首次 UIA 调用前持久记录已开始，重复 runId 只能查询已有结果，
不能重做写入。单进程互斥和原类库输入锁串行写入；写前检测到真实用户键鼠输入或前台切换时
立即停止后续自动输入并拒绝（返回 `USER_TAKEOVER` 或 `TARGET_STALE`）。Host 将核心 UIA 真实读回映射为
内部 `verified`；这一步已从真实 UIA 目标完成后置读回。该 `evidenceRef` 是 Host 回执
标识，**不是** Runtime 的公开 Evidence 或任务终态。正式消费方须校验认证会话中的
回执关联，并将 Host 的执行读回状态投影为 Runtime Evidence；无需再造第二套 UIA
读回器。`verified` 只证明当前控件文本匹配，不证明文件已保存。

取消只发取消信号，随后以 `status` 查询；Schema 未定义取消确认帧。连接断开时
取消未结束动作。Host 单次操作另有十分钟看门狗；超过期限同样发取消信号。
写入可能已开始、进程崩溃、日志只留开始记录或结果不能确认时
保持 `result_unknown`，不得盲目重试。新会话 `status` 使用原 run 的历史
`targetRef` 仅核对身份，不能拿它再次执行；`not_found` 同样不能证明没有写入。

没有正式桌面组合方、真实 Pipe/ACL/UIA/授权链与重启读回验收前，能力继续
`unavailable`。本目录不修改公共 Schema、Runtime、Policy、Desktop 或根 lock。

从仓库根目录分别构建 `dotnet build apps/windows-host/host/WindowsHost.Host.csproj` 和
`dotnet build apps/windows-host/host/bridge/WindowsHost.PipeBridge.csproj`。`--host` 指向
前者的绝对 `.exe` 路径，其同目录必须含 #168 Schema 拷贝的 `windows-host.json`。
在普通用户 Windows 会话已用固定 #168 Schema 执行受控 `hello` 短链：Bridge 的
OS 服务端 PID 核验返回 `VERIFIED`，Host 的反向 PID/SID 核验后回关联一致的
`hello_ack`，桥正常退出且两个进程无残留。此检查没有发送 `bind`、`observe` 或
`execute`；本机未实际观察现代 Notepad UIA 树，离线编译与死句柄测试不能证明真实现代记事本可写，不能代替授权、记事本 UIA 或设备完整验收。
