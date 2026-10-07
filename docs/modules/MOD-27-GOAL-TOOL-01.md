# MOD-27-GOAL-TOOL-01：目标写入的受控工具薄适配

> 维护入口（2026-10-07）：项目主要负责人为 zemeng；当前分工以 [模块分工](../../docs/MODULE_ASSIGNMENTS.md) 为准，最新状态见 [ROADMAP](../../docs/ROADMAP.md)。历史日期、作者和验收结论按原记录保留。

- Profile：`huawei_ict_agentarts`；MOD-27 / PA-024；负责人 `zemeng`。
- 所有权：`packages/goals/**` 与本文；Runtime、Policy、Desktop 和根 lock 保留原分工。
- 前置：Goal 命令 PR #136 head `0cb6e97`；DEP01 Draft PR #152 head `4930d43` 提供可信宿主发起的持久单工具任务、审批恢复和读回。本包依赖该 Draft 的接口形态，不把它当作已合并能力。

`createGoalTools(boundStoreOrResolver)` 复用现有 `createGoal`、`reviseGoal`、图版本 CAS 和
`CoordinationStorePort`，提供 `goals.create` / `goals.revise` 两个 `RegisteredTool`。
已有 boundStore 可直接传；Desktop 可先构造工具并传受信 callback，Application 建成后
绑定单个稳定 store。注册时不解析 callback，执行时缺失或换绑一律拒绝。当前
RuntimeApplication 构造仅注册 descriptor，不执行 host 工具；Desktop 必须先绑定 store，
再开放 IPC 或恢复已批准的任务。该时序兼容 DEP01 在构造中注册工具。
输入包含精确图版本、完整 Goal 字段，修订再包含精确旧 Goal 版本；不包含 namespace。
可信 Desktop 主进程负责固定并持久化不透明用户 namespace、绑定 store，以及由稳定
commandId 生成/校验 sourceRef；Renderer 不能指定这两者。ToolGateway/Policy 仍负责
`goals:write` 范围、参数摘要、审批和一次性授权，工具本身不签发授权。

成功写入后工具从存储按 graphRevision 读回刚提交的 Goal，返回旧/新精确 NodeRef
和 graphRevision，供 MOD-28 选影响及 MOD-11/12 显示。旧版本冲突作为确认的
`kind: 'conflict'` 返回当前图版本，不盲重试；确认为写前非法输入返回
`kind: 'rejected'`。意外写入或读回错误抛给 Runtime 作结果未知/待核实，不能报成功。
工具不提供自动重放/自动恢复承诺；Runtime 的 host task 负责同一 commandId 的任务
幂等和批准后恢复。已发生的图版本历史不会因代码回滚而撤销。

本包仅需定向验证工具 Schema、写后读回、冲突零追加及读回失败拒绝成功；已通过
的 Goal 图、SQLite CAS、Runtime 授权测试复用现有 CI。产品真实验收在 DEP01 集成、
MOD-11/12 Desktop 接线及 MOD-28 影响入口可用后，目标链只集中运行一次代表路径。

本工作树用现有已安装 TypeScript 5.9.3 工具链编译 goals，通过；
`node --test packages/goals/test/tool.test.mjs` 初版 3/3；延迟绑定修订后
TypeScript 编译与该文件定向测试 4/4 通过，未重复架构检查。
初版 `npm run check:architecture`
3/3 通过，`git diff --check` 通过。没有安装新依赖、运行
全仓检查或 Electron。新增包内 `@personal-agent/contracts` 声明，根 lock 登记
归公共接口任务，须在 CI `npm ci` 前完成；本包未修改根 lock。

## Desktop Goal 编辑器身份消费修复（2026-10-07）

本节记录 [PR #302](https://github.com/zemeng5208/PersonalAgent/pull/302) 的续接增量，
尚未合入 `main@4b5ec61`，不改变上文历史、模块状态或权限边界。
[Goal 编辑器](../../apps/desktop/src/features/conversation/goal-view.js) 对异步读回绑定
发起时的草稿、目标选择、活动任务和打开视图；切换目标、编辑草稿或关闭重开后，
旧读回、失败、取消及审批反馈不能覆盖新选择。确认成功后，Goal 身份、内容、原因、
有效期和版本来自同一完整读回；修订仍携带原图/Goal CAS 及依赖，不由 Renderer 写图。

真实受理任务与提交结果未知的锁独立于视图保存。迟到受理回复保留原任务读回入口，
即使任务列表暂未出现也保留已知受理任务；关闭重开不将受理说成完成或允许重复提交。
同一任务的取消、同一任务/审批身份/审批版本的决定在请求进行中保持按钮锁，
刷新该任务不会提前解锁；其他任务的操作独立，旧回复不会解锁其新请求。

[公开控件测试](../../apps/desktop/test/goal-view.test.mjs) 使用实际
`createGoalControl` 配合显式 Fake DOM/bridge。修复前，Task A 的迟到读回把 B 草稿
ID 改为 A、内容仍为 B，生成合法 CAS 的错误目标修订；同一复现修复后保留 B 身份和内容，
错误目标请求由 `true` 变为 `false`。新动作锁回归先实际失败，再通过。
验证分批进行：9/9 后新增重开恢复及迟到取消/审批反馈定向 2/2，动作锁新增 1/1，
受影响取消/审批反馈定向 1/1；语法和 `git diff --check` 通过。
当前文件共有 11 项测试定义，不把这些分次结果记成最终 11 项整批通过。
这些证据不代表真实 Runtime 写入、云、Windows 设备或个人数据现场验收，
独立浏览器消费验收另据实际执行记录登记。
