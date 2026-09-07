# 公共开发协议

版本：0.1.0-draft · 日期：2026-09-05 · 协议负责人：`goo122`

状态：MOD-02 的 0.1.0-alpha.1 公共包、JSON Schema、生成类型、客户端和 Fake 六场景已通过 PR #1 评审并集成；wire 版本为 1.0.0。协议仍待桌面消费者和第三方连接器按同版本联调后冻结。模块分工见 [MODULE_ASSIGNMENTS](MODULE_ASSIGNMENTS.md)，接入见 [testkit](../packages/testkit/README.md)。

## 1. 规范来源与冻结

- `goo122` 维护 `packages/contracts/` 的 JSON Schema、生成类型与测试夹具；本文件解释语义。`goo122` 在首次交付时使两者一致，消费者不得自行复制不同版本。
- wire 版本初定 `1.0.0`，与本文草案版本分开。开发包可预发布；`goo122`、`zemeng` 和参与开发的第三位协作者验证后记录实际版本、提交号、日期，才称为冻结。
- 新增可选字段为兼容扩展；删除字段、修改含义、增加消费者无法处理的必需状态必须升级不兼容版本或协商能力。
- 握手交换协议版本与能力列表；主版本不一致拒绝连接。新操作必须先通过能力发现，不能只凭次版本猜测支持。
- 变更流程：提出差异和消费者影响 → `goo122` 更新 Schema/夹具 → `zemeng` 和待认领协作者检查 → `goo122` 集成。禁止 UI 和服务端私自约定临时字段。

## 2. 通信分层

- Electron 渲染器只调用 `packages/client/` 公开 API，经 `zemeng` 的 preload 桥接；不访问 Named Pipe、密钥或原生工具。
- Runtime 与 Windows Host 使用受限 Named Pipe。`goo122` 发布 Schema 与 JSONL 帧定义，`zemeng` 实现 Host；每帧一行 UTF-8 JSON，字符串内换行转义，最大 1 MiB，超限拒绝。
- 应用 IPC 封装为同一消息对象，不要求所有传输都采用 JSONL。
- 大音频、截图、附件使用宿主生成的临时 `artifactRef`，单独分片传输；引用绑定任务/会话、访问主体和到期时间，不能接受外部任意路径作为可信引用。流具有序号、取消和背压。
- 时间统一 ISO 8601 UTC；日程额外带 IANA 时区；业务计算不使用界面格式化文本。标识符视为不透明字符串，生产环境由可信组件生成。

## 3. 请求、响应与事件

以下 TypeScript 只说明形状，生产校验由 `goo122` 的 Schema 提供。所有 `payload` 在进入业务代码前按 `operation` 选取具体 Schema。

```ts
type Request<T> = {
  kind: "request";
  protocolVersion: string;
  requestId: string;
  taskId?: string;
  operation: string;
  deadline: string;
  idempotencyKey?: string;
  payload: T;
};

type Response<T> = {
  kind: "response";
  protocolVersion: string;
  requestId: string;
  outcome: "ok" | "error";
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
  evidenceRefs: string[];
};

type Event<T> = {
  kind: "event";
  protocolVersion: string;
  eventId: string;
  streamId: string;
  sequence: number;
  taskId?: string;
  type: string;
  occurredAt: string;
  payload: T;
};
```

`outcome=ok` 必须有 `data` 且无 `error`；`outcome=error` 必须有 `error` 且无 `data`。请求被接受不等于任务完成。`requestId` 用于关联单次调用，业务幂等使用 `idempotencyKey`，二者不混用。

普通 UI 请求不能携带可信授权令牌。仅 Runtime→执行器的内部调用增加 `authorizationRef`，由宿主绑定动作、对象、期限和调用主体。内部调用也校验，不因为是本机连接就放行。

## 4. 最小公开 API

每个操作都是应用内部契约，不表示第三方平台拥有同名 API。`goo122` 在 MOD-02 发布下列最小请求/结果 Schema；领域能力可由 manifest 注册，未注册返回不支持。

| 操作 | 请求关键字段 | 返回关键字段 | 提供者 / 消费者 |
| --- | --- | --- | --- |
| `system.handshake` | supportedMajor、clientCapabilities | protocolVersion、capabilities、sessionRef | `goo122` / `zemeng`、待认领 |
| `task.submit` | goal、conversationId、attachmentRefs?、idempotencyKey（信封） | taskId、state、revision | `goo122` / `zemeng` |
| `task.get` | taskId | TaskSnapshot | `goo122` / `zemeng` |
| `task.cancel` | taskId、reason? | taskId、state、cancelAccepted | `goo122` / `zemeng` |
| `event.subscribe` | streamId、afterSequence? | subscriptionId、replayFrom | `goo122` / `zemeng`、待认领 |
| `capability.list` | kind? | manifests、health | `goo122` / `zemeng` |
| `settings.get` | namespace | value（脱敏）、revision | `goo122` / `zemeng` |
| `settings.update` | namespace、expectedRevision、patch | revision | `goo122` / `zemeng` |
| `authorization.respond` | approvalId、decision、expectedRevision | accepted、approvalState | `goo122` / `zemeng` 界面 |
| `tool.invoke` | toolName、toolVersion、arguments、scopeRef | runId、state 或验证后结果 | `goo122` / 专业 Agent、模块 |
| `connector.connect` | connectorId、accountLabel | sessionRef、interactionRequired | `goo122` 宿主调用待认领 / `zemeng` |
| `connector.disconnect` | accountRef | disconnected、cleanupState | `goo122` 宿主调用待认领 / `zemeng` |
| `voice.start` | mode=push_to_talk、deviceRef | voiceSessionId、audioFormat | `zemeng` 服务经 `goo122` 注册 / `zemeng` UI |
| `voice.stop` | voiceSessionId、reason | captureStopped、playbackStopped | `zemeng` 服务 / `zemeng` UI |

