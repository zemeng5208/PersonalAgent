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

## 2026-09-17：云端文字成功与 Desktop 失败读回

机器可读记录见 [`2026-09-17-runtime-text-success.json`](2026-09-17-runtime-text-success.json)。
已发布多智能体版本 `v20260917160941` 的一次最小合成文字调用返回 HTTP 200/SSE；
三个工作流均产生 completion answer，响应随后出现 `task_end` 和 `end`，`errors=[]`。
AgentArts 控制台另行读回 trace `beb5adfe9bbb8bc5520fe60d573ea828` 为成功。
SSE 事件序列与平台 trace 是两类独立证据；前者不能冒充平台 trace，trace 中的 token
指标也不等于已完成账单、费用或聚合 usage 读回。

同日以隔离 Desktop 数据库发起的一次真实 Competition 任务已受理并运行约 69 秒，
但本地终态为 `failed`，错误被净化为 `EXTERNAL_FAILURE`，没有 result 或 Evidence，
也没有静默回退到 Local/Fake。随后在不提交任务、无云调用的条件下重启 Desktop，
同一数据库仍读回该 `failed` 终态、`verification=unverified` 与空 Evidence。

既有适配器只消费 `message.data.text`，而脱敏云端采集保留的是三个
`workflow_end.data.answer` 及完整终止事件，因此最初形成了响应解析假设。该兼容修改完成
离线定向测试后，又经用户单独授权执行了一次真实 Desktop 合成任务；第二个独立任务仍在
约 69 秒后以同一净化错误进入 `failed`，同库无提交重启也保持该终态。没有自动重试。

两次 Desktop 脚本均未保存原始响应或无内容事件统计；第二次运行的 AgentArts 平台 trace
因当前浏览器表面不可用而未能读回。因此离线 fixture 只证明新选择规则自身的兼容性，不能
证明它命中了真实根因，也不能在没有证据时继续归因为 terminal 顺序。后续改生产解析前，
需要在另行授权的调用中仅采集 HTTP/content type、事件名、字段类型、计数、顺序和有界大小，
并区分云端节点错误、字段形状、体积限制、SSE framing 与终止事件顺序。云端文字链仍为
`conditional`；Desktop 成功闭环、结构化工具提案、本地 Policy/Approval/ToolGateway、
目标系统读回、本地可信 Evidence、usage/cost、评估、回滚及凭据轮换仍未验证。

## 后续诊断的执行与证据边界

下一次真实调用前，先用离线合成响应验证诊断辅助代码；测试通过不是发起云调用的授权。
两次已批准调用均已使用，不自动重试或复用这两次授权。新调用需明确入口、合成输入、
凭据来源及次数；凭据只由可信测试宿主在内存提供，不写入示例、命令参数、报告或日志。

- 诊断仅输出 HTTP 状态、归一化媒体类型、白名单事件类别、字段类型、长度、计数及
  有界顺序。未知事件名归入固定 `other`，不能原样输出外部事件名或错误文本。
- 不采集请求 URL、请求体、Authorization、其他头值、回答正文或原始响应；结构数据
  也不能带入任意外部字符串。观测上限达到后明确标记截断，不据缺失事件判断云端未执行。
- 通过现有 `fetchImpl` 注入的辅助工具只用于隔离测试宿主，不修改生产错误净化、
  解析准入、重试策略、公共协议或 Runtime 状态逻辑。结构观察只能缩小候选范围，不能
  自动证明适配器内部失败分支。
- 若直接使用 Runtime Application 入口验收，必须标明没有经过 Desktop/IPC；即使
  该入口成功，也不能补记为 Desktop 成功。平台 trace 仍需独立读回。
- 每次记录独立任务与实际代码版本，保留成功或失败终态；重启读回不提交新任务。
  成功文字仍为 `unverified`，不能作为工具执行、授权或可信 Evidence 的证明。

诊断辅助代码的离线验证入口为
`node --test tests/manual/agentarts/support/structural-fetch.test.mjs`。
它不读取本机凭据或环境配置、不联网，不要求启动 Electron。调用方将
`createStructuralDiagnosticFetch(innerFetch).fetch` 注入现有测试宿主的 `fetchImpl`；
只在响应消费结束后取得 `finish()` 的结构快照，不把原响应或异常对象写入日志。
达到诊断采集上限只停止采集，不截断交给适配器的响应；报告中的截断、饱和计数和未知值
不代表云端未发送对应事件，也不能代替生产适配器的协议校验。

事件结构分析当前仅支持 SSE，JSON 的事件观察标为 `json_unparsed`，不是“没有事件”。
仅有 `.text()` 的测试替身无法证明原始响应字节数，报告标为 `unavailable`。
2026-09-17 离线辅助测试 18/18 通过；本机普通测试进程启动遇到 `spawn EPERM` 后使用
`node --test --test-isolation=none tests/manual/agentarts/support/structural-fetch.test.mjs`
通过。另以原生 `Response`、合成 SSE 和已构建的真实 `AgentArtsCloudAgentPort` 完成
不联网组合验证：一次 fetch、正确文字结果、`unverified`，快照无正文。未据此宣称云端成功。
