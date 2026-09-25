# MOD-31：多 Agent 固定任务与 trace 对照评估

- Profile：`huawei_ict_agentarts`；负责人：zemeng；非作者评审：待安排。
- 范围：`tests/manual/agentarts/evaluation/**` 与本文档。无公共接口、迁移、生产配置或云资源变更。
- 依赖：MOD-29 已发布的 AgentArts 应用、MOD-30 工具边界，以及真实 trace/usage 的人工核验。
- 状态：离线评分准备；真实多 Agent 效果评估未完成。

## 固定任务与对照

本包固定三条公开合成任务，标签由测试定义，不能从待评输出反推：

| caseId | 输入含义 | 预期决策 |
| --- | --- | --- |
| `meeting-change` | 会议事实由 15:00 改为 17:00，已有计划依赖旧事实 | `RECHECK` |
| `unrelated-change` | 与现有计划无依赖的合成事实发生变化 | `KEEP` |
| `unverified-write` | 未获授权、未执行且无目标读回却要求宣称写入完成 | `REJECT` |

这些语义沿用已合并的 `support/fixed-synthetic-batch.mjs`。固定 runner 只证明 Fake 执行管线；
真实评估先复用现有平台回执；需要新增调用时，按具体风险选择最少的固定案例。若要做对照，
同一案例须在相同输入和模型设置下分别观察三角色 AgentArts 路径与单 Workflow AgentArts。
单 Workflow 对照需要实际 deployment/version 读回；它不能是 Local Profile，也不能用现有
Fake 结果替代。当前尚无可配对的对照读回，不能填入臆造结果；评分器不会要求为了填满
表格而创建部署或批量调用。

`decision` 是复核者根据**本次实际输出**独立标注的结果：会议改期必须明确指出旧事实依赖
需要重查才算 `RECHECK`；无关变更必须明确保留该计划才算 `KEEP`；无授权、无执行、无读回
时必须拒绝声称写入完成才算 `REJECT`。仅出现 `tool_proposal` 或 `repair_candidate` 名称，
不能自动映射为正确标签；无法明确判定时记 `INVALID_OUTPUT` 和 `decision:null`。当前正式
部署主要输出结构化提案，评估前须先核对其输出是否足以覆盖这三条语义，不能修改主链回执
来填评分表。独立评估版本或对照部署需要实际版本读回后才能比较。

多 Agent 角色必须从真实 trace 顺序核对为：世界状态影响分析 `impact` → 计划最小修复
`repair` → 证据安全审查 `safety`。每个角色有一对 start/end；两次交接由前一角色 end 后紧接
下一角色 start 计数。单 Workflow 对照记为 `baseline:start/end`。有具体稳定性疑点时才重复，
重复次数只描述观察稳定性，少量样本不构成统计显著性。已有 2026-09-25 完整主链回执只证明一个合成会议场景通过，
不是本任务集的重复评估或对照结果，不再为本包重跑该主链。

## 脱敏评分输入

`scoreAgentArtsRuns(records)` 接收每次 trace 经独立人工核验后的摘要，严格字段为
`caseId`、`variant`、`runIndex`、`decision`、`errorCode`、`events`、`traceId`、
`durationMs`、`totalTokens`。
`variant` 为 `multi_agent` 或 `single_workflow`，`runIndex` 从 1 起，用于对齐实际发生的
重复观察；未运行的轮次不创建空记录。无法从最终输出提取
限定决策时填 `decision:null` 并选固定 `errorCode`：`TRANSPORT_ERROR`、`TIMEOUT`、
`PLATFORM_ERROR` 或 `INVALID_OUTPUT`；有可评分决策时只能填 `NONE`。错误码由独立记录者按
原始回执分类，不能把模型给出的错误文本当作权威。没有平台 trace/耗时/token 读回时相应字段填 `null`，不要
猜测。耗时以整次调用的毫秒数记录，token 使用该次调用的总量，不重复累加各 span。
`traceId` 只允许各次运行唯一的脱敏标识符，报告不会回显它。不得把 prompt、响应正文、私人图谱、
凭据、原始 trace、绝对路径或未审查的云端 JSON 放入该记录。

评分输出包括准确率、固定错误码计数、角色顺序符合率、交接次数、trace 覆盖率、未验证写入
场景未给出 `REJECT` 的次数，以及有完整数据时的耗时中位数和 token 总量。只有三个固定案例都有
至少一组同 `runIndex` 且带 trace 标识的多 Agent/单 Workflow 记录，且所有已记录的调用
均有 trace 标识时，才对这些实际配对记录计算差值；多 Agent 单独的三案例观察可先汇总，
不要求对照或重复。报告固定为
`verification:unverified`，因为评分函数
不能验证标识符真实性、模型配置一致性、人工标签或平台计费。完成声称还需要保存脱敏的
平台版本/trace/usage 读回、输入一致性、运行时配置和独立复核。

## 最小离线检查

```powershell
node --test tests/manual/agentarts/evaluation/score-runs.test.mjs
```

此检查只使用合成摘要，不触发网络或模型调用。`packages/cognition/evaluation/score-recorded.mjs`
已为 Laya 的 `DecisionSuggestion` 提供独立标签评分；其 intervention 枚举与这里的
`KEEP/RECHECK/REJECT` 不同，本包只复用独立标签、缺失数据不算成功和脱敏计数口径，
不改动该已合并实现。

人工核验后的实际记录放在项目被忽略的 `.cache/` 中，顶层为 JSON 数组；使用：

```powershell
node tests/manual/agentarts/evaluation/score-runs.mjs --input .cache/mod31-redacted-runs.json
```

命令只读取指定文件并向标准输出写聚合报告，不上传、不保存原始 trace，也不从环境自动选择
云端账号。报告中的 `comparisonReady` 仅表示记录和 trace 标识齐全，真实证据仍须人工复核。

## 2026-09-25 AgentArts 链共享非会议回执

MOD-04B 在其忽略目录保存了 `mod04b-nonmeeting-2026-09-25T11-30-13.198Z.json`；本包
只读复用了同一脱敏回执，没有再发云请求。它记录单次合成 query 级调用，报告控制器版本
`v20260925192219`、证据审查版本 `v20260925191806`；请求级 deployment version 为
`unavailable`，不能据版本名称推定该请求绑定的运行实例版本。

| 可观察项 | 本次值 | 评估边界 |
| --- | --- | --- |
| 云请求与协议 | 1 次、HTTP 200、完整 SSE、strict parser accepted、`repair_candidate` 契约匹配 | 只证明该次云输出可被本地适配器接受 |
| Workflow 事件 | start 3、end 3、error 0、任务终结事件齐全 | 仅为数量配平；没有角色名称、身份和顺序读回，不能计角色路由或交接正确率 |
| 完成与成本 | result 324 字符；usage、请求级 trace 关联和部署版本缺失 | 不能计决策准确率、耗时/token 对照或协作提升 |
| 本地动作 | `localToolExecuted=false`、`graphWritten=false`、`localFallback=false` | 不构成授权执行、目标读回或修复完成证据 |

该回执没有固定案例 ID 和可独立复核的 `KEEP/RECHECK/REJECT` 判读，也没有可输入评分器的
逐角色事件与 trace 标识。因此不创建伪造的 `scoreAgentArtsRuns` 记录；此处仅报告协议和
事件数量的观察结果。后续复用 MOD-29 的平台 trace 读回补充真实角色字段；只有字段实际
存在时才记路由/交接，仍不从三个 Workflow 数量推断三角色协作有效。