`goal` 非空、`decision` 为 allow_once/deny（持续授权另按配置 Schema），`expectedRevision` 不匹配返回冲突。`scopeRef` 是已授权范围引用，不是允许调用者任填新路径的授权依据。高风险动作由 Runtime 创建独立 approval，工具不能伪造。

settings 中不传长期密钥。新增账号由受控连接流程接收凭据并存入凭据服务；UI 最多收到掩码和状态。

## 5. 任务状态与事件语义

TaskSnapshot 必含 `taskId`、`state`、`revision`、`updatedAt`、`steps`、`evidenceRefs`；结束时可含 `resultSummary`、`error` 和已发生的副作用摘要。

状态集合：`created`、`planning`、`running`、`waiting_approval`、`waiting_external`、`waiting_reconciliation`、`verifying`、`cancelling`、`succeeded`、`failed`、`cancelled`。

- 主路径：created → planning → running → verifying → succeeded。
- planning/running/verifying 可以进入等待或 failed；等待完成回到对应执行步骤。审批拒绝且没有可继续的步骤时进入 cancelled。
- 外部写入返回不明时进入 waiting_reconciliation，先读取外部结果，不重发。
- 取消请求进入 cancelling；执行器确认已停止且副作用状态已知后才能 cancelled。状态未知则 waiting_reconciliation，并保存 `cancelRequested=true`。
- 取消来得太晚且任务已结束时，返回已有终态和 `cancelAccepted=false`，不能将已成功操作改成未执行。
- 终态不可直接重开；重试创建新任务并引用原任务。部分成功后失败仍保留已完成步骤和不可逆副作用。

必备事件：`task.created`、`task.state_changed`、`task.progress`、`task.completed`、`task.failed`、`task.cancelled`、`approval.requested`、`tool.completed`、`notification.created`。具体 payload 按事件类型校验。

`task.progress` 提供 `stepId`、`label`、`completedUnits?`、`totalUnits?`；无法计量时不发送百分比。悬浮球状态由任务/语音事件映射，不能用虚假计时模拟实际进展。

事件至少一次交付；消费者按 eventId 去重，按 streamId/sequence 排序。`goo122` 为每个流提供递增序号，重连从已处理序号续订。回放窗口已过返回 `CURSOR_EXPIRED`，客户端获取快照后续订；有限队列满时显式要求重同步，不静默丢状态。

## 6. 工具、模块与依赖注入

模块导出 `register(host): dispose`。host 提供公共端口；模块通过接口调用，不导入 Runtime 内部实现或其他模块私有存储。

目录和依赖遵循 [项目目录规范](PROJECT_STRUCTURE.md)：`apps` 负责进程与装配，`packages` 不反向依赖 `apps`，连接器位于 `packages/connectors/<capability>/`。模块专用端口由消费模块拥有，只有稳定跨进程数据进入 `packages/contracts`。跨包禁止相对路径和未声明的私有深层导入。

工具描述包含：`name`（如 knowledge.search）、`version`、`inputSchema`、`outputSchema`、`sideEffect`（read/local_write/external_write）、`requiredScopes`、`idempotencySupport`、`recoverySupport`、`requiresPresence`。一个工具包含多种动作时按最强副作用声明，优先拆成独立工具。

`execute(input, context)` 的 context 由宿主注入：`taskId`、`runId`、`deadline`、`signal`、`authorizationRef`、受限 logger 和所需端口。回传数据需 outputSchema 校验，并保存结果与证据；调用返回不一定代表业务已验证。

| 端口 | 实现负责人 | 使用规则 |
| --- | --- | --- |
| TaskPort / EventPort / SchedulerPort | `goo122` | 所有模块通过 Runtime 调度；不私建第二套持久任务库 |
| ToolPort / PolicyPort / ModelPort | `goo122` | 请求经范围检查；模块不能自行扩大工具或云端数据访问 |
| StoragePort | `goo122` | 注入模块命名空间；不得直接读取别人的表；迁移交 `goo122` 编号集成 |
| SecretStorePort | `zemeng` 实现 Windows 适配，`goo122` 控制注入 | 仅受信宿主/连接器受限取得凭据；模型和 UI 不可访问 |
| KnowledgePort | `goo122` | 返回来源引用；写入带 expectedRevision |
| DesktopActionPort | `zemeng` | 目标确认、输入独占、用户接管和后置验证 |
| VoicePort | `zemeng` | 音频流与任务取消分离；会话销毁释放采集 |

