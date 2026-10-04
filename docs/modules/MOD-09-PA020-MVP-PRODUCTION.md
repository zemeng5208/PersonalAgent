# PA020 私人记忆与流程学习生产桥

## 2026-10-04 集成复核

以 `origin/main@330be3862eb7ba9b50709ec8ac0c6292ff7829fd` 为依据：
PR #209/#210 已进入 main，#211 的恢复增量经 #210 集成；本生产桥经 #270 合并，
P8 的共享接线也已进入 main。下文原工作包的 `review`、旧工作树与“等待 P8”描述保留为历史记录，
不代表当前合并状态。MOD-09 整体仍为 `in_progress`。

- 主对话已装配 `privateConsumption.prepare/assertCloudSend`、原 Runtime 消费 marker，
  以及 `privateErasure` 的 inventory/cancel/redaction/readback 端口；不是仅有未调用的 host 工厂。
- 写入按实际未接管副本清单和删除准备状态开放；没有接通、来源变化或副本清单变化时拒绝。
  “所有真实 Vault 写入始终禁用”已不符合当前代码；本次没有对用户的真实来源执行写入或外发。
- 最终同步发送检查已调用 `assertCopyManagement`。本次补充凭据 await 后新增未接管副本的
  生产适配器回归：即使此前已确认，最终 guard 也拒绝且零 fetch，不泄露内部拒绝原因。
- 私人记忆、学习 facade、消费和删除恢复四套测试 **14/14** 通过；再加真实 Runtime 的会议事实
  评审测试 **16/16**，合计 **30/30**。全部为隔离合成数据/显式 Fake 传输，未访问真实账号。
- 主分支加本次 CI 修复的完整 `npm run check`：架构、契约夹具、生成类型与 workspace 类型检查
  通过；1609 项测试中 1579 通过、20 跳过、10 失败。5 项失败由独立 PR #278 处理，另 5 项
  Windows native helper 测试因本机缺少 `Microsoft.NETCore.App 8.0` 失败。
  隔离组合 `#278@d004849c9df2c76ef1c80052500379a87729d237` 加本次补丁：构建通过，
  106 项定向回归与 17 项跨模块集成全部通过；这不等于远程 CI 已通过或 PR 已合并。

本轮交付后续：已推送 Draft PR #280，首提交 `67cfa25`。从 Microsoft 官方发布元数据下载
并验证 SHA512 后，将 .NET 8.0.31 运行时解压到项目忽略缓存；测试进程通过原可信 recipe env
显式指定 `DOTNET_ROOT_X64`，命令工具仍不继承宿主环境。原先缺运行时的两套 Windows helper
测试现为 16/16，通过包含原 5 项失败的用例；不修改系统安装或用户环境变量。
本轮与 #278 的完整组合 Foundation 仍待完成，模块状态和真实验收边界保持上述结论。

下一步验收顺序：

1. 集成本次互补修复与 #278，取得非作者评审及当前 head 的 CI 结果；补齐本机 .NET 8 后复跑 Windows gate。
2. 在真实 Electron 原生对话中只读预览用户已指定来源，逐条确认最小摘录；确认前不能生成长期记忆。
3. 真实本地验证确认→重启读回→更正→撤回→彻底删除，检查原事实历史、应用管理副本与删除收据，
   保留无关事实；当前没有生产 backup/restore 路径，外部独立副本和已发送正文仍不能纳入本机删除保证。
4. 核对私人 parent→child 的真实 ancestry、逐任务配置与许可边界；需要真实 AgentArts 发送时
   单独取得该任务的原生确认和云调用授权。未取得这些证据前不把整个 MOD-09 标为 done。

## 原工作包记录

目标 profile：`huawei_ict_agentarts`。负责人 zemeng，非作者评审/集成由 PR 专线和 P8。
工作树 `D:/PersonalAgent/.worktrees/memory-learning-mvp`，分支 `codex/memory-learning-mvp`，
基线 `1db50397`。状态 `review`；共享 main/preload/view/application exports/root package/lock 由 P8 单独装配。

## 已交付端口

