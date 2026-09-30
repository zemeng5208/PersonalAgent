# MCP/Skill 云工作包交接

Profile `huawei_ict_agentarts`；MOD-06/07、PA-005/006/023/026/027。独占分支 `codex/cloud-mvp-mcp-skills`。
起始 main `7ede5f5b`；吸收指定 P8 依赖后 PR target/base 为
`codex/zemeng/p8-mvp-final-integration@d2a23bea182a0a61104f601a6769d6ac16d7db5b`。
已读该树 `MVP-P8-CLOUD-RUNTIME-HANDOFF.md` 与实际源码。d94 原件继承自 P8，不重造 MCP helper。
本包不改 application/main/rootlock、P6 workspace-config-host、native许可UI、DB或安全配置。

## P6/P8 出口合同

| 公开符号（`@personal-agent/mcp`） | 行为 |
| --- | --- |
| `createPublicReferenceExport` / `PublicReferenceExportOptions` | 原 d94，policy2.0.0，md/txt，真实 MCP schema 保持 |
| `createWorkspaceReferenceExport` / `WorkspaceReferenceExportOptions` | 新 workspace 专用入口，policy workspace-reference-2.0.0，不冒 MCP |
| `PublicReferenceExportQuery` | 共用 `{taskId,proposalId,path,configurationRef}` |
| `PublicReferenceExportAuthorization` | 共用 `{authorizationId,contentDigest,expiresAt}`，native明确 PUBLIC 出机许可 |

两个 options 均为 `currentConfigurationRef():string|undefined`、
`readAuthorization(query):PublicReferenceExportAuthorization|undefined`、同步只读 `readConfirmed`。
MCP readConfirmed 返回 `{runId,result:McpReadResult}`；workspace 返回 `{runId,result:WorkspaceReadResult}`，
后者直接 import 原 coding-tools 公共类型，无第二 result DTO。实现分别在 mcp/src/public-export.ts、workspace-export.ts。
configurationRef 必须唯一绑定原 session/root/configGeneration，撤销/断连返回 undefined，不恢复旧 ID。
native授权回调检查 query 四字段及当前工具/版本的独立 cloudExport scope，workspace read scope 不可替代。
readConfirmed 核原 proposal→run、完整 args（含 maxBytes）、工具/版本/scope、Policy allow、confirmed/
executionStarted/finishedAt、原 result checkpoint、同 task Evidence；不得 invoke/grant/接受外部 receipt/改状态。
workspace helper 接 `{path,maxBytes?}`，安全相对 path 可含 .js，maxBytes 1..262144；同 proposal 完整参数不可替换。
真实结果要求 path/encoding=utf-8/byteLength/content/sha256，字节数与 SHA 一致；历史缺 SHA 拒绝。
MCP 输出仍仅 `{source:'approved-reference',contentDigest,readConfirmed:true}`；workspace 仅
`{source:'approved-workspace-reference',contentDigest,readConfirmed:true}`。正文/path/授权/run/Evidence 不出机。
missing/unknown/expiry/revoke/config或许可替换：accepts=false/project UNAUTHORIZED；取消 CANCELLED；dispose永久拒绝。
真正 cloud I/O 前仍调原 Competition export guard，不能缓存 projection 绕过撤销。P6只consume workspace helper，P8只inject native ports。

## Desktop现有宿主

保留 `createDesktopReferenceHost` 原 submit/reconcile/启停/native worker 路径，新增可信 options：

- `publicReferenceExport:{readAuthorization,readConfirmed}`：消费 d94；currentConfigurationRef 用原 current()。
- `publicReferenceAvailability(input & {configurationRef})`：native公开 MCP availability gate；缺槽不公布。
- `publicSkillAvailability(input & {configurationRef})`：独立 native公开 Skill availability gate。
- `resolvePublicSkillSource({taskId,proposalId,revision,sourceRef,deadline,signal,configurationRef})`：
  opaque sourceRef 解析为 `PublicSkillSource extends PublicReferenceExportAuthorization`，附本地 path/sourceRef/configurationRef/revision。
  复查 native PUBLIC、原task/proposal、root/configGeneration、期限、取消和原输入revision。

旧 policy1/path-only export 已替换。readWorkspaceBinding 仅许可读，不派生PUBLIC授权。
stop/invalidate 关闭 cloud selector、abort worker并清config，再沿原TaskRuntime取消；新service须重新注入当前worker。

## CloudRuntime原循环接线（shared由唯一作者实现）

