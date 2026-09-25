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

## AgentArts 链共用回执索引

04B 统一协调 MOD-29/30/31/32 的一次联合验收。当前可共同引用的是上述 **9 月 25 日
合成会议**回执；新一批非会议目标调用须使用其自己的请求和平台读回，不能拼接这批
会议回执或 PR #108 的较早 trace。各模块在同一批回执上的可证明部分如下：

| 责任模块 | 同批可追溯证据 | 仍缺的同批证据 |
| --- | --- | --- |
| MOD-04B | 两次独立 published API 均 HTTP 200、完整 SSE，严格解析为提案与候选；本地调用方有各自请求 ID | 平台原生请求关联；普通非会议目标对真实公布能力的消费 |
| MOD-29 | 提交应用版本 `v20260924225602` 的页面结果及运行时“正常”读回 | 两次请求各自命中的部署/版本，`Latest` 与已发布应用版本的精确绑定 |
| MOD-30 | 严格工具提案经本地一次性审批、受控读取、目标读回；候选经独立预览/批准、CAS 写图与 Evidence/重启读回 | 平台原生同 run 恢复和普通非会议能力闭环；不能把本地工具执行写成云端直接执行 |
| MOD-31 | 这批回答经过已发布多智能体应用；PR #108 的较早 trace 仅显示三个 `UserInput`/模型活动 | 本批角色交接 trace、必要性/基线对照、固定评估集及失败分支 |
| MOD-32 | 本批 API 状态、本地任务终态和 graph/Evidence/重启结果分别有回执 | 本批每请求 trace/usage/费用、失败核实、发布回退和无静默 Local 回退的独立证据 |

新批次只增补实际出现的证据和缺项；不为每个 MOD 另跑主链或新建采集脚本。

### 2026-09-25 非会议单次候选：独立回执

MOD-04B 已有脱敏回执 `mod04b-nonmeeting-2026-09-25T11-30-13.198Z.json`
（隔离工作树忽略目录，仅本机保存）。11:30:13—11:30:53 UTC 的一次合成
`draft-review`/`delivery-deadline` query 使用新的调用方请求 ID `11ba1b05…6c2e`：
一次云请求、HTTP 200、完整 SSE、三对 workflow 开始/结束、零 error event；
本地严格解析得到匹配契约的 `repair_candidate` v1.0，验证等级仍为
`unverified`。回执明确 `localToolExecuted=false`、`graphWritten=false`、
`localFallback=false`、`automaticRetry=false`。这只证明普通非会议输入的一次
query 级候选格式，不证明工具提案、本地审批/执行、真实 continuation、Policy/CAS
或目标系统读回；不能与上方会议链拼成新的端到端通过。

该回执报告主控版本 `v20260925192219`、证据审查版本 `v20260925191806`，
但 `requestDeploymentVersion=unavailable`。MOD-29 对同一时间窗作平台只读核对：
一条成功 trace `668c…736d` 于 19:30:13 CST 开始，耗时 38,937 ms，
平台显示 3,365 input + 2,288 output = 5,653 tokens；可见输入与本次合成
`draft-review`/`delivery-deadline` 语义相符，末段模型输出有候选。它与本地
请求按时间和输入语义**候选关联**；平台未回显调用方 `X-Request-Id`，本地响应
也没有 server trace ID，因此不是精确 ID join，不能将 5,653 tokens 标为本请求
已核实的 usage 或换算为费用。

MOD-30 调用前读回原运行时正常、`Latest=v8` 及上述应用版本/两个引用；这证明
预调用平台状态，不证明该请求命中的部署版本。trace 根 span 的
`resource_version:"draft"` 也不是运行时版本。MOD-31 可复用该 trace 的三个
`UserInput`/模型 span，但它们没有各设计角色名称或交接标识，不能宣称角色交接
已证；固定评估和基线对照仍缺。
MOD-04B 的 [PR #128](https://github.com/zemeng5208/PersonalAgent/pull/128)
涉及 continuation prompt，但本次只有首次 query；PR 存在不能替代其真实续接验收。

## 展示口径与 MOD-04B 接口需求

对每次 invocation 分开呈现：本地请求 ID 的脱敏引用、本地 task、目标 Runtime
配置、API 状态与解析结果、平台部署版本、平台 trace ID、平台 input/output tokens、
账单费用及各字段的来源/读回时间。实现展示时，本地回执只能支撑本地请求、
目标配置、API 状态及解析结果；未取得的平台字段须显示“未读回”。
按时间/输入找到的平台 trace 可另列为“候选关联”，附匹配依据与观察时间，
不能放进精确请求级 trace/usage 栏。
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

## 四层完成状态（2026-09-25）

| 层级 | 当前证据与状态 | 进入下一状态的最小条件 |
| --- | --- | --- |
| 代码 | `origin/main@ec43a55` 有 provisional AgentArts 适配；请求级平台版本/trace/usage 仍无可验证读取。MOD-32 本包只新增证据文档，不能算功能实现完成 | MOD-04B/29 根据真实脱敏结构交付请求关联和可信展示所需数据；保留 unknown 与失败路径 |
| PR | 本包 [#134](https://github.com/zemeng5208/PersonalAgent/pull/134) 为 draft；较早证据 [#108](https://github.com/zemeng5208/PersonalAgent/pull/108) 和集成 [#104](https://github.com/zemeng5208/PersonalAgent/pull/104) 仍各有独立依赖与评审。创建 PR、CI 或作者自查均不等于合并 | 各 owner 解决自己的冲突/依赖，取得已登记非作者评审，再以最新 Git/PR 状态核实合并 |
| MOD-32 真实验收 | 合成会议链的两次云 API 与本地执行/重启已通过；另一次非会议 query 级候选匹配但未执行工具，其平台 trace/token 仅能按时间与输入语义候选关联。请求级部署版本、精确 trace join、usage、费用、失败及回退仍未读回，MOD-32 保持 `in_progress` | 复用 AgentArts 链同批回执逐请求读回版本/trace/usage 与账单依据，另行验证失败核实和发布回退；每项保存脱敏证据 |
| 整体 MVP | 单个合成 Golden Path 不能证明除 Windows 打包安装外的全部约定功能；本 MOD 也不能代表其他 zemeng 模块或 goo122/Potatos 模块完成 | 主控汇总各模块的代码、非作者评审/集成、真实场景读回后逐项判定；未满足的项继续列缺口，不用本记录代替全项验收 |

MOD-32 剩余验收：新版本与请求级部署绑定、精确 trace/usage/费用读回、平台失败
及回退演练、角色交接与评估、无静默 Local 回退。真实云调用和发布变更需由主控
协调单槽资源；本文没有运行它们。
