# @personal-agent/calendar

MOD-20 · 日历连接器（PA-013，P1；Fake 提供商先行）。负责人 `Potatos498`，评审者 `goo122`。

## 职责

- 把日历事件规范化为公共 `ConnectorItem`：`occurredAt` = 事件开始（UTC 瞬间），`validFor` = `[start, end)` UTC 区间，`contentRef` 携带目标时区的本地墙上时间，`dedupeKey` = `calendar:<calendarId>:<externalId>:<sequence>`（提供商修订后换键）。
- 窗口增量同步（`fetchChanges`，游标 = base64url 编码的窗口+偏移）、搜索、单条读取。
- `respond` 动作（接受/拒绝/暂定邀请）：幂等键决定 `actionId`，重复调用同输入返回一致结果，键冲突换输入抛 `INVALID_ARGUMENT`；`pending/unknown` 不出现——Fake 提供商同步确认。

## 非职责

- 邀请/变更的**授权决定**：由 Runtime → Policy → ToolGateway 链路做出（ADR-0003）；本连接器只执行已授权动作并留证据。
- 提醒生成：`@personal-agent/productivity`。
- 真实日历账号（OAuth/CalDAV/iCal 订阅）的授权与读回：后续独立工作包（见 ROADMAP 真实验收条件）。

## 公共入口

`src/index.ts` 导出 `register`、`CalendarConnector`、`CalendarService`、`FakeCalendarProvider`、`defaultCalendarFixtures`、`eventToItem` 与全部类型。

### 工具

| 工具 | 版本 | Scope | 副作用 | 幂等 | 恢复 |
| --- | --- | --- | --- | --- | --- |
| `calendar.events` | 0.1.0-alpha.1 | `calendar:read` | read | ✓ | ✓ |

`register(host, options)`：`options.provider` 必填（缺失抛 `INVALID_ARGUMENT`，Fake 仅测试用）。入参 `fromUtc/toUtc` 缺省为当前时刻起 `defaultWindowDays`（默认 7）天；`limit` 1..100（默认 20）；`cursor` 透传上一页 `nextCursor`（空串表示取尽）。

### 连接器（ConnectorPort）

manifest：`id=calendar`、`accountTypes=['fixture']`（随提供商 `providerKind`）、`capabilities=['fetchChanges','search','getItem','performAction']`、`authentication='none'`（Fake）、`syncStrategy='windowed'`、`verification='mock'`。未 `connect()` 前调用数据方法抛 `UNAUTHORIZED`；游标损坏抛 `CURSOR_EXPIRED`；不支持的动作抛 `UNSUPPORTED_CAPABILITY`。

## 取消、超时与重试

- 取消：工具入 ToolContext.signal 后由宿主门禁（FakeToolHost 语义）；连接器方法为同步短调用，无悬挂请求。
- 超时：由宿主 deadline 控制。
- 重试：`fetchChanges`/`search`/`getItem` 只读可重试；`performAction` 重试必须携带**同一幂等键**，重复响应由幂等表去重。

## 证据

- `respond` 返回 `evidenceRefs: ['calendar:<externalId>#<response>']`。
- Fake 夹具含跨 DST 事件（纽约 2026-11-01 回拨夜：01:30 EDT = 05:30Z 起，03:00 EST = 08:00Z 止）用于验证时区正确性。

## 依赖

- 生产：`@personal-agent/contracts`（ConnectorPort、ConnectorItem、ProtocolError）。
- 测试：`@personal-agent/testkit`。

## 测试

`node --test test/*.test.mjs`（10 项）：DST 事件字段、connectorItem 契约校验、dedupeKey 稳定性与变更换键、分页聚合与排序、搜索/单条、respond 幂等与键冲突、连接器健康状态与游标、工具 schema/scope、缺 provider 拒绝、窗口校验。全部离线。

## 已知限制与 Fake/真实验收边界

- manifest `verification: 'mock'`——**没有真实日历账号的授权与读回**。PA-013 的真实验收（至少一个真实连接器授权+读回、时区正确、邀请/变更按动作授权）待独立工作包完成后翻转。
- Fake `search` 为客户端标题过滤；真实提供商应实现服务端搜索。
- `respond` 在 Fake 上同步 `confirmed`；真实提供商可能返回 `pending/unknown`，届时不得当作已完成（ADR-0003）。