`@personal-agent/skills` 提供 `createCloudSkillSelectionPort`、`VersionedSkillWorkerPort`、`PublicSkillSource`、
`CloudSkillContext` 与 `CLOUD_SKILL_TOOL_NAME/VERSION/PUBLIC_ENUM_PATHS`。
名字固定 `skill.workspace_reference_summary@1.0.0`。调用 host.configureCloudSkillWorker(port) 注入同一已有worker：
manifest()/health()/invoke(ReferenceSummaryInput,AgentWorkerContext)，不新建worker/framework/task。

1. CloudRuntime在原application公开已有private referenceSkill的最小accessor。invoke前校验/保存同task的原
   REFERENCE_SKILL_TASK intent，沿原configuration绑定及readConfirmedSkillSource；不另runTask或第二Taskstore。
2. `await host.cloudSkillCatalog({taskId,revision,deadline,signal})` 返回已有 CoordinationAvailableTool。
   全字段显式type；id/version/digest用enum。native明确批准 PUBLIC_ENUM_PATHS
   `['/skillId','/version','/digest']` 后交原safeSchema，不用const-only manifest.inputSchema。
   sourceRef是native公开来源别名，不在catalog发布私路径/正文。
3. 根给原RuntimeCompetitionToolCatalog增加worker capability注入、持久目录和发送前复查。
   worker descriptor不可注册到Gateway，不能造占位RegisteredTool满足注册检查。
4. AgentArts沿原goal/availableTools返回原CoordinationToolProposalResult（tool_proposal）；现parser验证后，
   在coordination worker的tools.invoke之前分派该名字到host.dispatchCloudSkillProposal(proposal,context)。
   context复用原task checkpoint/progress/deadline/signal；revision是原请求/输入绑定revision，非云授予数字。
   native校验输入失效；普通progress造成的UI TaskSnapshot revision递增不等于新权限。
5. selector在原checkpoint skill:cloud-selection:v1绑定task/proposal/manifest/path/config/revision/许可/SHA/expiry。
   内层MCP才走原ToolPort/Policy/Gateway。pending/unknown交原waiting_approval/waiting_reconciliation；
   仅confirmed receipt放入原CoordinationContinuation.result，无新Cloud DTO/协议/模型loop。
6. 异步凭据读取后、真实cloud I/O前，调用port.assertReceiptAllowed(selection,receipt,context)，
   核持久同task receipt和新鲜许可；根将selection保存原competition checkpoint。select/catalog/run仅本地参数。

Skill run `skill-read-taskId-digest` 与云MCP run `competition-tool-taskId-step` 不同，不可互相冒确认。
继续沿原SkillReadReconciliationQuery核原task/run/input/scope/config/Evidence；如要复用原读，根先公开并核实
精确proposal/run映射；缺映射unknown，不伪造Evidence或重call。同task不同proposal/input拒绝覆盖原selection。

## 验证与迁移

无DB/wire迁移。固定bundle新增归一化bodySHA pin；body变更需升版本/digest，保留CRLF兼容。
恢复read-confirmed/complete核保存正文SHA与sources/Evidence一致性，保留d94 complete configRef复查。
类型依赖均已有workspace：mcp加coding-tools，skills加mcp/coordination。根唯一lock/顺序由P8更新：
contracts/coding-tools/agents/coordination产物就绪 → mcp → skills → runtime/desktop。

本轮不跑unit/integration/smoke/check/build/模型/供应商，仅静态核API/source/diff。
用户更新执行方式前的一项依赖准备安装随即取消，无cache/依赖/lock提交。
继承d94 tsc+新增受改2case2/2及P8官方MCP+SQLite/Policy/allow_once、routine-read两case历史收据，不重跑或冒本轮结果。
本机根更新唯一lock及必要前置产物后统一执行：

```sh
npm run build --workspace=@personal-agent/mcp
npm run build --workspace=@personal-agent/skills
npm run typecheck --workspace=@personal-agent/mcp
npm run typecheck --workspace=@personal-agent/skills
node --test packages/mcp/test/workspace-export.test.mjs packages/skills/test/cloud-selection.test.mjs
```

prepared cases为offline permission/worker/receipt fixture，非生产Fake。
尚需root接原Runtime worker/intent/catalog/dispatch/finalguard，P6workspace gate，P8native确认撤销，
真实AgentArts账号/deployment/version/trace与Windows stdio/现SQLiteEvidence统一验收。
麦克风、安全存储、私人数据不在此包范围；缺ports/账号明确unavailable，不回退Local。
