# MOD-09I：候选流程版本、验证启用与回退

- Profile：`huawei_ict_agentarts`；需求：PA-020。
- 负责人：`goo122`；非作者评审者：`zemeng`。
- 基线：MOD-09H / Draft #204；本片按 #202 → #203 → #204 之后集成。
- 状态：`in_progress`；本片不代表 MOD-09 完成。

## 边界

新增 `packages/learning` 独立 SQLite workspace。候选流程只有摘要和最多 16 条描述性步骤，
不含工具参数或自动执行授权。每次提案形成不可变版本，绑定来源、操作 ID 和预期头版本；
重试幂等，冲突拒绝。

可信装配层注入 `WorkflowValidatorPort` 对精确候选版本做验证。仅持久 `passed` 的版本可被
选为 active；失败或异常不启用。启用使用预期 active revision 做 CAS，并保存切换回执。
再次选用已验证旧版本即回退；候选与验证记录仍可追溯。

删除以精确工作流头版本为门槛，在同一库事务清除其全部候选、验证引用和切换历史，
保留无正文的防重用标记；`secure_delete=ON`，WAL `TRUNCATE` 成功后才报告宿主成功。
无关工作流保留。独立备份、旧空闲页和用户授权入口未处理，不能宣称用户级彻底删除。

## 验收

- 候选不可直接启用；验证失败不可启用，验证器异常不留已验证标记。
- 通过验证后可启用、重启后保留、可回退到旧已验证版；过时 active revision 和变更重试拒绝。
- 提案与启用回执写入故障整体回滚；删除不影响其他工作流，重启后幂等。
- 包构建/测试、架构门禁与根 `npm run check` 通过，接口目录保持 provisional。

本片只用合成验证器；真实用户确认、真实验证规则、生产能力注册和 AgentArts 工作流
编排/部署/trace 均未验收。不能把本地描述性候选当成云端 AgentArts Workflow。

## 本地验证（2026-09-28）

- `npm.cmd run build --workspace=@personal-agent/learning`：通过。
- `npm.cmd run test --workspace=@personal-agent/learning`：5/5 通过。
- `npm.cmd run check`：架构、契约、生成类型、全部 workspace 构建/类型/测试及根集成通过。
- 最后补充验证器输入隔离与无效 context 检查后重跑定向测试；`git diff --check` 通过。
- 以上均为合成离线证据，真实授权、验证器和用户工作流尚未验收。
