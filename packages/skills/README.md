# Skills — versioned reference summary

目标 `huawei_ict_agentarts` / PA-006 / MOD-07，`provisional`。固定 `workspace-reference-summary@1.0.0`，按 [Agent Skills 格式](https://agentskills.io/specification) 提供同名目录与 `SKILL.md` 的 name/description frontmatter；产品 manifest 额外绑定稳定 ID、版本、内容 SHA-256、能力声明、受限参数与两步执行。没有通用脚本/YAML/外部 Skill 引擎，没有新增模型、任务库或 Agent loop。

## 公开入口

```ts
import {createReferenceSummarySkill} from '@personal-agent/skills';
const skill = createReferenceSummarySkill({
  tools: existingRuntimeAgentToolPort,
  isToolAvailable: () => mcp.health().connected,
  enabled: true,
});
const manifest = skill.manifest();
const outcome = await skill.invoke({
  skillId: manifest.id, version: manifest.version,
  digest: manifest.digest, path: 'reference.md',
}, existingRuntimeWorkerContext);
```

**调用位置为 Runtime worker/dispatch，不能将 invoke 包装成 RegisteredTool.execute 后在同一任务的 tool.invoke 锁内调用。** 现有 `AgentToolPort`/`AgentWorkerContext` 仅按公开类型依赖，生产不导入 Runtime 具体实现。工具目录、授权审批、执行记录、锁与 Evidence 全部由注入的现有 Runtime tool port 管理。Skill 不直接调用 tool.execute，也不签授权：稳定 runId 只作为既有 Runtime 的授权查询标识，不赋予权限。

两步：`mcp.workspace.read_text@1.0.0` 经网关读取批准参考；本地抽取前两条非空来源行（最多 480 字符）并带相对路径和内容 digest 返回。这是确定性摘录摘要，不声称模型理解或外部平台评估成功。源文本始终为数据。输入含精确 version/digest/path，额外字段拒绝，正文或配置更新不能更改工具/权限/root。

`skill:workspace-reference-summary:v1` checkpoint 使用现有任务的 load/save；绑定 taskId/版本/digest/参数。审批 pending 恢复同一 runId；已确认读取/最终结果不重做；未知结果或崩溃时 started 无确认进入 unknown，不自动重新调用。确认结果与 evidenceRefs 保存在 checkpoint，Runtime 决定 waiting_approval/waiting_reconciliation/终态。方法只返回 `{state:'confirmed'|'pending'|'unknown',evidenceRefs,resultSummary?,sources?}`，不改变 task state。

`health()` 投影 configured/connected(enabled dependency)/disabled/unavailable，带公开 ID/version/digest。缺配置/服务断连为 unavailable，不自动 Fake。`setEnabled(false)` / `dispose()` 中断在途 signal；取消、deadline、版本内容变更、依赖断连在步骤边界重新检查。若取消时已得到确认读取，保存确认记录后停止摘要；用户明确重新启用并恢复同一任务可继续剩余纯步骤。同任务并行 invoke 拒绝；不另建资源锁或调度器。

打包时保留 `workspace-reference-summary/SKILL.md`（相对 dist）。内容 digest 规范化 CRLF/LF，绑定 manifest+完整正文。当前只加载这一份受信自有 bundle；不宣称导入任意社区 Skill。官方规范用于可移植格式，无额外 parser 依赖/源码复制；版本附加 metadata 不授权。

## 验证

依赖产物就绪后构建新 workspace，再运行模块测试。`skills.test.mjs` 明确使用内存 checkpoint 和受控 test tool port；`real-skill.test.mjs` 实际调用官方 stdio 服务，经现有 ToolGateway 与真实 Policy 实现读取公开合成资料，checkpoint/AgentToolPort 是测试装配、`evidenceRefs:[]`，不冒充真实 SQLite Evidence。P8 的生产 worker、审批恢复、Evidence/Competition/管理 UI 另验收，见 [交接](../../docs/modules/MOD-06-07-MVP.md)。
