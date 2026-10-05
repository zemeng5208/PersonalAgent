# 新旧 MOD 接续（2026-10-05）

用户要求按 #277 分工接续新旧 MOD、审核待审 PR，外部受阻时推进其他独立任务；最终停止前发送结果邮件。zemeng 串行集成槽 `.worktrees/review-277`，分支 `codex/dev-workflows-continuation`；续交原 #277，初始 head `1a2affa64d991640ca890b1f6196f3617281191a`，main 基线 `330be3862eb7ba9b50709ec8ac0c6292ff7829fd`。保留原作者归属与提交。

## 本轮改动

- 组合 #280（包含 #278）的 Runtime、P5/feeds/通知修复，以及 #281 unknown 补丁观察修正：保留原 marker，不记录未知终态，覆盖重复核实、SQLite 重启和后续 applied。
- 组合 #279 MOD-35 与 #282：源码片段限于原工作区的有界常规文件；仓库外绝对/父路径/file URL/符号链接不返回片段；真实 Node TAP 的堆栈、多行错误、嵌套 subtest、带空格路径正确定位。
- MOD-33/36：发表报告总是传入新的可选 `expectedBaseSha`，GhCliProvider 在 POST 前核对 head/base。复现修复前审批期间 base 漂移仍 POST 一次；修复后零 POST，Runtime 保守等待核实。GitHub 前置读取与写入仍非原子事务。
- MOD-34 Runtime：较大的 CI 共享预算不再触发 Review 32k 单次输出上限而阻止整个宿主启动。只限制 Review 输出，保留 CI 预算；64k 配置启动及审批恢复通过。
- 两项 Desktop 门禁失败来自 Linux 夹具兼容：Windows 路径夹具显式用 win32 basename；环境断言验证各平台白名单，保留 SECRET_TOKEN/GITHUB_KEY 拒绝条件。未放宽生产权限。
- MOD-38 文档/注释纠正为已授权 Local 工作流，不计入比赛验收。无 wire operation、数据库迁移、新依赖或锁文件变化。

## 验证依据

Node 24.15.0 / npm 11.12.1；锁文件安装 `npm ci --ignore-scripts --no-audit --no-fund`。不执行 Electron 安装脚本，不代表真实 UI/native helper 验收。

初始组合 `npm run check` 完成架构、契约夹具、生成一致性、全 workspace 构建/类型及测试，仅上述两项 Desktop 夹具失败；Runtime 306/306，其余 workspace 零失败。修正后 Desktop 完整 342 通过/0 失败/6 跳过，DEV-WORKFLOWS 66/66，根 integration 17/17。最终完整门禁结果见 PR 最新回执，不能把初次失败说成通过。原始本机日志在 `/tmp/personalagent-review/`，未提交。

## 队列与真实完成条件