- `createPrivateMemoryController(file, confirm, confirmDelete, {confirmWithdraw, authorizeConsumption})`：
  保留既有引用确认后重读、纠正精确 revision、持久幂等回执及未绑定删除/WAL维护。
  新增 `previewSave(source)` 返回 `{configurationRevision,expectedRevision}`；
  `save(source,summary,baseline)` 检查该基线与来源配置，确认期间更换来源拒绝。
  `withdraw(ref)` 追加用户确认的 private 撤回头，旧版本不回退消费；撤回头仍可物理删除。
  `consumeConfirmed({refs,taskId,destination,deadline,signal})` 每次要求受信宿主原生确认，
  返回最小 `{ref,summary}`，不返回来源路径/原文。`destination` 为 local 或 agentarts，
  默认确认器拒绝，拒绝时零正文；确认之后再读精确有效头。不得缓存为长期出机授权，
  在实际发送前调用；结果始终作为用户数据，不成为 system 指令或工具权限。
- `createMemoryLearningHost({profile,privateMemory,learningApplication,publicErasure?,managedPrivateCopies})`：
  受信 Desktop admin facade。`managedPrivateCopies: []` 必须来自组合入口核实的实际应用副本清单，
  私人 namespace 从未有 feed binding 且删除维护通过才返回 `writeEnabled:true`。
  未提供清单/已有未接通副本均禁用；不能只移除旧 fixture gate。
  清单可为受信 live callback，每次写入/删除前重新读；启动后新增未接通副本也会禁用，
  不缓存空清单结论或宣称删除已覆盖新增副本。
  `memory.previewSave` → `memory.save({source,summary,baseline})`；
  `memory.withdraw` / `memory.delete` 均走原生确认，`memory.boundErase` 只消费明确注入的公共删除宿主。
- `createWorkflowLearningApplication({profile,namespace,conversationId?,learning,runtime,skillManifest,submitSkillTask,confirmActivation,confirmDeletion})`：
  learning 使用既有 `SqliteLearningHost` 独立域文件，不新增 Schema/任务库/调度器。
  唯一流程为公开 `workspace-reference-summary@1.0.0` 固定两步和
  `mcp.workspace.read_text@1.0.0` 只读能力。候选 sourceRef 绑定 Skill ID/version/digest/相对路径，
  不能选择脚本、工具或权限。
  `submitSkillTask(binding,context)` 必须通过现有 Runtime atomically 提交
  `learning:binding:v1` checkpoint（purpose、namespace、workflowId、revision、skillId、version、digest、path、operationId），
  再 dispatch 原固定 Skill worker。conversation 默认为 `learning:<namespace>`，P8须匹配它。
  `assertDispatchBinding(binding)` 在 worker 每步、审批恢复/对账恢复和结果提交前调用；删除或回退后旧任务拒绝。
  `startValidation` 只受理候选验证任务，pending/unknown不标记通过。
  `validate` 必须读回 succeeded 任务、Skill complete checkpoint、匹配内容 hash 的源结果、
  唯一已授权且执行过的 Runtime 工具记录和 Evidence；模型自报/空 Evidence 不足以通过。
  `activate` 单独可信确认且检查当前 active revision；旧已验证版本通过同端口回退。
  `run` 只提交已启用版本，工具授权仍由原 Runtime/Policy。
  `stop({workflowId,revision,taskId,deadline,signal})` 比对原 Runtime 任务 conversation 与持久学习绑定，
  只取消该精确任务；回退/删除之后仍可停止原绑定任务，不删除候选或启用历史。
  返回 `cancelRequested` 与实际当前状态，取消受理不等于执行已停止。
  `erase` 精确头、可信确认，向同conversation绑定任务请求取消并清除候选/验证/启用历史；
  `resumeErasureMaintenance(namespace)` 只重试已提交删除的 WAL 维护。
- `createBoundPublicFactErasureApplication({profile,memory,runtime,projection,memoryNamespace,graphNamespace,confirm})`：
  只用于真实绑定的公共源 store，不接受 `desktop-private`。通过现有 begin/preflight/resume 清除投影、
  来源回执、Memory 历史与 WAL。`reconcile(context)` 启动读 durable marker；有 Runtime receipt 时复用其原
  expectedGraphRevision，无 receipt 才做当前预检。未知/失败保持 pending，不创建新 operation 或盲重做工具。
  staged/untraced/跨图依赖等现有安全门槛仍 fail closed。
