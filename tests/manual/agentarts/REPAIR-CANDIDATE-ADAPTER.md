# 显式版本化候选：云适配消费

负责人 zemeng（A，MOD-04B/29/30/32）；目标 huawei_ict_agentarts；状态 review，
真实验收未完成。公共类型和严格 parser 归 B，依赖提交 `6d3234315057292971959f3fbafac4bda12c486e`。
字段定义与预算的唯一依据为 [MOD-30-REPAIR-CANDIDATE-01](../../../docs/modules/MOD-30-REPAIR-CANDIDATE-01.md)，
适配器不另建 DTO、Schema、校验规则或本地写入入口。

## 可信配置

```ts
{
  responseMode: 'tool-proposal-json',
  repairCandidateVersion: '1.0'
}
```

两项都必须显式开启。text 与 candidateVersion 同时配置、未知版本和未知mode在构造
阶段拒绝；已有默认text行为不变。即使公共结果union认识repair_candidate，未开启
candidateVersion的JSON适配也明确拒绝它，不允许公共parser扩展静默改变已有部署能力。
配置由构造器复制，外部对象后续变更不能启用候选。续接仍要求B的同步beforeSend门禁。

云端对象只允许 `kind:'repair_candidate'`、`candidateVersion:'1.0'` 和 B定义的
candidate。适配先拒绝任意云verification，再补host固定unverified并交公共parser；
旧版本、额外Evidence/权限/task字段、非法revision或图变更均拒绝。收到候选不写图、
不执行工具、不表示已完成本地修复。Runtime显式启用、typed checkpoint/read和合法
本地提交由B负责，D不从resultSummary抽取隐藏协议。

## 云端最终节点增量约束（仅启用本版本时）

只有可信宿主提供了本次实际graph snapshot的baselineGraphRevision、允许目标NodeRef、
当前依赖NodeRef及必要合成事实后，云才可输出候选。不能用假定版本、示例id或模型
推断替代本地引用。当前只有会议时间的投影不足以生成候选，必须返回text说明输入缺失。
Fact/Evidence与允许目标的映射属于宿主，云JSON不得携带这些权威绑定。

输出使用B示例形状：

```json
{"kind":"repair_candidate","candidateVersion":"1.0","candidate":{"expectedGraphRevision":6,"changes":[{"node":{"id":"prepare","revision":1},"summary":"Prepare at 16:00","reason":"Meeting moved to 17:00","dependencies":[{"id":"meeting","revision":2}]}]}}
```

数值和id只是合成形状示例，实际输出必须逐项来自本次提供的可信快照引用。
保持与事件无关的计划不变。没有合法修复或缺少引用时用原有kind/text返回原因，
不返回空changes伪装候选，不把最后的ALLOW/REJECT替代完整建议，也不伪称已执行。
所有建议必须经过本地parser、目标范围/Fact版本绑定、只读preview和显式批准，
最终提交经既有Policy/ToolGateway执行CAS，云端不能直接取得该权限。

## 验证

在A工作树合入上述精确B依赖后，Node24.15编译通过；公共parser4项、adapter候选4项、
提案/续接/最终门禁13项，共21/21通过，git diff --check通过。
没有改动B公共parser/Runtime实现，没有运行云端、Desktop、本地写图或整个产品验收。
此记录不替代B/D组合验证、CI和goo122等已登记非作者批准；接口仍provisional。
