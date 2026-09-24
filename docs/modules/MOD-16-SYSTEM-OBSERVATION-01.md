# MOD-16-SYSTEM-OBSERVATION-01：只读系统聚合观测

- Profile：`huawei_ict_agentarts`；MOD-16/17、PA-011。
- 负责人：zemeng；非作者评审者：goo122；状态：review。
- 基线：`72cc76b`；分支：`codex/zemeng/system-observation`。
- 本包新增 workspace 构建与 lock 登记，无外部依赖、数据库迁移或 wire Schema 变更。
- 现有本地完整检查受邮件依赖未安装影响，本包采用定向验证与干净 CI；不宣称本地全仓通过。

## 范围

本工作包把用户原先要求的 TraceGuard 集成缩减为 PersonalAgent 所需的最小电脑数据获取能力。
它不集成、复制或发布 TraceGuard，也不实现 MOD-16 的 Windows 操作、Named Pipe、凭据适配，
或 MOD-17 的治理与恢复。

交付物是 `@personal-agent/windows-client` 的单个 `RegisteredTool` 工厂。默认 probe 只读取：

- 两次 CPU tick 采样得到的整体利用率和逻辑处理器数量；请求间隔字段不冒充实测耗时；
- 内存总量、可用量及由两者计算的使用量；
- 系统 uptime、采集时间和采样窗口。

不读取 hostname、用户名、进程/命令行、文件/路径、网络地址或凭据。进程归因、磁盘 I/O、
温度和网络活动保持 `unavailable`，调用方不得据此捏造性能因果。

## 信任与执行边界

- 工具是 `sideEffect=read`，只申请 `computer:system:read`。
- 输入和输出使用 `additionalProperties=false` 的精确 Schema。
- probe 由受信宿主注入；默认实现使用 Node `os`，不启动 Shell 或申请更高权限。
- 注入 probe 的结果标记 `source=injected`，只有默认适配器标记 `source=node:os`。
- sampling 同时受 `ToolContext.signal` 和 deadline 约束；取消/超时清理计时器且不重试。
- probe 异常统一为脱敏 `EXTERNAL_FAILURE`，不会回显系统或测试错误正文。

## 验收与状态

定向合成测试应覆盖确定性聚合、严格 Schema、不可用项、取消、deadline、单次 probe 采样及
错误脱敏；类型检查和模块构建独立通过。可选本机 smoke 只报告断言通过/失败，不输出观测值。

这是 provider slice，不是整个 MOD-16 或 PA-011 完成。当前 Competition Coordination 仍只接受
有界文本并拒绝 Local tools；AgentArts 工具提案、Runtime 装配和 Desktop 展示均不在本包范围。

2026-09-17 在独立工作树完成的最少验证：本树 contracts 构建、windows-client 类型检查与构建
通过；`node --test --test-isolation=none packages/windows-client/test/system-observation.test.mjs`
共 7 项通过。Policy/ToolGateway 合成集成测试 1 项通过，证明缺授权和撤销均在读取 probe 前
拒绝、授权后仅执行一次采样。另执行一次默认 `node:os` probe 的本机 smoke，只输出 `PASS`，
未输出或落盘任何观测值。上述结果证明 provider 的本地读取和边界，不证明 Competition/Desktop
已接通。
