# 连接器与服务模块的 Runtime 接线方案

版本：1.0（提案）· 日期：2026-09-22 · 作者：`Potatos498` · 评审：`goo122`（根装配负责人）

## 0. 目的与现状

MOD-20/21/22/23/24/25 六个模块源码已全部合并，但 `apps/runtime` 目前只装配了 weather（PR #9）。本方案给出其余五个包（feeds / mail / productivity / notifications / research）接入 Runtime 的完整设计，供 `goo122` 评审后按阶段落地。**本方案只做设计，不动根装配代码——实现 PR 由本方案批准后开出，goo122 评审。**

## 1. 接线模式（沿用 weather 先例）

weather 的两段式先例（`weather-runtime.ts`）：

```ts
// 1) 收集 RegisteredTool[]（数组宿主）
const tools: RegisteredTool[] = [];
registerX({register(tool) { tools.push(tool); return () => {};}}, {...});
// 2) 交给应用工厂
createRuntimeApplication({path, tools, text});
```

`RuntimeApplication` 构造器内部把工具注册进 policy 校验的 `ToolGateway`，经 `RuntimeToolInvoker` 进入任务审批流——scope 授权沿用既有 `policy.grant({scopes: [...]})` + approval 机制（weather 集成测试同款）。**五个包全部套用此模式，无新机制。**

## 2. 各包接线规格

| 包 | register 必填项 | 配置来源（建议） | 注册的工具（scope） |
| --- | --- | --- | --- |
| `@personal-agent/feeds` | `provider: new HttpFeedProvider()`；`subscriptions: [{id, url, sensitivity}]` | 订阅列表：环境变量 `PA_FEEDS_SUBSCRIPTIONS`（JSON）或桌面设置持久化 | `feeds:read`（`feeds:read`） |
| `@personal-agent/mail` | `provider: new QQMailProvider({user, authCode})`；多账号传 `registry` | `PA_QQ_MAIL_USER` / `PA_QQ_MAIL_AUTH_CODE`（已有约定）；账号绑定 UI 归桌面（Phase 3） | `mail.inbox`、`mail.accounts`（`mail:read`） |
| `@personal-agent/productivity` | `storage: StoragePort`；`conversationId` | storage：见 §3 适配器；conversationId 取应用级固定值（如 `default`） | `todo.list`（`todo:read`）；`todo.create/update`（`todo:write`） |
| `@personal-agent/notifications` | `storage: StoragePort`；`policy: NotificationPolicy` | storage 同上；policy（安静时段/暂停/聚合）：桌面设置持久化，缺省 `{}` | `notifications.status`（`notifications:read`） |
| `@personal-agent/research` | `provider: new OpenAlexProvider({mailto?})` | 免 key；`PA_OPENALEX_MAILTO` 可选（polite pool） | `research.search`（`research:read`） |

环境变量缺省时的行为：**连接器不注册，不报错**——与「provider 必填不静默降级」的包内语义一致：没有凭据就没有该工具，任务侧看到 `UNSUPPORTED_CAPABILITY`。凭据永不进仓库（已有先例：GeoNames/邮件授权码均走环境变量）。

## 3. 已识别缺口：StoragePort 适配器

`@personal-agent/storage` 的 `openStorage(path)` 返回 SQLite `DatabaseSync`，而 productivity/notifications 需要契约里的 KV 式 `StoragePort`（get/set/delete）。**缺一个 ~30 行的适配器**（建议放 `apps/runtime/src/` 或 storage 包内，goo122 定）：

```ts
// kvNamespace(db: DatabaseSync, table: string): StoragePort
// 单表 (namespace TEXT, key TEXT, value TEXT JSON)，WAL 已由 openStorage 开启；
// 写路径用 UPSERT 保证原子性（与两个包的「单键一次写入」语义对齐）。
```

测试照 testkit `FakeStorage` 的用法写（两包的既有 33 项测试全部基于该接口，适配器只需契约一致性测试 + 并发读写冒烟）。

## 4. 分阶段落地

**Phase 1——工具注册（一个 PR，本方案批准后即可开）**
- 新增 `apps/runtime/src/connectors-runtime.ts`：`createConnectorsApplication(options)`，按 §2 规格装配五包（weather 之外的增量），导出与 `createWeatherApplication` 平行的工厂；提供 `createLocalApplication`（全量：weather+五包）作为桌面缺省入口。
- 含 §3 适配器与契约测试；每个包至少一条「工具经 RuntimeApplication 审批流调用成功 + scope 拒绝」集成测试（照 `weather-integration.test.mjs` 模式，预计 +8~10 项）。
- 验收：`npm run check` 全绿；无凭据环境启动不报错、工具列表只含已配置的连接器。

**Phase 2——调度闭环（notifications/productivity 转 done 的最后一块）**
- 组合层调度器：任务启动/恢复时把 `notifications.planSchedules()` 与 productivity 的 `ReminderTrigger` 交给 `runtime.createSchedule()`（`missedRunPolicy` 已对齐）；schedule 触发时调 `notificationService.drain()` 并把批次写入 Runtime 事件流（`acknowledge` 由桌面调用）。
- 验收：安静时段结束自动裁定、提醒到点触发（fake 时钟集成测试）。

**Phase 3——桌面设置 UI（`zemeng`）**
- 订阅管理、邮箱绑定（授权码加密存储，照 Pangu API Key 模式）、通知策略（安静时段/暂停）设置页；绑定后热更新 registry。
- 验收：PA-014/PA-015 的用户可见闭环。

## 5. 边界与不做

- 根 `package.json`/锁文件不动（五包 build 行已在 main）。
- 不改任何包的公共接口；若接线中发现缺口，回包内走正常 PR。
- 竞赛 Profile（`huawei_ict_agentarts`）是否装载本地连接器由 goo122 决定，本方案默认仅 Local Profile。
- 天气已有 GeoNames 增强接线归 goo122 的既定事项，不在本方案。

## 6. 请求

请 @goo122 评审：① 模式认可（§1）；② 适配器归属（§3，apps/runtime 还是 storage 包）；③ Phase 1 授权与否。批准后我在 `feat/runtime-connectors-wiring` 分支实现 Phase 1 并提 PR。
