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

因此，本记录只证明 AgentArts 构建、版本化、多智能体成员与路由槽位配置的云端读回。
deployment、API、trace、usage、评估、知识/MCP/Skill、工具提案与本地可信执行闭环
仍为 `unavailable`，不能把本次记录计为比赛 Golden Path 完成。

## 2026-09-13：运行时部署与首个 API 失败读回

机器可读记录见 [`2026-09-13-runtime-deployment.json`](2026-09-13-runtime-deployment.json)。
AgentArts 控制台已读回正常运行的运行时、已发布访问方式和 API 网关；使用纯合成文字进行的
真实 API 调用到达运行时并返回 SSE execution/workflow 标识，但首个工作流因模型鉴权错误失败。
这证明本地到 AgentArts 的网络与入站鉴权已接通，不证明模型执行、多智能体完整路由、trace、
usage 或比赛 Golden Path 成功。验收记录不包含任何 API Key；交付前必须轮换曾暴露于工具输出的
入站凭据，并重新完成成功 API、trace 和 Desktop 读回。

重新验收时应在不暴露凭据的前提下读回同一资源及版本；任何重新部署、试运行或
真实 API 调用都需要单独记录费用、身份、输入范围、trace 和失败/回滚结果。
