# 公共客户端（MOD-02）

消费 @personal-agent/contracts 0.1.0-alpha.1；wire 1.0.0，尚未冻结。Client 接受注入的 Transport，不导入 Node 系统 API、密钥或 Runtime 实现。

先 await client.connect() 握手，再 client.call(operation, payload, options)。客户端发现未注册能力后拒绝调用；task.submit 必须显式提供 idempotencyKey。超时和 AbortSignal 传给传输层；错误保留 code、retryable、retryAfterMs；客户端不自动重试。

Transport.send 应关联请求、序列化消息并实现实际 IPC；此包目前只定义传输接口。Electron preload 和 C# Named Pipe 适配由 zemeng 实现，实际桌面运行未验证。

取消 RPC 等待与取消业务任务不同。停止业务使用 task.cancel，返回 cancelling 仅表示受理；等待后续 cancelled 或 waiting_reconciliation。外部未知结果需要读回，不能根据超时自动重发。

`Client.call` 的可选 `taskId` 用于需要任务绑定的内部操作（例如 MOD-05 的 `tool.invoke`）。`scopeRef` 只是已有授权引用，客户端不能通过自报 scope 获得权限。

EventCursor 每实例绑定一个 streamId。accept 批量验证、排序、去重；序号缺口抛 CURSOR_EXPIRED，不推进游标。重连使用 afterSequence 续订。回放已过期时由宿主协调快照和续订位置，再显式 reset；本包不假定一个无序快照能够解决并发快照/订阅竞争。当前历史冲突检查窗口 512 条，超窗旧事件按序号丢弃。

根目录 npm run demo:protocol 展示消费者调用和取消往返，输出明确标记 mock。它使用进程内 Fake，不能替代 zemeng 的实际消费端验收。
