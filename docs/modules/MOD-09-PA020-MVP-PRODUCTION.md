# PA020 私人记忆与流程学习生产桥

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
