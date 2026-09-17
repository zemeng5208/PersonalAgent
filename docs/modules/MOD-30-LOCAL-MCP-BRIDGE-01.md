# MOD-30：AgentArts 本地只读 MCP 桥接首片

负责人 zemeng；公共接口/集成评审 goo122。Competition Profile，provisional。
工作树 `.worktrees/zemeng-competition-assembled`；不是通用 Local Agent 或 MOD-06 替代品。

## 目的与信任边界

AgentArts 通过原生 MCP 选择工具、接收工具返回并继续工作流；本地仍以
TaskRuntime/Policy/ToolGateway/执行记录为事实源。没有私设 InvokeRuntime continuation。
首片不开放公网、不创建云资源、不读取凭据、不把模型的 ACCEPT 当权限。

`agentarts-runtime-tool-invoker.js` 由可信宿主绑定 Client、taskId、工具版本、scopeRef、
deadline 和必须显式提供的 exportResult。MCP调用方只能提供工具名称、参数和请求ID，
不能选择任务、授权或执行策略。它只调用公开 `Client.tool.invoke`，不直接调用 provider。
仅 confirmed 且带 evidenceRefs 的结果可以经过宿主出口投影；没有默认原文外发。
pending/unknown/failed/拒绝与投影失败都返回固定 MCP 错误，不带路径、参数或内部异常。

## 必须明确的未完成项

- 此首片消费**已经由宿主建立的运行任务和批准过的绑定**，不会自行创建第二套任务或
  审批状态机。云提案到达后暂停等待审批、跨进程恢复并继续同一云运行，仍需 Runtime
  负责人协调现有生命周期接线；不能伪称该交互已完成。
- 本地 loopback MCP 不是云端可达地址。若需公网 HTTPS 入口/反向隧道/新凭据，必须明确
  授权其暴露对象、持续时间和最小出机数据。禁止直接绑定0.0.0.0开放电脑。
- 用户的上一次单次控制台验收已消耗，不可据本工作包追加云调用。
- 生产注册、云 MCP 配置/兼容性、实际 trace 和 Desktop 实际操作均未验收。

## 本地证据

最终整合后，Node24.15 对桥接与 Runtime invoker 两个测试文件合并运行：5/5通过。
覆盖认证与Origin拒绝、协议初始化、工具列表、重放/冲突、取消与deadline关闭，
以及真实本地Runtime/Policy/ToolGateway的合成只读执行与未确认结果禁止出机。

用户已允许**准备**一次临时HTTPS接入；尚未选定服务和地址，也未创建外部访问权限。
准备许可不等于已配置云端MCP或已完成真实联调。具体入口、访问方、存续期和出口投影
须在开放前核对；验收后关闭。此实现保持比赛架构基线，不代表最新赛事细则已复核。

HTTP入口 `agentarts-mcp-bridge.js` 只监听127.0.0.1随机端口/mcp，要求独立Bearer凭据，
拒绝Origin/错误Host，采用64KiB输入上限、工具白名单、有限请求缓存、串行执行。
支持initialize、initialized通知、ping、tools/list、tools/call；只提供单消息JSON响应，
不支持batch、session或SSE（GET返回405）。这是一份明确的协议子集，未宣称全MCP兼容。

Node24.15运行 `apps/desktop/test/agentarts-runtime-tool-invoker.test.mjs`，2/2通过：
真实 SQLite TaskRuntime、Client、Policy、ToolGateway 与真实 workspace.read_text provider，
输入仅测试临时目录中的合成文本；Runtime请求审批后测试宿主扮演用户 allow_once，
resume进入running后调用，生成一条confirmed执行记录与Evidence；重复ID不重复读取，
同ID换参被拒绝，伪造taskId被拒绝，文件保持原样。未确认状态不外发任何结果。
该正常路径已改为实际loopback HTTP initialize→tools/list→tools/call，不是直接函数
替身调用；HTTP重复请求只返回同一结果，宿主出口投影也只执行一次。2/2仍通过。
测试服务器已关闭，没有保持后台监听，也没有公网曝光或AgentArts配置变更。
这些证据只证明本地绑定，不等于云端调用或比赛完整Golden Path。

协议依据：[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
与 [Tools](https://modelcontextprotocol.io/specification/2025-03-26/server/tools)。
