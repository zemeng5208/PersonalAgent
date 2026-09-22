# 连接器与服务模块的 Runtime 接线方案

版本：1.2（按 goo122/zemeng 2026-09-22 二轮评审修订）· 日期：2026-09-22 · 作者：`Potatos498` · 评审：`goo122`（根装配负责人）

## 0. 目的、现状与 Profile 边界

MOD-20/21/22/23/24/25 六个模块源码已全部合并，但 `apps/runtime` 目前只装配了 weather（PR #9）。本方案给出其余五个包（feeds / mail / productivity / notifications / research）接入 Runtime 的设计。**组合入口只定义 Competition（`huawei_ict_agentarts`）侧装配；Local 全量入口属未授权后续项，仅记录。**

## 1. 接线模式与工具注入路径（待 goo122 复核的代码事实）

计划沿用 weather 的两段式（数组宿主收集 `RegisteredTool[]` → `createRuntimeApplication({tools, profile, …})`）。

**关于「Competition Profile 是否接受 `tools`」**：goo122 二轮评审指出会直接 `INVALID_ARGUMENT`；zemeng 06:01 按当前 `main@d78613a` 源码核对得出相反结论。代码事实（我本轮复核一致）：

- `runtime-application.ts:33-37` 的构造器只拒绝两种组合：`local + coordination` 与 `huawei_ict_agentarts + text`——**不拒绝 Competition + tools**；
- `options.tools` 存在时构造 `ToolGateway` + `RuntimeToolInvoker`，两个 Profile 行为相同；
- `AgentArtsRuntimeApplicationOptions` 仅 Omit `profile | coordination | text`，未 Omit `tools`；`startCoordinationTask` 会把 `this.tools` 传入 coordination 路径。

**本节结论为「待复核」而非定论**：若 goo122 复核后确认 Competition + tools 成立，Phase 1 按 §5 执行；若结论仍是应走 CoordinationPort 专属路径（或该行为属无意泄漏、将收紧），则本方案的注入路径需按其裁定改写或另提接口/ADR 变更——不沿用 weather 接法作为既定前提。

## 2. 各包接线规格（工具名与 scope 逐一经源码核实）

五包合计 **9 个工具**：

| 包 | register 必填项 | 工具（scope） | 配置来源 |
| --- | --- | --- | --- |
| `@personal-agent/feeds` | `provider: new HttpFeedProvider()`；`subscriptions` | `feeds.collect`、`feeds.subscriptions`（均 `feeds:read`） | 订阅列表：宿主设置持久化 |
| `@personal-agent/mail` | 凭据经 §3 受信路径 | `mail.inbox`、`mail.accounts`（均 `mail:read`） | 授权码：`qq-mail-authcode`（§3） |
| `@personal-agent/productivity` | `storage: StoragePort`；`conversationId` | `todo.list`（`todo:read`）；`todo.create`、`todo.update`（`todo:write`） | storage：§4 适配器 |
| `@personal-agent/notifications` | `storage`；`policy` | `notifications.status`（`notifications:read`） | policy：宿主设置，缺省 `{}` |
| `@personal-agent/research` | `provider: new OpenAlexProvider()` | `research.search`（`research:read`） | 免 key |

配置缺失时：**连接器不注册、不报错**，任务侧看到 `UNSUPPORTED_CAPABILITY`。

## 3. 凭据注入与脱敏（v1.2：单一受信路径，消除 v1.1 的自相矛盾）

**v1.1 的错误**：同时主张「组合代码永不经手明文」与「装配层 `await secretStore.read` 后构造 Provider」——读取后丢弃局部变量不等于未持有明文，且裸调 `SecretStorePort.read` 绕过了 `ConnectorHost` 的 secretRefs 范围检查与取消检查。v1.2 收敛为一条路径：

**责任主体二分**：

| 主体 | 职责 | 明文接触 |
| --- | --- | --- |
| 普通组合层（Competition 组合代码） | 注册 `ConnectorFactory`（manifest + `create`）并**声明 `secretRefs: ['qq-mail-authcode']`**；持有 ConnectorHost 句柄；触发 `connect(id, signal)` | **永不** |
| 受信边界（`ConnectorHost.open` 构造的 `ConnectorFactoryContext`） | 在 `factory.create(context)` 内部经 `context.readSecret(ref)` 取得凭据并构造 `QQMailProvider` | 仅在此出现一次 |

`ConnectorFactoryContext.readSecret`（connector-host/src/index.ts:75-83）自带完整约束，本方案直接继承、不新增机制：

- **范围检查**：请求未声明的 ref → `SCOPE_DENIED`；
- **取消检查**：signal 中止 → `CANCELLED`；
- **缺失语义**：SecretStore 返回 `undefined` → `UNAUTHORIZED`（固定协议错误码，无原始错误正文）；
- **隔离性**：凭据注册与连接按 connectorId 独立——mail 连接失败不阻断其他四个连接器的装配与连接。

**统一失败语义（凭据缺失与凭据存储故障同一出口）**：该连接器保持不可用（health `disconnected`/`unavailable`），失败以固定错误码 + 脱敏 reason 记录；不透传原始错误正文、不记为已连接、不吞错冒充成功。后续合成验收：以占位凭据断言（工具描述/Runtime 事件/日志均不含凭据字符串；`readSecret` 未声明范围被拒；signal 取消不半构造）。

## 4. 已识别缺口：StoragePort 适配器

`@personal-agent/storage` 的 `openStorage(path)` 返回 SQLite `DatabaseSync`，而 productivity/notifications 需要契约的 KV 式 `StoragePort`（get/set/delete）。**缺 ~30 行适配器**（归属请 goo122 定）：`kvNamespace(db, table)` 单表 `(namespace, key, value JSON)`，UPSERT 写，与两包「单键一次写入」原子语义对齐。契约一致性测试 + 并发读写冒烟。

## 5. 分阶段落地

**Phase 1——Competition 工具注册（本方案批准后可开）**
- 组合层（与 `application/agentarts.ts` 同层）：五包按 §2 装配、mail 按 §3 走 ConnectorHost 工厂；注入路径以 §1 的 goo122 复核结论为准。
- 含 §4 适配器；每包至少一条「审批流调用成功 + scope 拒绝 + 无配置不注册」集成测试 + §3 三条失败路径断言（预计 +12~14 项）。
- 验收：`npm run check` 全绿；无凭据环境启动正常、工具列表只含已配置连接器。

**Phase 2——调度闭环**：`planSchedules`/`ReminderTrigger` → `runtime.createSchedule()`；schedule 触发调 `drain()` 写入事件流（`acknowledge` 由桌面调用）。验收：安静时段结束自动裁定、提醒到点触发（fake 时钟）。

**Phase 3——桌面设置 UI（`zemeng`）**：订阅管理、邮箱绑定（授权码写入 SecretStore 加密实现）、通知策略页；绑定后热更新。

**未授权后续项（仅记录）**：Local Profile 全量入口；weather GeoNames 环境变量装配。

## 6. 边界与不做

- 根 `package.json`/锁文件不动；不改任何包公共接口。
- 普通组合层不以任何形式经手明文凭据（§3 主体二分为唯一例外通道，由 ConnectorHost 承担）。

## 7. 请求

1. **@goo122**：按当前 `main` 源码复核 §1 的工具注入结论（zemeng 06:01 已给出具体行号引用；若维持拒绝结论请指出对应代码或裁定走 CoordinationPort 专属路径/ADR）。
2. **@goo122**：确认 §3 单一受信路径（ConnectorHost 工厂 + 声明 secretRefs）是否满足边界要求。
3. 适配器归属（§4）；Phase 1 授权与否。
