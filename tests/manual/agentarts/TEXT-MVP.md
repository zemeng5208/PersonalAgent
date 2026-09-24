# AgentArts 文字 MVP 继续入口

目标 profile：`huawei_ict_agentarts`。工作包：MOD-04B/29/30/32 文字适配；负责人
zemeng，非作者评审待 goo122 或另一位已登记协作者完成。接口仍为 provisional。

## 当前修复与证据边界

从 main `c5c4ada` 选择性重建 #51/#78 的 coordination 文字增量，不合并旧堆叠：

- 有 workflow_start/workflow_end 的响应只选择最后一个已完成工作流的 answer；必须
  随后看到 task_end、end，错误事件仍覆盖候选答案。新工作流开始会清除旧候选。
- 显式 workflow_start 划分 message index 的作用范围；同一范围内 index 对应不同
  正文仍拒绝。累计 message 文字预算、单个 answer 预算和响应字节上限均保留。
- 受信宿主可选 `workflowGoalInput`，把 goal 映射到一个 Workflow 开始节点变量；
  省略时保留 `{query: goal}`，配置时只发送 `{inputs: {[name]: goal}}`。
- 纯文字适配器拒绝 continuation，不能忽略已执行工具的结果后重新发送原问题。

历史 #51 的 `2026-09-17-runtime-index-conflict.json` 证明 HTTP 200、完整 SSE、
ordered task_end/end 和全局 index 冲突，但未证明冲突发生在工作流内还是工作流间，
也未确定生产解析器首个拒绝分支。`2026-09-17-runtime-text-success.json` 的名字
不表示 Desktop 成功：云端调用成功，但两次 Desktop 调用均 EXTERNAL_FAILURE，
同库重启只读回失败终态。不能把旧离线夹具通过视为本次真实故障已修复。

## Runtime/Desktop 接线（由对应负责人实施）

Runtime 的 `createAgentArtsRuntimeApplication` options、解构和 AgentArts config
需透传可选 workflowGoalInput。Desktop 从受信启动配置提供该值，不能让 Renderer
或云输出决定配置。Competition task.submit 应传入 180000ms deadline；历史真实
调用约 70–90 秒。保留 main 的工具装配、取消和数据路径行为，不能整段覆盖旧文件。
多 Agent query 入口与单 Workflow inputs 入口须按实际部署选择，不能自动猜测或重试。

## 验证顺序

1. 构建 contracts、coordination，运行 coordination 单测、类型检查与架构门禁。
2. 在主控安排的资源时段，以单个 Node 进程和受信凭据发起合成文字调用；不记录
   Authorization、原始响应、正文、工作流名称或私人数据。不做自动重试。
3. 若仍失败，记录状态码、固定事件类别/字段类型/顺序、字节与文字长度、index 冲突
   的工作流作用范围及确切拒绝分支，再决定解析器修改。未知结构不能直接放宽校验。
4. 由集成执行者验证 Desktop → Runtime → 真实 AgentArts 的文字展示、持久化；
   关闭后从同一数据库重启，不提交任务、不读凭据、不发网络请求，读回相同结果。

云端文字一律 `unverified`；不产生 trusted Evidence，不扩大 Policy，不回退 Local。
真实工具循环、云端 trace/usage、Desktop 成功和同库重启分别记录，未验收不标 done。

## 2026-09-24 本工作树离线验证

- contracts、coordination build 与 coordination typecheck 通过。
- coordination 单测 73/73、架构门禁 3/3、git diff --check 通过。
- 原 npm 测试在沙箱中因 spawn EPERM 未执行用例；最小权限重跑同一脚本后通过。
- Node 26.3.0 / npm 11.16.0；未按仓库指定 Node 24.15.x / npm 11.12.x 验证。
  仅安装两个 workspace 的必要依赖并忽略安装脚本，未修改锁文件。
- 本记录不包含本日真实 API、Desktop 或同库成功结果重启验收。
