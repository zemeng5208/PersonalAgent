# Windows Host 内部进程（provisional）

此进程只消费 `packages/contracts/schema/windows-host.json` 的 `0.1.0` 帧。构建时从
公共 contracts 拷贝该 Schema 到 Host 输出目录；缺失或版本不符时启动前拒绝。
当前分支叠加 #117/#120；必须与 #168 合并后的同源 Schema 配合，不复制另一份 DTO。

可信 Desktop/Runtime 组合方生成随机 `pa_<32位小写十六进制>` Pipe 名，启动
`WindowsHost.Host` 并传入 `--pipe <name> --client-pid <自身PID>`。Host 限当前用户
Pipe ACL，连接时核对对端 PID、进程启动时间、Windows session 和用户 SID，再执行
`hello → hello_ack → bind` nonce 会话绑定。Pipe 名/启动参数本身不是授权；
同用户其他进程仍可直接调用 Windows UIA，所以 Host 不宣称 OS 沙箱。

`observe` 只接受本会话建立后新增、身份可信、当前前台、全局唯一且单标签的
Notepad 顶层窗口；旧 HWND 中的新标签拒绝。Host 只返回短期随机 `targetRef`，
不返回或记录标题、正文、HWND/PID。无法观察时使用 Schema 中的
`observation_refused`，不会用断连伪造拒绝。断连后目标引用立即失去执行效力。

`execute` 帧中的 `authorizationRef` 不构成授权；正式调用方必须先在 Runtime 的
Policy/ToolGateway 中完成任务、工具、参数摘要、目标与期限的授权消费。Host 只接受
已绑定的可信 Pipe 对端，把同一 `taskId/runId/toolName/toolVersion/authorizationRef/
argumentsDigest/targetRef` 和本地文本摘要记入用户范围的追加日志；日志无正文、路径、
窗口名或 HWND。首次 UIA 调用前持久记录已开始，重复 runId 只能查询已有结果，
不能重做写入。单进程互斥和原类库输入锁串行写入。Host 将核心 UIA 真实读回映射为
内部 `verified`；该 `evidenceRef` 是 Host 回执标识，**不是** Runtime 的公开 Evidence
或任务终态。正式消费方仍需可信读回和 Evidence 投影。

取消只发取消信号，随后以 `status` 查询；Schema 未定义取消确认帧。连接断开时
取消未结束动作。Host 单次操作另有十分钟看门狗；超过期限同样发取消信号。
写入可能已开始、进程崩溃、日志只留开始记录或结果不能确认时
保持 `result_unknown`，不得盲目重试。新会话 `status` 使用原 run 的历史
`targetRef` 仅核对身份，不能拿它再次执行；`not_found` 同样不能证明没有写入。

没有正式桌面组合方、真实 Pipe/ACL/UIA/授权链与重启读回验收前，能力继续
`unavailable`。本目录不修改公共 Schema、Runtime、Policy、Desktop 或根 lock。
