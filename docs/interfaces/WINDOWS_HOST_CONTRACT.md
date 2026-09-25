# Windows Host 内部通信契约（provisional）

此契约服务 `huawei_ict_agentarts` 的 Windows 工具接线，单一来源为
`packages/contracts/schema/windows-host.json`，版本 `0.1.0`。TypeScript 消费者使用
`@personal-agent/contracts/windows-host`；C# Host 消费同一 JSON Schema 和夹具，不能另定
字段语义。它是 Desktop 可信主进程与当前用户 Windows Host 之间的**内部**协议，
不是 Renderer/Client 的公共 operation。当前只定义 `computer.notepad.replace_text@1.0.0`；
实际 Named Pipe、目标观察、资源锁、Host 接入 Runtime 和桌面读回仍需实现与验证。

## 会话与帧

连接前须由宿主验证当前用户 SID、Pipe ACL、对端进程身份和会话归属；Schema 的
`clientNonce`/`hostNonce` 仅提供关联，不代替 OS 身份认证。每次连接 `hello` →
`hello_ack` → `bind` 后才允许操作。`requestId` 只关联单次响应，`sessionId` 绑定连接；
断连后旧 session 和 targetRef 的**执行效力**失效；已开始写入的持久 run 记录仍保存原
targetRef 作为历史身份，绝不能用它再次执行。未知版本、字段、能力和关联 ID 均拒绝。
`FrameDecoder` 与 `encodeWindowsHostFrame` 使用 UTF-8 JSONL、LF、最多 1 MiB；解码后
必须调用 `parseWindowsHostFrame`，并用握手/观察/结果关联校验。每帧时间采用精确 UTC
毫秒格式；接收方按本机时钟检查 deadline 和目标有效期。

## 观察、授权与执行

可信宿主通过 `observe` 获得短期 `targetRef`。Host 内部持有真实 HWND/PID、进程起始
时间、窗口身份及 UIA 目标；这些字段不能进入公共结果。目标销毁、移动、用户接管、
目标过期或预期正文不匹配时拒绝写入并重新观察。当前工具的 `expectedText` 是写前
必需的内容前置条件，`replacementText` 是待写正文。二者只走受限本地 Pipe，不进
Renderer、公开 Evidence、日志或模型回显。

`execute` 只能由已通过 Runtime/Policy/ToolGateway 检查的可信组合入口发送。其
`authorizationRef`、`taskId`、`runId`、`toolName`/`toolVersion`、`targetRef`、
`argumentsDigest`、deadline 必须与授权记录和实际 ToolGateway 调用一致。
`argumentsDigest` 使用 ToolGateway 的 `toolArgumentsDigest(arguments)`，不是 Host
从自报范围签发的新授权；Host 不信任帧中的授权引用，也不能自行生成 grant。
Policy 的 scope、次数、过期、撤销与参数绑定仍由可信 Runtime/ToolGateway 校验。
同一 `runId` 不得绑定另一组参数；Host 需要持久记住已开始的写入，重连只核实结果，
不能盲目重放。电脑输入由单一仲裁者串行，Host 的输入锁与 Runtime 的调用状态必须
遵循同一 runId，不能各自独立放行冲突写入。

## 结果与恢复

`result.state=verified` 仅表示 Host 完成写后从真实目标读回并匹配，必须带
`evidenceRef`；`refused` 为写前拒绝，`cancelled` 只用于确认尚未开始写入的取消。
写入可能已经发生时的超时、断连、用户接管或取消一律 `result_unknown`，由 Runtime
转入 `waiting_reconciliation`，不得重试写入。非 `verified` 结果必须带 `errorCode`。
`result` 只回传状态、时间、runId、目标引用和证据/错误引用，不能回传 HWND/PID 或正文。

`status` 通过新会话携带原 `taskId/runId/toolName/toolVersion/argumentsDigest/targetRef`
查询持久 run 记录：终态回 `result`，其中 `sessionId` 是**新**会话、`requestId` 是本次
轮询 ID，`targetRef` 是原执行的历史身份；仍运行或没有可确认记录时分别回
`status_reply: in_progress` / `not_found`。`not_found` 不证明写入未发生，调用方应
保持结果未知。宿主使用 `validateWindowsHostRecoveredResult` 核对原执行、轮询及终态的
持久身份，同时核对轮询和结果的新 session；不能把新会话状态查询当作重试执行。
Runtime 的公开工具结果另按现有 TaskRuntime、ToolGateway、Evidence 规则投影，
不能把 Host 自报的 `verified` 直接作为任务成功。

## 验收边界

本契约的包测试只覆盖 Schema、长度、时间和请求关联。投入使用前还须在真实 Windows
Pipe 与记事本上验证 ACL/身份、会话失效、用户接管、取消、超时、重启读回、Policy
绑定和后置读回。未完成时该能力不得公布为生产 capability。
