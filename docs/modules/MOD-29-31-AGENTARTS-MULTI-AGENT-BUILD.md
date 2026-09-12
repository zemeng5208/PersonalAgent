# MOD-29～31：AgentArts 持续认知多智能体构建首片

- 日期：2026-09-12；Profile：`huawei_ict_agentarts`。
- 负责人：zemeng；状态：review（云端配置已读回，仓库记录未评审）。
- 分支：`codex/zemeng/agentarts-multi-agent-evidence`；基线：`87ee444`（PR #38）。
- 范围：AgentArts 多智能体与三个任务工作流的构建、版本提交和配置读回。
- 不在范围：部署、API、trace、真实模型运行、知识/MCP/Skill、工具执行、评估和本地适配。

## 云端结构

`PersonalAgent持续认知协调器` 使用 `DeepSeek-V4-Flash` 作为控制器模型，最大对话历史
10 轮，最大跳转 9 次。控制器只基于输入中明确提供的最小事实与 revision 协调：

1. `PA-世界状态影响分析` 识别事实变更的直接和传递影响；
2. `PA-计划最小修复` 对既有计划提出 KEEP、RECHECK 或最小范围 REVISE；
3. `PA-证据安全审查` 核验来源、验证等级、权限边界和安全风险。

三个任务工作流和多智能体均已提交首版。控制器画布已读回三个成员及各自版本 ID；
机器可读的资源标识、版本和未验证项记录在
[`tests/manual/agentarts/2026-09-12-multi-agent-build.json`](../../tests/manual/agentarts/2026-09-12-multi-agent-build.json)。

## 信任与状态边界

云端提示词禁止声称已经执行本地工具、取得授权、生成可信 Evidence 或改变 Task/Goal
终态。AgentArts 输出仍是不可信外部输入；本地 Runtime 校验 task、revision、deadline
和 scope，Policy/ToolGateway 决定授权与执行，目标系统读回和 Evidence 决定是否完成。

版本提交后平台弹出了可能收费的部署配置。本次全部取消，没有填写 API Key、部署、
试运行或调用模型。因此这只把“资源是否存在、是否版本化、成员是否保存”从设计意图
提升为云端直接读回事实；AgentArts 生产 capability 及比赛 Golden Path 仍为
`unavailable`，不能静默回退 Local 或 Fake。

## 继续入口

1. 明确部署费用、身份和最小出机数据后，部署固定版本并读回 deployment/version；
2. 通过正式 API 发起合成场景调用，保存 trace、usage、输出校验和失败语义；
3. 扩展 CloudAgentPort，使 deployment/version/trace/usage 使用显式 DTO，而不是塞入文字；
4. 打通只读工具提案到本地 Policy/ToolGateway/目标系统读回/Evidence 的可信闭环；
5. 用固定任务集重复评估多智能体必要性、顺序、预算、降级和最小修复准确率。

本片没有公共接口、Schema、迁移、Runtime 或锁文件修改。
