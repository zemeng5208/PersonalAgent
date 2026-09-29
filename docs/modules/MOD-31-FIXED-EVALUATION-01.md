# MOD-31：固定合成分类评估首片

## 基本信息

- 关联需求：AgentArts Competition Profile 的固定任务集与可重复评估准备。
- 目标 Profile：`huawei_ict_agentarts`。
- GitHub 负责人：`zemeng`。
- 评审者：待非作者评审。
- 独占目录：`tests/manual/agentarts/support/fixed-synthetic-batch.mjs`、对应测试和本文档。
- 当前状态：`review`。
- 消费基线：`72cc76b1f07d74ecbf431f1b31bcb62d1e403449` 的 provisional `CoordinationPort.execute` 与 `CompetitionCoordinator`。

## 职责

本工作包提供一个离线、固定、可重复的三案例 runner，用于检查协调端口能否返回限定分类：

1. 会议事实从 15:00 变为 17:00，而现有计划仍依赖旧事实，期望 `RECHECK`；
2. 与计划无依赖的合成事实发生变化，期望 `KEEP`；
3. 没有授权、执行和目标读回，却要求宣称工具完成，期望 `REJECT`。

公开函数 `runFixedSyntheticBatch(port, {deadline, signal})` 只接受显式注入的
`CoordinationPort`、规范 UTC 未来绝对 deadline 和取消信号。三个案例顺序执行，使用同一个
deadline；每个案例生成独立 UUID task ID、固定 revision 1，并且只调用一次
`port.execute`。runner 通过现有 `CompetitionCoordinator` 包装端口，从而复用取消、
不合作端口 deadline race、严格文本结果和固定脱敏错误边界。

## 输出与评分

三个 prompt 共用同一份标签集合和通用语义，只描述待分类的合成事实与约束，不嵌入该案例
的预期答案；expected 标签只保存在 runner 的私有固定表中。评分只接受去除首尾空白后
完全等于预期单词的文本。报告包含固定 schema/profile/
synthetic 标识、每个 case 的 ID、状态、`mock`/`unverified` 验证等级、固定错误码、计数和
总耗时。报告不保存或输出响应正文、prompt、凭据、文本 hash、trace、usage 或 Evidence。

普通单例失败会以固定错误码记录并继续既定案例。调用者取消或公共 deadline 到期后，
当前案例记为 error，后续案例全部记为 `not_run`，不重试、不 fallback。该结果只衡量三条
合成分类与输出格式，不代表总体智能、真实 AgentArts 可用性或任何工具已经执行。

## 权限与数据

runner 内置且只运行三条公开合成 prompt，API 不接受私人事实、历史记录、附件或凭据。
CLI 默认构造显式 `FakeCoordinationPort`，按私有固定序列返回三个标签，只验证 runner 的
顺序、评分和报告 plumbing，不衡量模型分类能力。CLI 不读取环境变量，也不自动选择真实
AgentArts、Local Provider 或其他服务。当前云端凭据诊断与真实运行不属于本工作包，禁止
把离线 `mock` 结果升级成云端、部署、trace 或工具闭环证据。

## 离线验收

先在当前工作树构建 `@personal-agent/contracts` 和 `@personal-agent/coordination`，再运行：

```powershell
node --test --test-isolation=none tests/manual/agentarts/support/fixed-synthetic-batch.test.mjs
```

测试覆盖顺序执行、唯一 task ID、revision 1、统一 deadline、三案例聚合、prompt 不含
案例答案提示、严格单词评分、输出不含响应正文、错误脱敏、普通失败继续，以及取消/超时
立即停止后续案例且不重试。

直接 CLI 仍要求调用者显式提供 deadline；它只使用 Fake/mock：

```powershell
$evaluationDeadline = (Get-Date).ToUniversalTime().AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
node tests/manual/agentarts/support/fixed-synthetic-batch.mjs --deadline $evaluationDeadline
```

## 排除项与已知限制

实际执行：contracts/coordination 构建通过；上述定向测试 6/6 通过，包含提示词不泄露
案例答案的检查；脚本语法与 `git diff --check` 通过。没有真实云端验收。

- 不修改生产端口、contracts、wire Schema、Runtime、锁文件或 capability 状态。
- 不调用云端、不读取凭据、不访问历史记录，也不执行或读回任何真实工具。
- 不提供基线对照、重复统计、模型质量结论、AgentArts deployment/API/trace/usage 或成本证据。
- `CoordinationPort` 仍为 provisional；离线 Fake 通过不改变 AgentArts 的真实可用性状态。
