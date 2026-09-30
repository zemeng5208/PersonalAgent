# MOD-06 / MOD-07 首版 Competition 纵片

- Profile：`huawei_ict_agentarts`；PA-005 MCP / PA-006 Skills。
- 状态：`review`，不等于整版 MVP 或接口 frozen。
- 负责人：本专项代表 zemeng；范围 `packages/mcp/**`、`packages/skills/**` 和本文。根/Runtime/IPC/Renderer/lock 由 P8 唯一消费；远端 PR/合并由专线处理。
- 工作树：`.worktrees/mcp-skill-mvp`，`codex/mcp-skill-mvp`，基线 `01ca1c7541f5b29c47b06df50542f6e8cc0bc9ab`。未修改共享生产文件、凭据、数据库或其他工作树。
- 依赖：现有 provisional RegisteredTool/ToolContext/ToolHost、AgentToolPort/AgentWorkerContext、ToolGateway/Policy/Runtime checkpoint；无 Schema/wire/迁移变更。接口目录此前 unavailable，本次仅模块生产实现，不自行提升冻结等级。

## P8 准确装配

1. 根 dependency/唯一 lock：`@personal-agent/mcp` / `@personal-agent/skills` `0.1.0-alpha.1`。MCP 依赖 SDK `1.31.0` 与 filesystem `2026.8.31`，来源与许可见包 README。Skills 只按类型消费现有 agents 端口，不新增 Local Agent 执行。
2. 新包 build 放在已有 contracts/agents 产物之后；新模块 tests 依赖现有 policy/tool-gateway 产物。发布保留 Skill bundle；不更新 Node/根工具链。
3. trusted main：`createReadonlyMcpHost({nodeExecutable,rootPath,enabled?})`；入口来自已安装固定官方包，不接模型命令/args/server URI。必须 `await start({deadline,signal})`，真实发现确认后 health.connected 才能 available。`RuntimeApplicationOptions.tools: [...existingTools,...mcp.tools]`，或者明确 `register(ToolHost)`；两者不能重复注册。`await setEnabled(false)`、`await stop()` / `await dispose()`；dispose 释放 register 创建的注册，tools 数组则由其装配宿主统一释放。
4. `competitionToolAvailability` 唯一条 `{toolName:'mcp.workspace.read_text',toolVersion:'1.0.0',available:()=>mcp.health().connected}`。仍需宿主批准 root/path 范围；连接成功不会签授权。disabled/error 时目录不对云公布；已有 task snapshot 缓存不得覆盖实时执行检查。
5. `CompetitionToolExport` **默认拒绝原文出机**。只能在既有明确的合成/公开参考授权范围提供 `accepts`，绑定 task/proposal/path；`project` 返回宿主白名单投影，例如 `{source:'approved-reference',contentDigest,readConfirmed:true}`。不自动导出原文、真实相对私人路径、绝对路径、授权引用、raw Evidence。云端需要正文/摘要时必须有对应既有数据出机授权，不能因 skill manifest 或工具 annotations 自动批准。
6. Skill：`createReferenceSummarySkill({tools:existingAgentToolPort,isToolAvailable:()=>mcp.health().connected,enabled?})`；`manifest()` 提供 ID/version/digest/inputSchema/capabilities。受信 worker 调用 `invoke({skillId,version,digest,path},context)`。传现有 taskId/deadline/signal/saveCheckpoint/loadCheckpoint/reportProgress；端口必须是原 Runtime 授权/锁/执行路径。**不把 Skill 包成工具后嵌套调用 tool.invoke**；两步 worker 应由 Application dispatcher 调用，Runtime 根据返回 state 管理 waiting_approval/waiting_reconciliation/确认和终态。外部 schema/API 路由由 P8 装配，模块不私造公共 wire operation。
7. 管理后台仅健康投影：MCP `configured,enabled,connected,state,errorCode?,protocolVersion?,discoveredTools,exposedTools`；Skill `configured,enabled,connected,state,id,version,digest`。启停从 trusted main 管理，Renderer 不获得 Node、shell、root、PID、凭据、AgentToolPort。Skill ready 依赖真实 MCP health，注册工具不等于连接。
8. Skill checkpoint key `skill:workspace-reference-summary:v1`，同任务固定输入/version/digest；已确认读取不重复，started/unknown 不重放，pending 审批复用稳定 runId。`setEnabled` 同步，`dispose` 同步；MCP lifecycle 异步须 await。
9. 恢复增量新增可选 `ReferenceSummaryOptions.reconciliation: SkillReadReconciliationPort`，root exports 同时提供 `SkillReadReconciliationQuery`。端口 `currentConfigurationRef(): string | undefined`，`readConfirmed(query): Promise<ToolInvocationResult | undefined>`；query 扩现有 AgentToolInvocation，固定 `toolName/toolVersion/arguments:{path}`，加 `skillId/skillVersion/skillDigest/argumentsDigest/configurationRef`。P8 用可信主进程的 workspace readBinding（root/Node 当前身份+会话 generation）的 SHA-256 作为不透明 ref，首次 Skill 开始存 checkpoint；未启用/变更/撤销为 undefined。原始路径不进入 manifest/UI/云。
10. adapter 只读 `runtime.readToolExecutions(taskId)` 中 evidenceId=原 runId 的记录，验证 confirmed、policyDecision allow、executionStarted、toolName/version，使用 `runtime.matchesToolExecutionInput(record,{arguments:{path},scopeRef:runId})`，读取原 `runtime.loadCheckpoint(taskId,'tool-result-'+runId)`，核对原 task/Evidence refs。验证 query 的 Skill 与原绑定和当前配置，不接受 Renderer receipt，不调用 invoke/grant，不新建/替换 runId。argumentsDigest 为参数摘要；Runtime inputDigest 仍用原公开匹配函数。Skill 原始 started/unknown 经确切确认可晋升 read-confirmed，只继续摘要；无确认/错 Evidence/path/SHA、配置变化保留待核实或明确拒绝。旧 48fbedd9 checkpoint 缺原配置引用不能猜 root，仍 unknown；Runtime 统一决定 waiting_reconciliation/终态。
11. 公开资料出机增量：`createPublicReferenceExport({currentConfigurationRef,readAuthorization,readConfirmed})`，类型 `PublicReferenceExportQuery/Authorization/Options` 均从 MCP 根 exports 提供。结构兼容既有 `CompetitionToolExport`，policy version `2.0.0`。native-only 同步 `readAuthorization` 对精确 `{taskId,proposalId,path,configurationRef}` 返回 `{authorizationId,contentDigest,expiresAt}`；工作区读许可不替代出机许可。同步 `readConfirmed({...query,contentDigest})` 只读原 Runtime，返回 `{runId,result:McpReadResult}`，宿主须校验原 proposal 对应实际 run、参数/scope/工具/版本、confirmed/Policy allow/checkpoint/Evidence。helper 绑定 tuple/许可与稳定 run，在 accepts/project 及投影结束重查配置/授权/过期，核对正文/path/SHA；默认拒绝，唯一出机值仍为步骤 5 的三字段投影。P8 唯一维护 native 许可、原任务绑定及真正云调用前 existing export guard；本包不新增授权机制、taskstore 或数据库。宿主释放时调用 helper.dispose。
12. complete Skill checkpoint 重放也验证原 configurationRef；原会话撤销/替换而新服务 connected 时不返回旧摘要，不重复工具读取或确认 Evidence。