- 独立 UI：`mountMemoryLearningControls(root,{invoke,status,refs})`，路径
  `apps/desktop/src/features/admin/memory-learning-controls.js`。只接 metadata/opaque refs，
  private摘要/原文/来源路径/raw Evidence 不进入此组件；P8挂载和 Luna现有class样式。

## 删除与恢复边界

只读检查 main 的 `apps/`、`packages/`、`scripts/` 未发现复制 private-memory SQLite 的
应用 backup/restore 路径；coding-tools patch backup 只保留工作区补丁，与私人记忆库无关。
没有新增通用备份系统，没有扫描用户磁盘、清理用户备份或删除 Vault 原文件。

Memory 新 host-only metadata `listFactErasures(namespace,{limit,afterFactId?,deadline,signal})`
提供有界稳定 ID 分页。`restoreUnboundErasureMarkers(namespace,{markers,deadline,signal})`
仅接受由仍权威的原 store 读出的 completed 标记；在暴露应用恢复副本之前清除旧版本及其确认回执，
保留 marker 防重导入，无关事实保留；绑定 feed 的副本拒绝。原库已被替换、清单丢失或来源未知时不可宣称过滤完成。
Desktop `filterRestoredHost(restoredMemory,context)` 要求原库仍存在且与恢复副本不同。
此入口为未来真实已有 restore 调用方提供防污染边界；当前没有生产 backup/restore 调用路径。
外部任意副本及曾经导出/已发送的正文不在应用控制范围，需要用户自行处理，不能称作删除已覆盖。

## 主对话私人消费接线

`apps/desktop/electron/private-memory-consumption-host.js` 提供独立受信
`createPrivateMemoryConsumptionHost({profile,privateMemory,readTask,readTaskBinding,writeTaskBinding,readConfigurationRef})`。
P8 是共享 main/Runtime/主对话唯一写入者；组合入口必须提供原 TaskRuntime 的读写端口以及当前真实
Competition 配置的无内容 opaque ref。不得用 Renderer 的声明替代真实配置/原生确认。

- `select({conversationId,ref|null})` 仅选一个精确私人引用，不授予外发权限；来源配置变更后旧选择失效。
- `prepare({taskId,conversationId,goal,deadline,signal})` 在原 Runtime 受理后、原 worker dispatch 前调用。
  逐任务原生确认目的地、摘要、精确版本；确认前后重新读取 active/user_confirmed/有效期、来源配置、
  原任务取消/终态与 Competition 配置。拒绝返回原公共输入且不创建私有消费绑定。
- 允许后 `private-memory:consumption:v1` 只保存 task/conversation/config/deadline、输入摘要 hash、
  factRef、来源/记忆摘要 hash 与私人来源配置 opaque ref，不包含私有正文、源路径或 Vault 绝对路径。
  `goal` 返回值是仅内存的投影，摘要作为 `user_confirmed_data`。P8 不得写入 application-goal、
  原协调循环 checkpoints 或另建历史正文副本；原公共用户输入正常持久化。
- `assertCloudSend(request)` 必须接到原 AgentArts 最终同步 beforeSend：credential await 之后、
  fetch 之前重新验证实际 request.goal、原持久绑定、精确事实头、配置、deadline、signal 和 task。
  更正/撤回/删除/切 Vault/改变云配置/停止任务均使旧发送拒绝；续接也必须保留同一已确认投影并再查。
  重启有 metadata marker 却无原内存 lease 时拒绝，不恢复旧私人外发许可；重新提交任务、重新确认。
  `releaseTask` / `close` 清理内存许可。这里的 prepare/guard 不签发工具权限、不记录云完成证据。

2026-09-30 新增必要验证：`node --test apps/desktop/test/private-memory-consumption.test.mjs`
实际 3/3 通过；调用生产 `AgentArtsCloudAgentPort`、显式合成 credential/fetch，检查其真实序列化 body
只有更正摘要无旧摘要/来源路径，拒绝确认只有原公共 goal；credential await 中撤回使最终 guard 拒绝且
zero fetch；更改实际 goal/config、重启无 lease、native 确认期间切 Vault/取消均拒绝。
live inventory 新增副本立即禁用写入。此为生产适配器离线传输验证，不是真实账号云消费。

