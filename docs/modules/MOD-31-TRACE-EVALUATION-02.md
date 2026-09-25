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
本评估要对同一任务、同一输入、同一模型设置分别运行已发布的三角色 AgentArts 路径和
单 Workflow AgentArts 对照，各案例各重复三次。单 Workflow 对照需要单独配置并记录
deployment/version；它不能是 Local Profile，也不能用现有 Fake 结果替代。当前尚无对照部署
及重复运行证据，不能填入臆造结果。

多 Agent 角色必须从真实 trace 顺序核对为：世界状态影响分析 `impact` → 计划最小修复
`repair` → 证据安全审查 `safety`。每个角色有一对 start/end；两次交接由前一角色 end 后紧接
下一角色 start 计数。单 Workflow 对照记为 `baseline:start/end`。重复次数只描述观察稳定性，
三次样本不构成统计显著性。已有 2026-09-25 完整主链回执只证明一个合成会议场景通过，
不是本任务集的重复评估或对照结果，不再为本包重跑该主链。

## 脱敏评分输入

`scoreAgentArtsRuns(records)` 接收每次 trace 经独立人工核验后的摘要，严格字段为
`caseId`、`variant`、`runIndex`、`decision`、`errorCode`、`events`、`traceId`、
`durationMs`、`totalTokens`。
`variant` 为 `multi_agent` 或 `single_workflow`，`runIndex` 为 1～3。无法从最终输出提取
限定决策时填 `decision:null` 并选固定 `errorCode`：`TRANSPORT_ERROR`、`TIMEOUT`、
`PLATFORM_ERROR` 或 `INVALID_OUTPUT`；有可评分决策时只能填 `NONE`。错误码由独立记录者按
原始回执分类，不能把模型给出的错误文本当作权威。没有平台 trace/耗时/token 读回时相应字段填 `null`，不要
猜测。耗时以整次调用的毫秒数记录，token 使用该次调用的总量，不重复累加各 span。
`traceId` 只允许各次运行唯一的脱敏标识符，报告不会回显它。不得把 prompt、响应正文、私人图谱、
凭据、原始 trace、绝对路径或未审查的云端 JSON 放入该记录。

评分输出包括准确率、固定错误码计数、角色顺序符合率、交接次数、trace 覆盖率、未验证写入
场景未给出 `REJECT` 的次数，以及有完整数据时的耗时中位数和 token 总量。只有 18 个槽位均有记录且
均有 trace 标识时才计算对照差值；报告固定为 `verification:unverified`，因为评分函数
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

人工核验后的 18 条记录放在项目被忽略的 `.cache/` 中，顶层为 JSON 数组；使用：

```powershell
node tests/manual/agentarts/evaluation/score-runs.mjs --input .cache/mod31-redacted-runs.json
```

命令只读取指定文件并向标准输出写聚合报告，不上传、不保存原始 trace，也不从环境自动选择
云端账号。报告中的 `comparisonReady` 仅表示记录和 trace 标识齐全，真实证据仍须人工复核。
