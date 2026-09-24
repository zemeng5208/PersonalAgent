# AgentArts 手工验收记录

本目录保存 `huawei_ict_agentarts` Competition Profile 需要真实账号或云端读回的验收记录。
记录只描述实际观察到的表面；配置、版本提交、部署、API、trace、工具闭环和本地 Evidence
必须分别证明，不能互相替代。

## 2026-09-12：持续认知多智能体首版

机器可读记录见 [`2026-09-12-multi-agent-build.json`](2026-09-12-multi-agent-build.json)。

通过华为云西南-贵阳一区域的 AgentArts 控制台直接读回：

- 多智能体 `PersonalAgent持续认知协调器` 已创建并提交第二版；控制器模型为
  `DeepSeek-V4-Flash`，最大对话历史 10 轮，最大跳转 9 次。
- 控制器已保存三个职责不同的任务工作流：世界状态影响分析、计划最小修复、
  证据安全审查；画布读回了三个子工作流名称和版本 ID。
- 第二版显式把世界状态影响分析绑定为起始工作流、计划最小修复绑定为默认工作流、
  证据安全审查绑定为结束工作流，不再只靠控制器提示词约定顺序。
- 控制器提示词明确云端只处理最小化事实与修复提案，本地 Runtime、Policy、
  ToolGateway、目标系统读回和 Evidence 仍是授权、执行与完成状态的权威来源。
- 四个资源提交版本后出现部署配置弹窗；本次均选择取消，没有填写模型 API Key，
  没有部署、试运行或发起模型调用。

因此，**2026-09-12 这份记录本身**只证明 AgentArts 构建、版本化、多智能体成员与
路由槽位配置的云端读回。当时 deployment、API、trace、usage、评估、知识/MCP/Skill、
工具提案与本地可信执行闭环均未验收；不能把当时的提交计为比赛 Golden Path 完成。

重新验收时应在不暴露凭据的前提下读回同一资源及版本；任何重新部署、试运行或
真实 API 调用都需要单独记录费用、身份、输入范围、trace 和失败/回滚结果。

## 2026-09-24 Competition Profile 证据索引

| 表面 | 当前可核对证据 | 证据边界 |
| --- | --- | --- |
| 云端构建与版本化 | [2026-09-12 控制台读回](2026-09-12-multi-agent-build.json)：多智能体和三个子工作流提交版本，起始/默认/结束路由槽位 | 当时取消部署；后续当前草稿/部署版本未重新读回 |
| 已发布部署的调用 | [有界多次云调用工具 MVP](TOOL-INVOCATIONS-MVP.md)：2026-09-24 三次独立 published API 合成探针，文字、提案、候选各 HTTP 200；另有同一本地 source task 的两次云请求均 HTTP 200 | 证明指定 published 端点能响应；未读回控制台当前 deployment/version、服务端 trace/runId、usage/费用 |
| 本地执行与修复 | [D2 PR #104](https://github.com/zemeng5208/PersonalAgent/pull/104) 的 `tests/manual/agentarts/MVP-ACCEPTANCE.md`（本地提交 `c2ec9a2`）、[A 脱敏调用读回](TOOL-INVOCATIONS-MVP.md)：合成读取经审批与 ToolGateway，候选经预览，本地修复另经审批/CAS，graph revision 9 与 Evidence 在同库重启后读回 | 初次手工脚本因自身断言失败；同库零云请求恢复单独通过；未证明云原生同 run 恢复或生产私人数据 |
| 平台评估与扩展能力 | 尚无当前评估分数、可复现评估集、知识/MCP/Skill 的真实云端读回 | 不据此声称完整比赛验收、正式演示或发布完成 |

后续云请求的调用方 `X-Request-Id` 只能关联本机请求，不代替平台 trace。上述索引
覆盖本次合成 MVP，不扩大为 AgentArts 原生暂停/恢复或全部比赛要求已完成。

## 固定合成分类 runner

[`support/fixed-synthetic-batch.mjs`](support/fixed-synthetic-batch.mjs) 提供 MOD-31 的离线
三案例分类 runner。它只接受显式注入的 CoordinationPort、未来 UTC deadline 和取消
信号；内置 prompt 不接收私人输入，也不写入案例预期答案。直接 CLI 要求 `--deadline`，
并始终使用返回私有固定序列的显式 Fake，仅验证 runner plumbing，不衡量模型能力；它不会
读取环境凭据或自动连接 AgentArts。输出只记录 case 状态、验证等级、固定错误码、计数和
耗时；`mock` 结果不构成真实 AgentArts、工具执行或 Evidence 验收。