## 当前消费与云边界

P8 2026-09-30 回报：总装已有 `apps/runtime/test/reference-skill-application.test.mjs` 的实际官方 SDK + SQLite 原确认恢复和 routine exact-read 两条 case 通过；原 TaskRuntime run/Evidence 复用，确认恢复零重读。本包未重复执行该集成用例，最终准确 HEAD/日志、后台 UI/真实云验收归 P8 的统一收据。

云专项当前固定选择目录仅含已公布的 `mcp.workspace.read_text@1.0.0`，沿现 `goal/availableTools` 与 continuation；Skill 自身未公布为云可选工具。原生提交 Skill → 现 Runtime worker 不等同云显式选择 Skill。不得用 roleLabel/goal 的任意文本约定新命令，不嵌套 RegisteredTool.execute，不私造 Cloud DTO；P8 决定原 worker 最小接线并读回真实结果后，才可声明相应云 Skill 链完成。

## 验证收据

2026-09-30，本任务安装到忽略目录，未改根 lock。PATH Node `26.3.0` / bundled Node `24.19.0`，项目约束 `24.15.x`；未擅自升级/另装 Node，因此精确项目 Node 版本验收交统一环境。使用仓库 TypeScript `5.9.3` / `@types/node 24.10.1`。

- 已完成新包与必要现有依赖的局部 tsc；首次真实官方 stdio initialize/discover 返回 14 工具，只映射一个只读工具，关闭子进程后退出。
- 新增单文件验证已通过：MCP `real-stdio.test.mjs` 2/2；Skills `real-skill.test.mjs` + `skills.test.mjs` 5/5。两个真实官方服务实例均返回合成文件预期正文及 digest，Gateway Policy 单次授权耗用正确；schema/取消/停用拒绝，Skill version/digest/输入绑定、未知不重试、已确认步骤去重通过。测试使用 bundled Node `24.19.0`，两包 tsc 及测试串行总命令约 7 秒。真实 Skill 的 checkpoint/AgentToolPort 为内存测试装配，Evidence 数组为空；未伪造真实 SQLite Evidence。
- 定向架构边界 `node --test tests/architecture/dependency-boundaries.test.mjs` 1/1、`git diff --check` 通过；未运行全仓 check/build/smoke。
- 恢复增量仅 `packages/skills` tsc +新增 `reconciliation.test.mjs` 1/1（约 2.17 秒，bundled Node 24.19）。started → trusted confirmed → 纯摘要恢复，原工具 invoke 次数不增加；无确认/错 Evidence、配置变化、禁用和取消期间不晋升。该端口/确认 Evidence 为显式离线夹具，不等同 P8 的实际 SQLite Evidence；未重跑旧 7 项/服务/模型/全构建。
- 公开出机与 complete 缓存增量：bundled Node `24.19.0` 两包定向 tsc 通过；仅新增 `packages/mcp/test/public-export.test.mjs` 与受改 `packages/skills/test/reconciliation.test.mjs`，2/2 通过（测试约 2.60 秒）。错 task/proposal/path、参数替换、无许可/过期/撤销、错原确认/换 run、配置或在途取消拒绝，许可 SHA 匹配后仅三字段投影；complete 旧摘要在配置替换/undefined 拒绝且读取/执行次数不增加。出机授权/原确认 callback 使用明确的离线夹具，不代表原生 UI、SQLite adapter 或真实云已经完成。没有新 SDK 服务/模型调用或重跑旧 7 项。
- 测试用公开合成文件仅位于任务忽略目录；没有私人目录/凭据/真实模型/云/第二 Laya。
- 未验证：P8 实际总装、真实 SQLite TaskRuntime Evidence/审批恢复、AgentArts 云端部署/选择/continuation、后台 UI 启停投影、精确 Node 24.15、第三方/远程服务。这些不由本包测试替代，不宣称 MOD done 或 MVP 完成。

## 限制与后续

固定参考 filesystem 服务本身提供写工具，但宿主只映射固定 read_text_file，annotations 不成为权限来源；不是 OS 沙箱。调用失败/断连不自动重试，恢复必须依赖 Runtime 既有记录。Skill 是固定受信 bundle 的确定性两步能力，不是任意外部脚本执行引擎。P8 消费具体反馈后仅修 owned 模块。
