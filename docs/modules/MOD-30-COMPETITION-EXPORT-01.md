# MOD-30-COMPETITION-EXPORT-01：受信合成结果出机

- Profile：`huawei_ict_agentarts`；MOD-11/13/30 的 Runtime 消费端增量。
- 实现：zemeng 委派集成执行者（Git/GitHub `zemeng5208`）；评审：待 goo122 或另一位已登记非作者。
- 状态：review；不代表真实云工具循环或整个 MOD 完成。
- 基线：main `c5c4ada` + PR #99 `2630c94` 的 Workflow 输入适配。

## 最小行为与兼容

既有 `tool_proposal → waiting_approval → allow_once → ToolGateway → continuation`
保留。`RuntimeApplicationOptions.competitionToolExports` 是受信进程内组合配置，
不来自 Renderer、云提案或 wire 请求。缺省继续拒绝 `unverified` 工具提案。

每项配置固定 `toolName`、`toolVersion`、`exportPolicyVersion`；规则变化必须更新后者。
`accepts({taskId, proposalId, arguments})`
必须显式选择本次合成输入，注册 descriptor 必须为 `read`。配置仅许可结果出机，
不能代替 Runtime/Policy 的用户审批。审批恢复时重新检查出机选择，仍沿用原始 deadline。

执行确认后调用 `project({taskId, proposalId, result, signal})`，仅把其纯 JSON 输出放进
既有 `CoordinationContinuation`；包含 proposalId/state/result 的整个 JSON 最多 8192 UTF-8 字节。投影异常、非法 JSON、超限和取消
均阻止 continuation，错误使用固定文本，已产生的本地执行记录和 Evidence 保留。
投影不接收 grant、scope 或 Evidence 内容。合成选择及字段白名单是受信宿主责任，
不得将任意私人文件读取配上原样回传函数。

同一任务的已确认 proposal ID 保存到既有 `competition-loop` checkpoint：
相同提案重放已裁剪结果，参数/工具/版本或 verification 改变则拒绝，不重复审批或执行。
receipt 同时保存出机规则版本，重启后缺失或版本不同直接拒绝旧投影，不重新执行工具。
异步投影完成后、实际适配器调用前再次检查动态出机范围、取消信号及期限。
没有数据库迁移、新 wire DTO、Policy 改动或 capability。旧 checkpoint 缺少 receipts 时
按空列表兼容；本地 Fake 的 mock 路径保持原有行为。

`createAgentArtsRuntimeApplication` 另透传 PR #99 的 `workflowGoalInput`：
省略保持 `{query: goal}`，配置后由 adapter 发 `{inputs: {[name]: goal}}`。

## 验证与证据边界

- Node 24.15.0；依赖安装使用 npm 11.16.0（与仓库 npm 11.12.x 有版本偏差）。
- 定向 Runtime 测试覆盖：默认拒绝、审批、task/版本/输入绑定、只读限制、出机撤销、
  一次执行与重复 approval/proposal、冲突、期限、拒绝、取消、非协作投影取消、8KiB、
  非 JSON、敏感错误不回传、本地 Evidence 和 Workflow 输入透传。
- `npm run check` 首次完成架构/契约/生成类型、全部构建/类型检查及其余 workspace 测试，
  Runtime 为 89/90：既有 100ms deadline 测试受并行 SQLite 启动延迟影响，适配器尚未开始就过期。
  固定该测试提交时钟，保留真实 timeout timer 和原断言后补跑 Runtime 90/90、integration 11/11；
  未重复全套。未运行 Electron、真实模型、云浏览器或长期服务。
- 评审修复定向验证 36/36：包含投影期间撤权、磁盘重启后收紧规则拒绝旧投影、原工具不重做；
  已纳入 PR #99 的 `cfdb170` Workflow 终态配对修复。后续真实适配器凭据等待后的最终 fetch
  门禁由适配器与 Runtime factory 的独立消费增量继续接线，本片不能冒称已覆盖实际云发送。
- 所有网络响应与提案均为显式离线夹具；`unverified` 测试输入不代表真实 AgentArts 已支持工具事件。

## 尚缺的真实链路

PR #99 仍是文字 adapter，真实工具提案及 continuation 协议明确不可用。本片提供本地可信门禁，
不会把云文字成功解释为工具执行完成，也不会回退 Local 或把真实调用标 mock。

PR #78 的 loopback MCP 桥不在本 PR 中整体引入。历史桥只支持预创建、已批准、running 的任务。
若直接在 `CoordinationPort.execute` 的 HTTP 请求里等待 MCP 审批，
`RuntimeApplication.send(authorization.respond)` 又等待活动任务完成，会形成生命周期互等。
需要另一个明确的 Runtime 主持挂起/恢复工作包及真实云运行关联，不能由 Desktop 私建循环。

后续 HTTPS 方案交主控协调：仅绑定 loopback，单次合成运行、短期随机 token、固定只读工具、
显式字段投影、到期/取消关闭；公开入口与隧道服务确定并完成审批生命周期后才联调。
本片没有打开公网入口、读取凭据、暴露 Shell/私人文件或变更平台法律承诺。
