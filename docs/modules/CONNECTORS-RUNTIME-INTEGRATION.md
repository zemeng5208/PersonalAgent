# 连接器与服务模块的 Runtime 接线方案

版本：1.1（按 goo122 2026-09-22 评审意见修订）· 日期：2026-09-22 · 作者：`Potatos498` · 评审：`goo122`（根装配负责人）

## 0. 目的、现状与 Profile 边界

MOD-20/21/22/23/24/25 六个模块源码已全部合并，但 `apps/runtime` 目前只装配了 weather（PR #9）。本方案给出其余五个包（feeds / mail / productivity / notifications / research）接入 Runtime 的设计，供 `goo122` 评审后分阶段落地。

**Profile 边界（v1.1 修正）**：当前仓库规则为新增实现只服务 `huawei_ict_agentarts` Competition Profile。本方案的组合入口因此**只定义 Competition 侧装配**（`createCompetitionConnectors…`，与 `agentarts.ts` 装配同层）。为 Local Profile 提供 `createLocalApplication` 全量入口属于**未授权后续项**，仅在此记录，不在本方案范围——需要时另行申请。

## 1. 接线模式（沿用 weather 先例）

weather 的两段式先例（`weather-runtime.ts`）：

```ts
// 1) 收集 RegisteredTool[]（数组宿主）
const tools: RegisteredTool[] = [];
registerX({register(tool) { tools.push(tool); return () => {};}}, {...});
// 2) 交给应用工厂
createRuntimeApplication({path, tools, profile: 'huawei_ict_agentarts', coordination});
```

`RuntimeApplication` 构造器内部把工具注册进 policy 校验的 `ToolGateway`，经 `RuntimeToolInvoker` 进入任务审批流——scope 授权沿用既有 `policy.grant({scopes})` + approval 机制（weather 集成测试同款）。**五包全部套用此模式，无新机制。**

## 2. 各包接线规格（工具名与 scope 逐一经源码核实）

五包合计 **9 个工具**：

| 包 | register 必填项 | 工具（scope） | 配置来源 |
| --- | --- | --- | --- |
| `@personal-agent/feeds` | `provider: new HttpFeedProvider()`；`subscriptions` | `feeds.collect`、`feeds.subscriptions`（均 `feeds:read`） | 订阅列表：宿主设置持久化 |
| `@personal-agent/mail` | `provider`（见 §3 凭据边界）；多账号传 `registry` | `mail.inbox`、`mail.accounts`（均 `mail:read`） | 授权码经 SecretStorePort（§3） |
| `@personal-agent/productivity` | `storage: StoragePort`；`conversationId` | `todo.list`（`todo:read`）；`todo.create`、`todo.update`（`todo:write`） | storage：§4 适配器；conversationId 应用级固定值 |
| `@personal-agent/notifications` | `storage`；`policy: NotificationPolicy` | `notifications.status`（`notifications:read`） | policy：宿主设置持久化，缺省 `{}` |
| `@personal-agent/research` | `provider: new OpenAlexProvider()` | `research.search`（`research:read`） | 免 key；mailto 可选 |

配置缺失时的行为：**连接器不注册、不报错**——与包内「provider 必填不静默降级」语义一致：没有配置就没有该工具，任务侧看到 `UNSUPPORTED_CAPABILITY`。

## 3. 凭据注入与脱敏（v1.1 新增，goo122 指定边界）

**邮件授权码等敏感凭据不由组合代码直接读环境变量构造 Provider**。注入与责任划分：

- **受信读取**：凭据经 `@personal-agent/connector-host` 的 **`SecretStorePort.read(secretRef, signal)`** 读取（Electron 侧由主进程实现该端口——加密存储照 Pangu API Key 先例；服务侧由部署环境注入实现）。组合代码只持有 `secretRef`（如 `qq-mail-authcode`），**永不经手明文**。
- **构造时机**：Provider 构造移入读取方（桌面主进程 / SecretStore 实现方）提供的工厂回调，或在装配层经 `await secretStore.read(ref)` 后立即构造并丢弃中间量——具体形态由 goo122 在实现评审时定，本方案只锁定边界：**明文凭据只在 SecretStore 实现与 Provider 构造函数之间出现一次，不进入日志、快照、工具描述或 Runtime 事件**。
- **脱敏责任**：包内已保证（mail 的错误映射不回显凭据/URL；README「重启与恢复」声明 actionId 证据不含凭据）。组合层补充验收：注入失败路径下——
  1. `secretStore.read` 返回 `undefined`（无凭据）→ mail 连接器不注册、其余四包正常，启动无错；
  2. `read` 抛错 → 同上（不吞错也不阻断其他连接器装配）；
  3. 任何输出面（工具描述/事件/日志）不含凭据字符串——以占位凭据做断言测试。

## 4. 已识别缺口：StoragePort 适配器

`@personal-agent/storage` 的 `openStorage(path)` 返回 SQLite `DatabaseSync`，而 productivity/notifications 需要契约里的 KV 式 `StoragePort`（get/set/delete）。**缺一个 ~30 行适配器**（归属请 goo122 定：`apps/runtime/src/` 或 storage 包）：

```ts
// kvNamespace(db: DatabaseSync, table: string): StoragePort
// 单表 (namespace TEXT, key TEXT, value TEXT JSON)，WAL 已由 openStorage 开启；
// 写路径 UPSERT，与两包「单键一次写入」原子语义对齐。
```

测试照 testkit `FakeStorage` 用法（两包既有测试全基于该接口）；适配器需契约一致性测试 + 并发读写冒烟。

## 5. 分阶段落地

**Phase 1——Competition Profile 工具注册（本方案批准后可开）**
- 新增 Competition 侧组合（与 `application/agentarts.ts` 同层）：按 §2 装配五包进 `profile: 'huawei_ict_agentarts'` 的 `createRuntimeApplication`；凭据路径按 §3。
- 含 §4 适配器与契约测试；每包至少一条「工具经审批流调用成功 + scope 拒绝 + 无凭据不注册」集成测试（照 `weather-integration.test.mjs` 模式，预计 +10~12 项）。
- 验收：`npm run check` 全绿；无凭据环境启动不报错、工具列表只含已配置连接器；§3 三条失败路径断言通过。

**Phase 2——调度闭环（notifications/productivity 转 done 的最后一块）**
- 组合层调度器：任务启动/恢复时把 `notifications.planSchedules()` 与 productivity 的 `ReminderTrigger` 交给 `runtime.createSchedule()`；schedule 触发时调 `drain()` 并把批次写入 Runtime 事件流（`acknowledge` 由桌面调用）。
- 验收：安静时段结束自动裁定、提醒到点触发（fake 时钟集成测试）。

**Phase 3——桌面设置 UI（`zemeng`）**
- 订阅管理、邮箱绑定（授权码入 SecretStore 加密存储）、通知策略设置页；绑定后热更新 registry。
- 验收：PA-014/PA-015 用户可见闭环。

**未授权后续项（仅记录）**：Local Profile 全量入口 `createLocalApplication`；weather GeoNames 环境变量装配（goo122 既定事项）。

## 6. 边界与不做

- 根 `package.json`/锁文件不动（五包 build 行已在 main）。
- 不改任何包公共接口；接线缺口回包内走正常 PR。
- 不经 SecretStore 以任何形式在组合层处理明文凭据（§3）。

## 7. 请求

请 @goo122 复审：① Profile 边界修订（§0）是否满足当前规则；② 凭据边界（§3）的形态是否可接受（工厂回调 vs 装配层单次读取，实现评审时定）；③ 适配器归属（§4）；④ Phase 1 授权与否。
