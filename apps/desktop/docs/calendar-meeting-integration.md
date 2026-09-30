# P8 日历旧条目与会议事实绑定

Profile：`huawei_ict_agentarts`。共享装配由 P8 负责；P1 连接器和 P5 投影源保持各自所有权。接口为 `provisional`，没有新增 wire operation、Schema 或迁移。

`calendar-meeting-host.js` 消费现有 Runtime HostTool 任务和 coordination graph。旧条目、配置绑定与 Evidence 引用保存在原 Runtime 数据库的 checkpoint，不新建日历基线或事实存储。

## 已实现

- `read({externalId})` 先 `prepareHostToolTask`，create-only 冻结配置身份与 UID，再 `finalizeHostToolTask` 进入原审批路径。保存配置本身不授予 `calendar:read`。
- `bindMeeting({taskId,meetingFactId})` 只接受该宿主创建的读取任务；要求 `succeeded`、`confirmed`、同配置与相同 UID 的公共 `ConnectorItem`。Renderer 不能提供旧条目、sourceRef、凭据或 Evidence。
- CalDAV 的固定 `calendarId=caldav`、sequence、UTC 区间、发生时间与获取时间均检查。旧会议必须 `[confirmed]`。
- Fact 必须已经存在、有效且为相同内容/来源/sourceRevision；绑定不创建或修改 Fact。来源标识为 `calendarMeetingSourceRef(accountRef,externalId)`，仅保存在可信本地路径。
- 绑定 checkpoint 为 create-only；恢复重新核对原确认回执、当前配置与 Fact revision。配置轮换、撤销、事实撤回或更新会拒绝旧绑定。
- `refreshMeeting({baselineTaskId,currentTaskId},refresh)` 串行提供同会议的两份独立已确认回执给 P5 `refreshCalendarMeeting`；`calendarReadPort` 不直接调用连接器或再读取网络。
- main 新日历 IPC 仅限正式 Competition admin 窗口；审批校验该任务的 approvalId/revision，取消只接受本宿主任务。撤销配置先取消在途任务并撤销原 runId 授权。

## 单条工具交付后挂载

构造 `createDesktopCalendarMeetingHost` 时，由可信 composition 注入公开 `RegisteredTool` 为 `readTool`，以及 `readArguments(configBinding,externalId)`。工具必须 `sideEffect=read`、`requiredScopes=['calendar:read']`、无需 presence；直接结果必须为公共 `ConnectorItem`。该回调是宿主内部适配，不是新公共 DTO。

1. factory 在执行时核对完整当前 binding，并经 `calendarConfig.readAuthorization(binding)` 取得凭据；不得从 Renderer 获取凭据或自动恢复旧授权。
2. 将 `host.tools` 注册到既有 Runtime Application；不放入 automaticTools 或云端结果出口。deadline/cancel 必须传入实际 fetch。
3. bindApplication 后将 `calendarReadPort` 注入 P5 已有 composition。IPC 的 refresh 消费 P5 的既有投影接口，不签发 CAS 授权。
4. 真正具备工具后才补用户读取/审批入口和运行验证。尚未交付的 Fact 初次投影与目标依赖绑定仍不可用，不能用生成 Fact ID 或直接 appendBatch 替代。

当前 main 未注入单条工具 factory，生产 `tools=[]`、`readAvailable=false`；调用明确 `UNSUPPORTED_CAPABILITY`。CalDAV 提供商已经存在于 main，缺的是受控共享装配。

## 本轮验证

`node --test apps/desktop/test/calendar-meeting-host.test.mjs`：4 个显式 Fake 端口检查通过，覆盖无工具零任务、审批前冻结、未确认/异源拒绝、旧 Fact 必须匹配、create-only 恢复、配置轮换、未知执行、绑定双回执与事实撤回。无 graph 写入、网络、模型、桌面或迁移验证。

`node --check`：main 与新宿主通过；`git diff --check` 通过。没有运行全仓 check 或整体 Smoke。
