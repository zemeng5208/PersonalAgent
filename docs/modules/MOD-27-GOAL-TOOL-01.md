# MOD-27-GOAL-TOOL-01：目标写入的受控工具薄适配

- Profile：`huawei_ict_agentarts`；MOD-27 / PA-024；负责人 `zemeng`。
- 所有权：`packages/goals/**` 与本文；Runtime、Policy、Desktop 和根 lock 保留原分工。
- 前置：Goal 命令 PR #136 head `0cb6e97`；DEP01 Draft PR #152 head `4930d43` 提供可信宿主发起的持久单工具任务、审批恢复和读回。本包依赖该 Draft 的接口形态，不把它当作已合并能力。

`createGoalTools(boundStore)` 复用现有 `createGoal`、`reviseGoal`、图版本 CAS 和
`CoordinationStorePort`，提供 `goals.create` / `goals.revise` 两个 `RegisteredTool`。
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
`node --test packages/goals/test/tool.test.mjs` 3/3 通过，`npm run check:architecture`
3/3 通过，`git diff --check` 通过。没有安装新依赖、运行
全仓检查或 Electron。新增包内 `@personal-agent/contracts` 声明，根 lock 登记
归公共接口任务，须在 CI `npm ci` 前完成；本包未修改根 lock。