工具代码隔离必须在运行时落实，TypeScript 接口或进程拆分本身不构成沙箱。

## 7. 平台连接器契约

连接器方法：`connect`、`disconnect`、`getCapabilities`、`fetchChanges`、`search`、`getItem`、`performAction`、`health`。不支持的方法返回 `UNSUPPORTED_CAPABILITY`。

- `fetchChanges({accountRef, cursor, limit})` 返回 `items`、`nextCursor`、`hasMore`；`goo122` 宿主持久化批次后推进游标，重放依 dedupeKey 去重。
- `performAction({accountRef, action, input, idempotencyKey})` 返回 `actionId`、`state`（confirmed/pending/unknown）、`externalId?`、`evidenceRefs`。pending/unknown 不能当作已完成。
- `health` 区分 disconnected、connecting、ready、reauth_required、degraded、unavailable，附最后成功时间和脱敏原因。
- 连接器 manifest 包含 ID、版本、账号类型、能力列表、配置 Schema、认证方式、用户在场要求、同步策略和验证等级。`zemeng` 依此生成后台配置入口；特殊页面由 `zemeng` 持有。
- 业务记录带 source、accountRef、externalId、occurredAt、fetchedAt、contentRef、sensitivity、dedupeKey。预测/预报另带 validFor，不把获取时间当发布时间。

MOD-20 生成提醒规则，MOD-03 执行调度，MOD-23 决定汇总策略，`zemeng` 展示通知。四者各有唯一职责。

## 8. 错误、重试与副作用

| 错误码 | 消费者行为 |
| --- | --- |
| INVALID_ARGUMENT / PROTOCOL_MISMATCH | 修正输入或升级客户端，不自动重试 |
| UNAUTHORIZED / SCOPE_DENIED | 停止当前动作，显示授权状态，不自动扩大范围 |
| NOT_FOUND / UNSUPPORTED_CAPABILITY | 显示目标不存在/能力不支持，不伪造降级 |
| REVISION_CONFLICT | 读取新版本后重新计算变更，禁止覆盖 |
| RATE_LIMITED | 依 retryAfterMs、预算和 deadline 有界等待 |
| TIMEOUT / EXTERNAL_FAILURE | 根据是否发生副作用和幂等能力决定，不能仅看 retryable 重发写入 |
| RESULT_UNKNOWN | 核实外部状态，必要时等待用户处理 |
| CURSOR_EXPIRED | 读取快照或重新同步，再续订 |
| CANCELLED | 释放资源，保留已发生的结果 |

所有异步调用接受取消与 deadline；长任务不能依赖单个无限等待的 RPC。写入幂等键绑定账号、动作与规范化输入，同一键不同输入返回冲突；具体保留期由 `goo122` 的工具宿主声明，超出保留期不能声称仍防重。

## 9. 结果依据与数据安全

Evidence 记录：`evidenceId`、`kind`（observation/source/execution）、`sourceRef`、`capturedAt`、`summary`、`verification`（mock/verified/conditional）、`sensitivity`。没有依据时允许空列表，但回答必须明确未经验证。

外部内容不能成为系统授权；内部引用也校验访问范围。日志记录关联 ID 和脱敏摘要，不默认存原始邮件、音频、截图、密钥或模型隐藏推理。知识出机按目的模型与内容范围检查。

## 10. `goo122` 必须交付的联调包

1. JSON Schema、TypeScript 类型、版本与兼容性说明；`zemeng` 的 C# Host 按同一 JSON Schema 实现并用同一夹具验证。
2. 公共客户端与 fake Runtime，涵盖成功、失败、需要授权、取消、未知写入结果、事件重连六种固定场景。
3. fake ToolHost、存储、时钟和连接器响应，供 `zemeng` 和待认领协作者独立开发；fake 明显标记，生产构建不得静默启用。
4. 桌面消费者示例和连接器提供者示例；命令必须实际运行后写入 README。
5. 一次 `goo122`→`zemeng` 消息往返和取消验证；第三位协作者参与时验证同版本连接器注册。记录提交号与证据，不把文档存在称为 SDK 可用。

## 11. 最小消息示例

标识符为示例占位值，不作为生产生成规则。日期表示示例请求的有限 deadline。

```json
{
  "kind": "request",
  "protocolVersion": "1.0.0",
  "requestId": "example-request-1",
  "operation": "task.submit",
  "deadline": "2026-09-05T12:01:00Z",
  "idempotencyKey": "example-submit-1",
  "payload": {
    "goal": "在已授权笔记中查找项目计划",
    "conversationId": "example-conversation-1"
  }
}
```

```json
{
  "kind": "response",
  "protocolVersion": "1.0.0",
  "requestId": "example-request-1",
  "outcome": "ok",
  "data": { "taskId": "example-task-1", "state": "created", "revision": 1 },
  "evidenceRefs": []
}
```

此响应仅表示任务已创建；`zemeng` 等待真实终态事件或快照后才显示完成。
