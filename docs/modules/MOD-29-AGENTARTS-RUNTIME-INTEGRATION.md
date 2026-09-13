# MOD-29：AgentArts Runtime Application 可信装配

- Profile：`huawei_ict_agentarts`；负责人：zemeng；状态：in_progress。
- 工作树：`.worktrees/zemeng-agentarts-runtime-integration`；基线：PR #39 /
  `188f925`。
- 依赖：MOD-04B CompetitionCoordinator 与 MOD-29 AgentArts HTTP Adapter 完成评审。
- 范围：`apps/runtime` 的唯一 Competition composition factory，以及 Desktop
  主进程的显式 profile/部署配置；不扩公共 wire Schema。

## 行为与边界

`createAgentArtsRuntimeApplication` 只接受 HTTPS gateway、runtime 名称、
`debug`/`published` 模式、受信授权提供者和测试用 fetch seam。它将
`AgentArtsCloudAgentPort` 包在 `CompetitionCoordinator` 后注入既有
`RuntimeApplication`，没有第二套任务库、Local/Fake fallback 或 Renderer 云调用。

Desktop 仅在受信进程环境明确设置
`PA_RUNTIME_PROFILE=huawei_ict_agentarts` 时选择该工厂；gateway、runtime 和完整
Authorization header 均由主进程读取。缺配置时 Runtime 明确保持未连接。凭据不进入
任务正文、Renderer snapshot、日志或仓库；后续持久配置必须使用系统加密存储。
显式空 profile/invoke mode 和 Competition + fake-model 组合均被拒绝；只有 profile
变量完全缺失时才沿用既有 Local 默认，显式 `--fake-runtime` 仍优先进入离线测试。

本工作包只接通文字调用。AgentArts 输出固定为 `unverified`，不能携带工具、
Evidence 或任务终态。工具提案 → 本地 Policy/Approval/ToolGateway → 目标读回 →
Evidence 是后续独立契约增量。

## 验收

- Runtime 纵向测试使用注入的合成 HTTP 响应，验证
  Client → RuntimeApplication → Coordinator → AgentArts adapter，以及无 Local
  fallback、授权只读取一次、请求正文最小化、结果无 Evidence。
- 非法 HTTP gateway 必须在创建数据库前拒绝。
- 依赖提交合入后，`npm.cmd run check` 已通过：架构门禁、生成类型、全 workspace
  类型检查与测试全部通过；其中 coordination 38/38、runtime 48/48、Desktop 6/6。
  `test:runtime-application-smoke` 也通过（7 次模型请求、2 次取消）。
  运行环境为 Node 26.3.0 / npm 11.16.0，仓库指定 Node 24.15.x / npm 11.12.x
  尚需由 CI 覆盖。
- 真实部署只使用合成事实；另行记录 deployment/version、runtime、trace、usage、
  取消/超时和失败语义。未获得真实读回前不得标记 available。
