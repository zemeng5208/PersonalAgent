# MOD-32：AgentArts 请求级观测与恢复边界

- Profile：`huawei_ict_agentarts` Competition Profile；负责人：`zemeng`。
- 范围：发布、API、观测和手工验收的证据口径。本文不修改云配置、生产适配器、公共协议或本地执行权限。
- 依赖：MOD-04B/29 的云调用适配、MOD-03/05 的任务与工具回执、MOD-30/31 的提案与编排。当前相关接口仍为 `provisional`，不能由这份记录提升为 frozen。

## 已有证据与时间顺序

[`tests/manual/agentarts/README.md`](../../tests/manual/agentarts/README.md) 的 2026-09-12
记录只证明构建。草稿 [PR #108](https://github.com/zemeng5208/PersonalAgent/pull/108)
记录了 2026-09-24 **较早**的控制台读回：应用发布版本 `v20260917160941`、当时
运行时 `Latest=v6`、两条按同会话/输入/时间匹配的成功 trace 及其 token。平台没有
显示调用方 `X-Request-Id`，该匹配并非精确请求 ID 关联。PR #108 仍待依赖、冲突
处理与非作者评审；其旧版本和 token 不可复用为下列新请求的观测值。

本地主链记录 `.cache/full-chain-acceptance-20260924.md` 与隔离集成树被忽略的
`receipt.json` 记载：2026-09-24 22:56 CST 主协调器提交新版本
`v20260924225602`，控制台曾显示“部署成功”；2026-09-25 再读回同一运行时“正常”，
更新时间 22:56:23。版本提交、页面成功和运行时健康是不同的观测表面；仍缺**每条
请求**实际命中该版本的读回。该回执的 `runtimeVersion` 字段为
`to-be-read-back`，不能在展示层填成应用版本或较早的 `v6`。

2026-09-25 18:33:57—18:36:26 CST 的一次合成会议主链通过。两次是独立云
invocation，不是平台原生同 run 续接：

| 本地请求 | 本地 API/解析读回 | 请求级 deployment/version/trace/usage |
| --- | --- | --- |
| 提案 `ddaa2b75…6f27` | HTTP 200、完整 SSE、无 error event；严格 `tool_proposal` | 运行时名称仅是本地目标配置；实际部署版本、平台 trace ID、input/output tokens 和费用均未读回 |
| 候选 `b2b1f07a…2fe6` | HTTP 200、完整 SSE、无 error event；严格 `repair_candidate` | 同上；不能借用前一请求或 PR #108 的 trace/token |

本地 source task 与独立 local repair task 均为 `succeeded`；一次性批准、只读工具
confirmed 记录、原生候选预览、本地 CAS 写图、Evidence 与同库重启已分别读回。
graph revision 为 9；本次结果只覆盖授权的合成会议场景。上述结果证明本地闭环，
不补足平台请求级部署版本、trace、用量、费用、角色交接或回滚证据。原始收据留在
被忽略的本机目录，不把云正文、凭据、私人数据或完整请求 ID 放入公开文档。

## 展示口径与 MOD-04B 接口需求

对每次 invocation 分开呈现：本地请求 ID 的脱敏引用、本地 task、目标 Runtime
配置、API 状态与解析结果、平台部署版本、平台 trace ID、平台 input/output tokens、
账单费用及各字段的来源/读回时间。实现展示时，本地回执只能支撑本地请求、
目标配置、API 状态及解析结果；未取得的平台字段须显示“未读回”。
`runtimeVersion=to-be-read-back` 必须显示为“未读回”，不能
作为真实版本。合并多个请求的 token 会掩盖失败重试或多次 invocation 成本。

MOD-04B 需在自己的文件锁内提出并验证最小适配增量：把**平台返回或平台查询
证实**的请求级部署版本、原生 trace 身份和 usage 与本地 invocation 关联；无法
精确关联时保留 `unknown`，并记录匹配依据。调用方生成的 `X-Request-Id`、配置的
Runtime 名称、API 200、模型正文和控制台当前 `Latest` 都不能代替这些字段。
字段位置、是否由 Invoke API 返回或另查观测接口，以及公共 DTO 形状均待该模块
根据真实脱敏结构证据确定；本 MOD 不猜供应商响应字段、不新增旁路解析器。
单次费用只能来自可核对的账单/定价读回，不能按 token 猜金额。

## 故障核实与发布恢复

1. 先保留本地 task/revision、一次性审批与执行回执、脱敏请求 ID、发送时间和
   HTTP/解析状态。若 fetch 失败且没有 HTTP 状态，远端是否执行保持 `unknown`；
   不因当前 trace 列表未出现记录而断言未执行，也不盲目补发有副作用的请求。
2. 只读核对同时间窗的平台 trace、Runtime 状态和可用的原生请求关联字段，再读回
   本地任务、工具 confirmed/unknown 记录及目标系统状态。无法消除歧义时保持
   `waiting_reconciliation` 或等价的未核实状态，由受信 Runtime 决定后续处理；
   不让 UI 或云端文字改写本地终态。
3. 需要回退发布时，先读回当前应用版本、Runtime 实际绑定、API 渠道及**此前已
   验证**的候选版本；这些任一缺失都不能声称“可一键回滚”。在授权的发布操作后
   分别读回新绑定、健康/错误和一个无副作用合成调用及其 trace，确认 Competition
   Profile 没有静默切到 Local。平台是否支持原位回滚及其具体 API 尚未验证。
4. 发布回退不会撤销已经 confirmed 的本地读取或 graph revision 9 的写入。若确需
   修正本地结果，应通过新的版本化修复、独立预览、Policy 批准、CAS 与读回；
   不能删除历史或重放旧审批。

MOD-32 剩余验收：新版本与请求级部署绑定、精确 trace/usage/费用读回、平台失败
及回退演练、角色交接与评估、无静默 Local 回退。真实云调用和发布变更需由主控
协调单槽资源；本文没有运行它们。