Runtime 单次 `tsc -p apps/runtime/tsconfig.json` 通过；仅新 `learning stop` 用例 1/1 通过（122.5ms），
实际 Runtime running worker 收到 abort 后 cancelled，其他任务与流程版本保留。
控件新增停止按钮以同一原 taskId/workflow/revision 发送，合成 Edge 交互验证
候选→验证任务→停止请求→显示 cancelling；1000×940 与 390×844 无横向溢出/裁切/console 错误。
此处仍未验证共享主对话调用、真实 Electron 原生确认、真实 Vault/真实 AgentArts 消费；
等待 P8 实际接线和相应读回，不能仅凭本源包标记整个 PA020 done。

## 应用派生副本清除接管合同

模型答案、工具 arguments/result、协调续接正文、派生子任务 goal 和 conversation 助手消息可能带有私人摘要。
仅删除私人 Memory 源库不足以消除这些副本。新增独立 `private-memory-erasure-host.js` 的
`createPrivateMemoryErasureHost` 由 P8 注入原 Runtime/history 的可信端口：

- `listBindings({limit,afterTaskId?})` 返回稳定 taskId 分页的 `{items:[{taskId,binding}],nextAfterTaskId?}`，
  覆盖所有原持久任务及实际派生子任务，不能只列在内存中的 lease。binding 为原持久消费 marker；
  派生 marker 必须使用实际子 taskId，保留同源 factRef，可附带真实 parent/root metadata。
- `cancelTask(taskId)` 只调用原 Runtime；`eraseTaskCopies({taskId,factId,bindingDigest,deadline,signal})`
  清除同原库/history 的实际私有正文副本，不能在 active/unknown/等待结果核实时提前删除必要 proof。
  未完成清除保持 pending，先持久 withheld 并让未来模型 history/引用消费拒绝该副本。
- `readCopyErasureReceipt(taskId)` 只读实际清除与读回之后的无内容
  `{taskId,factId,bindingDigest,state:'purged'}` 收据；原消费 marker 保留恢复关联。
  不接受模型自报、篡改 digest 或空 receipt 当作已清除。

协调器先精确原生确认并提交原 Memory 删除，再失效内存 lease、取消同源任务和调用实际 redaction。
过时 ref 拒绝且零取消；已提交 Memory 删除但 WAL维护/副本清除未完成返回
`pending/private_copy_erasure`，不能显示全部删除成功。`reconcile` 只复用原 completed erasure markers
与 task bindings/收据，不调用模型/工具或重建授权。`withdraw` 在源撤回之后失效并取消关联任务。
原外部云端曾经收到的正文不在本机清除范围。

facade 可注入 `privateErasure`；此时 `managedPrivateCopies` 指其他未登记副本，原任务副本通过协调器
实际 bindings inventory 登记。其他副本未知或未接通仍拒绝。消费 host 新增同步 void
`assertCopyManagement`：在私人消费前检查真实完整清单与清除端口，缺接线时保持消费禁用；
公共未选择私人引用的任务照常。P8 原配置/native/共享 Runtime/history 接线仍是唯一生产证据来源。

新增 `private-memory-erasure.test.mjs` 2/2 通过，仅显式合成 task/history redaction 端口：
原 SQLite 删除关联 parent/child 副本、保留独立事实；过时删除零取消；missing/错 digest 收据 pending；
重启从原 marker 接续后读回准确收据。不能把合成 redactor 验证写成实际 Runtime/history 已清除。

源码交云知识记忆接管时未补跑旧 suite；2026-10-04 已复验上述私人消费/删除 suite，最终 beforeSend guard
也已同步调用 `assertCopyManagement`，并补确认后登记变化的零 fetch 回归。剩余评审点：实际 parent→child inventory 与同配置 task-tree native
许可必须核对真实 ancestry，独立模型/provider 更换不得继承原逐任务许可。当前 owned host 不提供
自动子任务许可，P8 shared 路径和云知识记忆组接续；本地不再竞争 portable 文件写入。