| 工作包 | 已推进 | 剩余 / 继续入口 |
| --- | --- | --- |
| #278/#280、P5/P7/通知回归 | 已评审、缺陷交 #281、组合消费；保留 Fact review、TrackingGrant 与 unknown 回执断言 | 非作者审核新修复与组合 head、CI 终态、main 集成 |
| MOD-35 (#279) | 已评审、边界与真实 TAP 修正交 #282，定位器 9/9；组合消费 | Potatos498/goo122 非作者评审与 main 集成 |
| MOD-33/34/36/38 (#277) | 公开端口、生产组合和离线链已有实现；本轮恢复/配置缺陷已修正 | 受信 gh 凭据、真实模型、Windows helper；完成 Actions 修复、COMMENT、标签和 Issue 回链真实读回 |
| MOD-37 | goo122 负责；当前无待审实现 PR | 审核后续交付，不代写其目录或另造接口事实源 |
| P5 MOD-27/28、P7 消费 | 当前源码已有正式来源、私有 Fact 审核、Laya 与持久恢复；旧 #273/#275 已合入 | 真实本机/模型/来源变更和 AgentArts 联动；私人出机保持原生授权，不以 Fake 判完成 |
| P6 MOD-16/18 | 保留 Windows 控制、patch/受限命令与恢复；本轮修正 MOD-18 丢 marker | Windows 普通用户设备、目标确认/接管、PowerShell/helper 实际应用和读回 |
| MOD-17 / #116 | Desktop public host/main 已有生产注册；本轮真实 Linux node:os→Runtime/Policy/ToolGateway→confirmed 读回 | Windows 生产授权、Desktop 展示、AgentArts 同请求闭环；不关闭 #116 |
| P8 / MOD-29～32 | 组合源码、必要门禁与交付证据；Competition 默认组合不变 | 受信 AgentArts 配置、真实 deployment/API/trace/评估及本机统一验收；当前会话无 Windows 设备或受信模型/云凭据注入端口 |
| MOD-19、PA-018 | 保持此前排除 | Windows 打包安装及 TraceGuard 治理不在当前包 |

MOD-17 Linux 本轮回执：task `d9be4481-cad0-426f-9259-75047815b437`，run 后缀 `:system-read`；工具 `computer.system.observe@1.0.0`，source=node:os，审批前执行数 0；审批后记录 confirmed/allow/executionStarted=true，任务 succeeded。采样 `2026-10-05T07:47:37.009Z`～`07:47:37.261Z`，251.92ms。脱敏 JSON SHA-256 `fa0564194acdebd4bfa399e1e04371665c0b90fcbab28e5402c37b13db6a5c4c`；本机 SQLite/JSON 保留在忽略的 `.cache/mod17-runtime-*`。不含原始 CPU/内存值、设备身份或凭据；Windows、Desktop UI、AgentArts 验证均为 false。

GitHub 插件评审、发布和邮件发送是开发执行证据，不计作产品 GhCliProvider/模型工作流真实外部验收。非作者评审后才合并；整体 Goal 未完成，外部验收缺项不得抹去。

## 后续 P8 可信设置与前端细节（2026-10-05）

用户要求已交成果沿现有 PR 交付、不重复建 PR，等待审核时继续自己的 MOD/前端细节，所有执行对话使用 GPT-6.1 Sol，并确认已在界面选定。先核对 `MODULE_ASSIGNMENTS` §0 和 #212：Potato P0～P4、Gemini P5、goo122 P7/MOD-37 不接管；此增量限 zemeng P8 的 AgentArts 可信设置、对应控件及回归，已在原 #277 登记。保留 #283 独立 Runtime 初始化修复，不合并或自批准 PR。

- `agentarts-config.revoke` 原先吞掉文件删除错误，导致仍有磁盘配置时返回“已清除”。现在立即禁用本进程旧凭据；删除失败明确报未确认，脱敏状态保留错误。只有删除成功或文件已不存在才返回成功；修复存储后可显式重试。未变更安全存储格式、云绑定、环境配置来源或云端权限。
- AgentArts 设置保存/撤销互斥，等待期间所有输入和按钮锁定，重复事件不会额外调用宿主，旧 snapshot 不改写待处理目的地。只有 `configured:true` / `configured:false` 对应读回才显示保存/撤销成功；异常或不匹配回执为未获确认，不自动重试，不回显宿主错误。Authorization 在提交/撤销时清空，调用结束后再次清理请求对象。
- 真实文件删除失败回归在原代码报 Missing expected exception，修复后通过；临时目录中的保留配置修复后可读回重启，再次撤销确实删除，状态不再保留失败。控件回归覆盖并发去重、待处理 snapshot、脱敏、失败重试及不匹配回执。
- Node 24.15.0 / npm 11.12.1：AgentArts 配置/控件/模型页面和 Admin Evidence/撤销定向 11/11；Desktop typecheck 通过，完整 Desktop 测试 346 通过、0 失败、6 Windows 门控跳过。新增控件和宿主文件另执行语法检查，diff 检查通过。
- Browser plugin not available，使用已安装 Playwright + 本机 Chromium 151，不新增依赖。临时 HTTP 宿主加载真实 `mountAdmin`、AgentArts 控件和既有样式，合成 invoke 不连接 Electron/云端。1280×900、480×900 验证页面身份、有内容、无错误遮罩/控制台错误；保存→失败→显式重试→成功→撤销失败→重试成功，按钮/输入禁用、凭据清空及无横向溢出均通过。截图和临时脚本保留在工作区外 `/tmp/personalagent-review/agentarts-ui-*`；不是用户 Windows/安全存储/云连通验收。

#280 最新 `d484c864` 已由 goo122 消费 #281 原修复，并新增 controlled-clock 测试；没有重新实现这份增量或改写其作者。新 head 的审核/CI 与前一 head 分开记录，旧通过不能替代新提交验证。

## MOD-33 注入 Provider 的期限与取消

等待 P8 CI 时继续本人 MOD-33，范围已沿 #277 登记。公开 GitHubService 原先仅入口检查 context，随后直接等待 Provider；对忽略 signal 的注入 Provider，取消后迟到的读取/写入结果仍可确认，或永久等待。两个新增回归在原代码均 Missing expected rejection。现在复用既有 withGitHubContext 包装 Provider：读取超时/取消明确失败；进入写 Provider 后的超时/取消保守 unknown，工具入口转 RESULT_UNKNOWN，不接受迟到 confirmed、不自动重试；入口已取消/过期仍零调用。不把信号中止当成外部操作已停止，无新接口、权限、依赖、wire 或迁移。另用受控 Date/timer 验证永久等待 Provider 到期限必结束，写保留 unknown。README 同步可选 base SHA、当前用户验证授权和包装语义；无真实 GitHub 调用。Node 24.15.0/npm 11.12.1 模块 build/typecheck 和测试 13/13 通过，完整组合检查运行中，终态回写原 PR。

包含该 Provider 修复的 tree `58228388cbc26e641cec158a2bd597c17ae4ff3f`，本机完整 `npm run check` 退出 0：31 workspace 1644 通过、0 失败、45 门控跳过；Runtime 308/308、Desktop 346 通过/6 跳过、GitHub 13/13，根 integration 17/17，架构/契约/生成与全类型检查通过。日志 `/tmp/personalagent-review/p8-mod33-full-check.log`。后续新增选择器行为另做受影响验证，不将此旧 tree 的全套结果直接算作新 tree 的结果。

## P6/P8 原生选择器的迟到结果

继续按用户邮件推进自己的 MOD/细节，沿 #277 登记 `workspace-config-host` 及原测试文件。旧 host 在原生工作区/Node/检查文件/npm 选择器等待期间即使已 close 或 revoke，仍会落盘迟到结果；较旧的选择也能覆盖新选择。原代码四类关闭和撤销回归共 6 个计数均失败于 Missing expected rejection。现在入口拒绝已关闭宿主，等待返回后重新核对 active 与原 generation；关闭、许可撤销或另一项已接受设置变更均使旧选择失效，不落盘、不重新授权、不重开选择器。正常取消和有效选择行为保留，无新 API、IPC、存储格式或目录。

Node 24.15.0：宿主语法检查通过；workspace-config-host、workspace-command-config、coding-and-windows-acceptance 定向 39/39，含四类迟到选择、关闭后零重新打开、撤销失效、较旧选择不覆盖新确认及现有绑定/导出/命令路径。选择器和安全存储为明确合成端口，持久配置使用真实临时文件，Windows/设备/系统安全存储未据此验收。新 head Foundation 与已登记非作者审核分别回写原 PR，不自批准或合并。

## P8 当前配置投影与 P6 受信 helper 接线

AgentArts 模型只读页每次从当前配置快照投影 configured/keyConfigured，撤销成功及磁盘删除失败后都不再显示启动时缓存的已配置状态；始终保持 unverified，不以配置存在证明云可用。配置持久化后的启动异常与撤销异常也在 finally 发布当前快照，错误不假报成功。新增纯投影及真实删除失败回归，不改云执行或授权。

Desktop coding host 和 workspace config 补全既有公开 patch 工厂的可选外部 helper 参数；仅主进程受信环境 PA_CODING_PATCH_HELPER_SCRIPT 注入，不接受 renderer/model 路径、不自动复制或运行脚本。helper 必须位于工作区及恢复目录之外，保持公开工厂字节一致/链接限制，并固定 canonical identity；更改后不可执行。人工安装受审查的版本一致脚本及原生许可仍必要，配置 helper 不恢复写许可。两项 Windows 回归覆盖 canonical 传递、变更失效、根外限制、实际仓库根/公开工厂和持久 workspace 重启接线；本机 Linux 明确跳过，等待精确 head Windows CI。

当前 Linux Desktop 完整测试 356 通过、0 失败、8 Windows 门控跳过，架构 3/3；浏览器真实 Admin 挂载使用合成宿主，Chromium151/Playwright 在桌面及窄屏核对撤销后状态和删除失败原因，无控制台错误。Electron 原生运行组件和 Windows 设备不在此环境，未声称原生或云验收。

发布前发现协作者已将 #283 合入 #277 分支（cb51372）；接续以该远端 head 为父提交，保留其 Runtime 初始化清理及作者历史。本代理没有批准或合并。用户邮件确认真实验收可由其他协作者承担，当前执行继续源码交付，不把缺少设备视为全部工作停止条件。

## Windows fixture 定位的受载超时

24dcd034 PR CI 的第一次 npm ci 无诊断退出已重跑；第二次在新 helper 回归进入安全断言前，夹具额外 where.exe 子进程5秒超时，stdout 已有 PowerShell 路径。相同head push全套check通过。将此测试定位改为直接扫描受信 PATH 的现存 pwsh.exe，避免无业务意义的额外子进程期限；找不到明确断言失败，仍不跳过真实 Windows 测试。生产 executable/超时不改，canonical/字节一致/根外/变更失效/重启接线与许可断言全部保留。新精确head Foundation另验，不用旧head绿替代。

## 协作者真实模型与创建回执增量的边界回归

Potato d3e110c7/a2c9ee5 从真实验收反馈补充 JSON 围栏、查询30项边界以及模型长哈希复制错误：先保留严格提案结构和已读取路径限制，采用可信源快照哈希构造待审批补丁，apply 原 before-sha/oldText 校验不变；规范化不会授权未读路径。LGW 24dcd034 补充PR创建回执head复核，不匹配保守unknown并保留已返回的PR定位。保留作者且不双写源文件。

将此前工作区外5项行为回归固化到本人 ci-fix.test.mjs：有效围栏正常通过、围栏外说明和shell字段无patch、有界30项查询和目标缺失零模型/patch、错误模型hash使用可信读取hash与成功缓存不重放、未读路径仍拒绝。原15项完整保留，公开工作流测试20/20；GitHub最新build及14/14通过。这些是显式合成模型/ToolPort契约验证，不是实际GH/模型/Windows执行验收。真实整链由Potato在受信环境接续并回写原task/run/审批/执行Evidence。

## 最新真实验收缺项的作者接续与 P6 控件（2026-10-05 11 时）

重新读取 #277 最新全部评论发现 Potato `5992872339` 明确报告：真实 Actions/GLM 链走到 patch-0-0，仍 RESULT_UNKNOWN，且 DEV-WORKFLOWS 缺核实入口。这两项不能被先前 CI 双绿或一轮结果邮件抹去。Windows 原因定位继续交持有原复现环境的 Potato，要求脱敏原 task/run、底层 error、marker/核实状态，不删除 marker 或新建任务盲重试。

本次沿原 #277 精确登记本人 dev-workflows 源码/测试和 P6 controls/host snapshot。新增 `reconcileWorkspacePatchTask(taskId,runId)` 绑定原输入、授权执行记录、根/恢复/PowerShell identity 与可信 preview；unknown/in_progress 只观察，SQLite 重启不重复 apply。not_applied 先持久失败读回、后 ack；marker 缺失不能推断成功。apply 异常仅保存固定本地诊断类别，不泄露原始错误、私有路径或凭据。

**独立核心依赖仍未完成**：原 Runtime `reconcileToolExecution(applied)` 会终结整个任务，不能用于尚需验证/commit/push/PR 的中间 patch。已在 `5993147961` / `5993224076` 向唯一核心 owner goo122 提交精确 `reconcileToolExecutionForContinuation` 接口需求，本次不改 `apps/runtime/src/index.ts`。此方法须原子确认原 run/正常 apply 缓存，但保持 waiting_reconciliation，再由现 resumeConfirmed 消费。未交付时 applied 明确 UNSUPPORTED、保留现场，不伪报已完成恢复；正向整链待该接口及实际 Windows 回归。

P6 前端三个新增回归在原代码全部失败：项目代码许可缺命令前置、宿主许可不按读回显示、待装配目录仍可授权。现在项目许可依赖命令且不自动勾选；安全 snapshot 独立报告 authorizationAvailable/writeAllowed/commandAllowed，不输出路径；宿主读回更新勾选但保留用户未提交更改；pending 可访问状态、按钮互锁及无效回执明确未确认。相关 host/controls 40/40、DEV-WORKFLOWS runtime 12/12。

Browser 插件不可用，使用已安装 Playwright/Chromium 实际挂载 Admin worktrees 页面及原样式，1280×900 与480×900，检查前置许可、待装配、读回/未保存选择、重复提交、失败重试及窄屏无横向溢出，控制台无错误；桥接为明确合成宿主，不代表原生 Electron/Windows/云已验收。临时证据保留在 `/tmp/personalagent-review/workspace-ui-*`，不提交测试截图或私有数据。整体 Goal 继续 in_progress，不将本次增量当全部完成。

进一步核对本人新 MOD 找到并修正两项独立缺陷，均沿原 PR 登记精确文件范围：

- MOD34 的 `precommit-head-${j.steps}` 在每次暂停审批后换身份，真实 TaskRuntime/Policy 的逐项审批回归复现反复新 HEAD 审批直至 Persisted step budget exhausted，从未 commit。现在持久稳定该步身份，兼容旧 pending/cached 步骤；commit 实现仍在 dispatch 时核对实时 HEAD、文件指纹与真实成功验证回执，不放宽任何写入前置。新增完整逐项审批回归走到原修复 commit/push/draftPR/回链，模型/Git/账号端口均明确 Fake；Runtime+CI工作流33/33。
- MOD38 与已修 MOD34/36 的真实模型 framing 不一致：完整 json/无语言围栏分类原本 manual_review。现在仅解包完整外围 framing，严格 schema/原文证据/敏感筛查/置信度和审批不变，外围说明/额外shell字段/虚构证据零标签与修复。两项新增回归通过，Issue工作流20/20。
- MOD36 注入 ModelPort/ToolPort 忽略signal时可永久等模型，COMMENT取消后迟到confirmed还能覆盖预留unknown。两项新回归在原实现均失败。复用同包既有 withCognitionDeadline 约束读取、模型和发表；过期/取消入口零调用，写入中断保持unknown，不盲重发。Review15/15，Review+Issue+Runtime48/48。

以上不代表真实 Windows unknown 已定位或 applied 后核心恢复完成。自己的实现/前端交付与其他人的核心接口、人工评审和原生验收分开记录；等待期间持续核对其他可独立推进项，未接管业务/P5/P7/MOD37或 Runtime 核心文件。

## 继续核对后的兼容与配置修正（2026-10-05 11:45 UTC）

用户本人项目邮件明确允许 GPT-6.1 Sol 代理在既有归属内并行；两个代理分别修改互不重叠的本人文件，父代理串行提交/发布原 #277。没有接管 Runtime 核心或另建 PR。

- MOD34 旧格式 checkpoint 的 `inflight=precommit-head-N` 也须继承为稳定身份。此前只兼容 pending/cached，原 run 已确认仍可能换身份卡在核实。新增旧格式回归验证未确认时零额外调用，确认后只重放原 HEAD 回执，单次 patch/model/commit；CI 工作流21/21。
- 恢复适配器立即克隆端口观察及 acknowledgement，避免复用对象在第二次调用时把持久 not_applied 改写为返回 applied。ack 前回读持久观察、原执行及 core 回执，观察缺失/错配不清 marker；共享对象篡改明确冲突且无成功 receipt，持久原结果与重启恢复保留。三项新增回归，Runtime 组合16/16；applied 正向恢复仍等待 goo122 核心接口。注入端口若自行在 ack 中删除 marker，适配器不能撤销外部删除，不能声称可复原。
- P6 同目录重选 Node、检查文件或 npm 后，持久设置必须与本次启动已装配的全部输入一致才可授权/执行/导出；否则明确提示重启、禁用项目脚本。真实临时配置加合成 recipe 验证三种变更、取消/相同设置、旧 task 不复活以及重启后实际使用新输入；host+command 配置41/41。
- P8 AgentArts 运行时名先检查字符串类型再匹配现有正则。修复前缺字段、undefined/null/数字/数组越过校验进入加密，旧坏记录虚报 configured。现在非法保存零加密、零临时/最终写入，坏记录读回 unconfigured/runtimeReady=false、不返回 binding/凭据且原文件不改写；配置/控件/模型投影23/23。无存储格式或云绑定语义变化。

前一精确提交 `12c0c464` 的 Windows Foundation PR `37302787065` / push `37302778590` 均完成 success，两份日志各确认31 workspace1705通过、0失败、16门控跳过，Desktop366、Runtime315、coding-tools90、GitHub14，根 integration17、架构3、契约4通过，dev/protocol/runtime demo通过。该结果只覆盖前一提交；上述后续增量以新 head 的 Foundation 和登记非作者评审为准。针对性测试不是真实 Windows 普通用户设备、Electron/安全存储或 AgentArts/GLM/账号整链验收。

原子中间补丁确认由协作者 LGW 在 e509388f 交付、86d6569f 更新文档，沿现有分支保留作者实现；本次仅消费该核心提交，不自行改写 index.ts。仍需 Potato 原 task/run 的 Windows helper 首因及真实整链读回、当前 head 的非作者审核；整体 Goal 保持 in_progress。已查重并更新已有项目邮件自动化为用户接受的每小时检查，执行中读取本人新回复，真正停止通知后当前执行留守五分钟；平台启用回执不等于未来触发或原对话自动恢复已验证。

### 现有 #288 并行续接：MOD33 结算与 MOD29 字节快照

用户明确授权多个 GPT-6.1 Sol 代理在本人已登记范围并行，不等待评审才开发；
root 串行核对与交付，继续原 codex/dev-workflows-integration / #288，不另建任务或PR，
不自行 APPROVE 或合并，不接管 MOD37、Runtime core、P1/P2/P5/P7 的在途源文件。
外部原任务/真实环境验收不阻止其他独立源工作，也不以合成测试记通过。

MOD33 公开 Provider 的旧 Promise.race 在同步取消后立即 resolved 时仍接受成功结果，
同步推进时钟越过期限也仍成功。新增回归先复现，再加入结算后原 context/中断检查；
成功或拒绝结算两条路径都优先校验中断，避免同步取消后再抛错泄漏原异常作为执行结果；
没有中断的原错误对象保持原样。读取拒绝 CANCELLED/TIMEOUT，已经进入写 Provider 保持 unknown，注册工具为 RESULT_UNKNOWN，
不重发、不推定远端停止。操作同步抛错也给两个 race 分支安装处理器，清理监听器/定时器；
长期限在平台 timer 上界重设，不在上界就提前报超时。
GitHub build 通过；作者初验使用 Node24.19.0，root 用项目固定 Node24.15.0 实跑首版19/19，
独立复核发现拒绝路径遗漏后，最终作者用 Node24.15.0 重新 build 及25/25测试通过，
二者分开记录。没有真实 GitHub 账号写入或集中验收。

MOD29 公开 AsyncIterable/reader 响应允许 transport 复用 Uint8Array，旧适配器保存原引用，
两块 SSE 的 A/B 被后续写入覆盖成 BB。现在 aggregate byte 限额检查后复制当前字节，
保留已接收快照、既有协议与响应释放路径；两种公开 transport 回归先失败再返回 AB，
成功 reader release 一次、零 cancel。Coordination build/typecheck 和112/112测试通过。
这限定注入 transport seam，未证明默认原生 fetch 复用缓冲或真实 AgentArts 云缺陷。
真实 deployment/API/trace/评估以及 Windows unknown→verify→commit→push→PR→回链、
MOD36 COMMENT、MOD38 标签仍按原持有环境 owner 接续，不能据此完成整个 MOD/Goal。

交付期间 goo122 于14:46 UTC将 #288 的前一 head634870a0 squash 合入main d1fe5537，
该main的tree9906fed9与前一分支相同，未包含本次11文件增量。
依据用户已明确要求“前置分支后继续做到可交付Draft”，本次在同一原分支消费该main祖先，
保留历史后交唯一后继Draft；只包含本次新diff，不重复已合入的10文件，也不批准/合并PR。
同source tree完整 Node24.15/npm11.12 check：31workspace1772通过、0失败、49平台门控跳过，
根integration19/19、架构3/3、契约4/4、生成/全类型检查通过。新head Windows门禁另读。

### MOD34 公开工厂有界等待与最新协作者交付

规划最后核对又确认一项独立源码缺项：直接消费公开 runCiFix/createCiFixWorkflow 的注入 ModelPort/ToolPort 时，调用前后 check 不能使永久 pending 端口在取消/期限时结束。新增回归先复现原实现取消后仍等待；不把此问题描述为生产 Runtime 缺少 ModelGateway/TaskRuntime 保护。

现以操作局部等待约束公开端口，贯穿同一 deadline、取消及 options.now，长 timer 按平台上界重设并清理监听器。模型及明确 read 中断为 CANCELLED/TIMEOUT；已进入非 read/未知 metadata 端口后中断保留原 inflight、等待 Runtime 核实，不以中止等待证明外部操作停止。迟到 confirmed/模型 usage 不落成功 checkpoint，重复恢复零重发。未扩展公共 Schema/依赖/核心文件；CI32 + Runtime16 共48/48。

协作者新 main `31ffba6f` 已合入 #285 MOD09 消费与 #286 真实验收记录，接续保留作者内容、不接管返修或批准/合并。#286 的 MOD36 “闭环”明确限于真实 GitHub/GLM 的只读预审：两次46.8s/48.0s、8项真实变更行 finding，未 publish、零写入。COMMENT 发布、MOD38 标签、MOD34 patch 后完整验证/提交/PR/回链不能据此计通过。#286 原验收脚本未共享，本 Linux 不冒充独立执行 Windows/helper/GLM；作者核实入口/诊断交付后仍需持有原环境的 Potato 接续原任务。

前一 `fec8d4cf` push `37305051263` 已完整 success，31 workspace1727通过、0失败、16跳过；PR `37305057947` 首次 npm ci 无诊断 exit1、未执行检查，相同head push安装成功后仅重试失败作业一次，第二次安装成功，终态另读。该证据不能覆盖本次公开工厂与新 main 组合。
Runtime applied recovery now uses the core reconciliation transaction to persist the confirmed result while preserving the waiting workflow. The original Windows helper root cause and real end-to-end readback remain unverified.

消费核心与新 main 后，组合 build/typecheck 通过；CI32+Runtime16 共48/48，applied 在真实 SQLite 中确认原 run/cache，跨重启继续原审批至验证/提交/推送/PR/回链，apply与commit各一次（模型、工具与账号操作仍为合成端口）。新 main 的根 integration19/19，通过实际 Admin 双尺寸重新检查工作区与 AgentArts 设置，零 console 错误。前一 fec8d4cf PR第二次亦完成 success，与push两份日志共用的精确head31workspace1727通过/0失败/16跳过；原首次安装失败保留，新组合 Foundation另验。

### 原 unknown 的预览前置诊断

继续原 Windows 首因定位的源码核对发现 trusted preview、binding/candidate 校验及 intent 保存都在诊断 catch 之外：它们失败时 Gateway 仍保守 unknown，却没有固定诊断。三项回归在原实现确认 diagnostic 缺失、原授权执行 unknown、apply0；现 catch 覆盖前置至 apply，进入 apply 前只记录固定 preview 阶段/错误码，实际 apply 原分类保持。不会据此确认 not_applied、创建 marker/intent/receipt 或自动重放，原错误文本/路径/凭据不落诊断。

Runtime build及组合20/20通过，包括前置诊断跨重启、无 intent/result/readback、核实拒绝且零port poll/零apply，以及原LGW applied续接与独立快照/持久读回回归。此改动只让持有原环境的 Potato 可辨别失败阶段，不宣称已定位真实 Windows 原因；新精确head门禁及非作者评审继续分列。