## PR270 两项本机补修

吸收云端 exact `d875b9c262e3e137db27ea8d397aa06d2bf9eddc` 后恢复本包独占增量：
`SqliteLearningHost.assertSourceAvailable(namespace,sourceRef)` 只复用原持久来源撤销检查，
Runtime 在验证提交前后、每次 dispatch/resume 入口重新检查，不恢复已撤销来源或另起工具循环。
Evidence validator 在实际执行及 binding 的异步读回之后再查 Skill enabled/revision/content hash，
同时重新检查取消与 deadline，不能用等待前的 Skill 状态出具通过结果。
定向来源撤销、await 期间 Skill 变化、最终读取取消/超时用例已准备；本阶段按统一验收安排
只执行 TS syntax parse、测试文件 `node --check` 和 `git diff --check`，未运行测试、构建或服务。

非作者复核指出最终 `readSkill` 等待期间仍可能撤回 source binding，补修要求
`WorkflowEvidencePorts.readCurrent(candidate,binding,context)` 提供受信宿主原 mutation fences 下的
同步一致联合读回（当前 binding + Skill），最后检查精确 binding/Skill/取消/deadline 后无 await 直接返回。
缺少此端口、返回 Promise、原来源撤回或 Skill变化均拒绝；不可用异步快照拼装假 joint current，
真实 adapter 未接通前保持不可用，不给新许可或恢复已撤销来源。仅合成 fixture 接口已更新。
来源撤销的 `startValidation` 在调用时同步抛错，其用例改为 `assert.throws`，保留零新任务/MCP断言。
新增最终 Skill await 中撤销、缺失/异步/停用 joint gate 与 gate取消/超时用例仅准备，未运行。

## 验证与限制

定向 SQLite/合成 Vault 验证：私人确认纠正可查询、精确 baseline 及 config变更拒绝、
云授权拒绝零内容、确认期间撤回失效、撤回重启不复活、旧副本过滤保留独立事实；
固定 Skill 经真实 Runtime/ToolGateway/Policy实现但**显式合成工具端口**验证、启用、运行、回退、删除；
无工具证据的自报成功拒绝；Memory提交故障后 Runtime receipt 恢复不重做、原 receipt 保持。
既有 private-memory三用例含busy WAL重启维护也复验。

环境 PATH Node `26.3.0`；仓库要求 `24.15.x`，当前未找到匹配 executable。
本次未安装新版本，不能宣称版本匹配验证。真实 Vault 持久写入、用户原生确认/出机确认、
shared UI最终挂载、真实MCP运行与真实 AgentArts消费须在 P8/人在场另验；这里不宣称 PA020全部完成。
未改变已发布迁移，未改public wire或Local Profile，未运行全仓 tests/smoke。

非作者 review 的删除顺序 P2 已修：事务内精确最新头检查与删除持久接受在先，
dispatchBinding因候选移除立即失效，然后才请求取消关联任务；旧revision或原生确认中产生新revision
均拒绝且零cancel。WAL维护失败通过 `readErasureReceipt` 精确operation/revision读回确认已提交，
取消已失效任务后保留原始维护错误，不能报成功。

修复代码 exact head `3d6d918560da9eba4e47bfbda5f197d5d4882111` 的必要复验收据：
Learning/Runtime `tsc -p` 各一次通过；
`node --test --test-name-pattern='stale learning deletion|new head during deletion' apps/runtime/test/memory-learning-application.test.mjs`
实际 2/2 通过，分别 77ms / 64ms。未重跑旧8/11用例，WAL失败分支本次仅非作者静态复核，
不将其当作新增故障注入测试通过。当前相关不同用例累计13项（原私人3、新纵向8、删除冲突2）。

独立控件视觉验证使用既有 Playwright + 安装的 Edge（Browser skill未提供；默认Playwright
headless shell缺失，不安装，改用已存在msedge channel）。仅合成admin端口，复用原CSS classes，
1000×940 / 390×844 均无横向溢出、裁切或应用console错误；生成候选后表单输入保留，
未验证shared Electron宿主/原生对话框。临时fixture/server已结束，证据在本工作树忽略`.cache/memory-learning-visual/`。
