# P5 真实 Laya、目标与主动认知：桌面端装配与 P8 集成规格说明

- **模块 ID**: P5 (`@personal-agent/cognition` & `apps/desktop/electron/cognition-p5-composition.js`)
- **负责人**: `zemeng` (Gemini 代理开发与验收)
- **目标 Profile**: `huawei_ict_agentarts`
- **对应 PR**: #215
- **关联 Issue**: #212

---

## 1. P5 专属桌面适配入口与端口注入契约

为严格遵守协作规范、杜绝并发修改共享文件，P5 所有的端侧装配均内聚在专属文件：
**`apps/desktop/electron/cognition-p5-composition.js`**

### 1.1 构造参数与真实依赖契约

```javascript
import { createCognitionP5Composition } from './cognition-p5-composition.js';

const p5 = createCognitionP5Composition({
  application,          // RuntimeApplication 实例（必须提供 application.runtime.bindCoordinationStore）
  userData,             // 宿主 userData 目录绝对路径（用于收据与 checkpoint 持久化）
  namespace: 'default', // 目标协作图谱 namespace（默认 'default'）

  // 本地模型宿主（直接传入 createLocalLayaHost 返回的单例）
  // P5 仅消费公开方法 layaHost.choose(req) 与 layaHost.classify(req)
  // 严禁读取私有闭包属性，不暴露认证 API Key，杜绝启动第二个模型进程
  layaHost,

  // 受信 Policy 评估端口（必须由 Runtime/PolicyGateway 等正式策略提供者注入）
  // 缺省/未就绪时传 undefined，协调器将安全降级为结构化提案模式（status: 'proposal'），绝不修改图谱。
  // 严禁在生产中使用 risk === 'low' 盲目自动放行的伪策略。
  policyEvaluator: runtimePolicyService ? {
    evaluateExecution: async ({ eventId, source, inputs, risk }) => {
      return runtimePolicyService.evaluate({ eventId, source, inputs, risk });
    },
  } : undefined,

  // 确认投递通知端口（必须由系统通知服务/托盘宿主提供确认回执）
  // 仅在真实通知已送达用户时返回 { delivered: true }；投递失败或窗口未就绪时返回 { delivered: false }。
  // 缺省时传 undefined，P5 将标记 notificationDelivered: false 且不锁定冷却窗口，避免吞掉后续告警。
  // 严禁使用 webContents.send 无条件返回 { delivered: true } 制造虚假送达。
  notificationPort: desktopNotificationHost ? {
    sendAdvisoryNotification: async (notif) => {
      const delivered = await desktopNotificationHost.post(notif);
      return { delivered: Boolean(delivered) };
    },
  } : undefined,

  autoStart: true,      // 构造后是否立即进入 running 状态（默认 true）
  now: Date.now,
  onUpdate: () => {
    // 图谱变更、状态切换或提案刷新回调（可绑定主进程 publish()）
  },
});
```

---

## 2. 生命周期与事件源消费模型

### 2.1 生命周期状态机 (`state`)

P5 实现了严谨的四态生命周期：`idle` ➔ `running` ➔ `stopped` ➔ `disposed`。

```
              ┌───────────────────────────┐
              │          idle             │
              └─────────────┬─────────────┘
                            │ start()
                            ▼
              ┌───────────────────────────┐
       ┌─────►│         running           ├─────┐
       │      └─────────────┬─────────────┘     │
start()│                    │ stop()            │ dispose()
       │      ┌─────────────▼─────────────┐     │
       └──────┤         stopped           │     │
              └─────────────┬─────────────┘     │
                            │ dispose()         │
                            ▼                   ▼
              ┌───────────────────────────────────┐
              │         disposed (不可逆终态)     │
              └───────────────────────────────────┘
```

1. **`snapshot()`**:
   返回当前快照，包含 `{ state, ready, activeSubscriptionCount, hasMeetingCoordinator, hasMailPipeline, hasDeviceAnomalyService, hasExecutionPort, hasPolicyEvaluator, hasNotificationPort, layaHostState, namespace }`。
2. **`await p5.start()`**:
   将状态迁移为 `running`，恢复所有事件源的主动消费；若底层 `layaHost` 处于 `stopped` 状态，将联动触发 `layaHost.start()`。
3. **`await p5.stop()`**:
   将状态迁移为 `stopped`，中止在途 AbortController；所有绑定事件源发来的新事件将被安全丢弃（停止后不再消费），直接调用业务方法时明确拒绝。
4. **`p5.dispose()`**（**非空彻底释放**）：
   - 遍历并执行所有活动事件订阅的 `unsubscribe`；
   - 中止在途 AbortController 并清空引用集合；
   - 将状态迁移为不可逆终态 `disposed`，后续任何业务调用或重启均明确拒绝。

### 2.2 事件源订阅与消费（复用现有事件源，禁止另建调度器）

P5 提供标准事件源适配入口，统一兼容 `subscribe()`、`on()`、`addListener()` 接口：

1. **日历改期事件绑定**：
   ```javascript
   // calendarSource 需提供 'reschedule' 事件或 subscribe 接口
   const sub = p5.bindCalendarSource(calendarSource);
   // 单独取消订阅：
   sub.unsubscribe();
   ```
2. **邮件批量分流绑定**：
   ```javascript
   // mailSource 需提供 'batch' 事件或 subscribe 接口
   const sub = p5.bindMailSource(mailSource);
   sub.unsubscribe();
   ```
3. **系统指标采样绑定**：
   ```javascript
   // telemetrySource 需提供 'sample' 事件或 subscribe 接口
   const sub = p5.bindDeviceTelemetrySource(telemetrySource);
   sub.unsubscribe();
   ```

> **缺口说明**：若应用启动时日历/邮件业务连接器尚未建立或尚未连接账号，P5 允许在连接器就绪后再动态调用 `bindCalendarSource` / `bindMailSource`，未绑定的事件源不影响已有功能。

---

## 3. 业务链路执行与读回 API

### 链路一：会议改期纵向闭环 (`MeetingRescheduleCoordinator`)
- **`p5.processMeetingEvent(event)`**: 消费日历改期事件，结合真实 Laya 进行拓扑评估与 CAS 提交；
- **`p5.getPendingProposals()`**: 查询待用户审批或待复核的提案；
- **`p5.applyMeetingProposal(query, options)`**: 用户确认后，正式执行入图并更新收据；
- **`p5.getMeetingReceipt(eventId, source)`**: 读回持久化收据；
- **`p5.listMeetingReceipts(filter)`**: 按状态过滤收据列表。

### 链路二：脱敏邮件分流分析与大批量可恢复消费 (`MailTriagePipeline`)
- **策略版本**: `MAIL_TRIAGE_STRATEGY_VERSION = 'mail-triage-strategy-v2'`
- **阈值基线**: 默认 `minimumAnswerProbability: 0.70`, `minimumMargin: 0.15`，严禁未经校准全局放宽到 0.50；
- **6 大正交类别**: `meeting`, `work`, `subscription`, `transaction`, `personal`, `other`；
- **空白邮件推理前过滤**: 全空批次立即返回 `insufficient_input`，绝不调用本地模型；混合批次仅将非空邮件送入模型；
- **多维度指纹绑定**: 缓存键绑定 `strategyVersion`、`model`、`minimumAnswerProbability`、`minimumMargin` 与排序后的 `labels`，策略或阈值变更自动隔离失效历史判定，复用现有检查点文件；
- **中断恢复与瞬态隔离**: 仅将确定性分类结果记入持久化断点，超时、取消与不可用状态不落盘，保证断点重启仅处理未完成记录；
- **执行方法**:
  - `p5.triageMails(messages, { deadline, signal, onProgress })`: 批量分流脱敏邮件，自动更新文件级持久化断点；
  - `p5.triagePagedMails({ fetchPage, initialCursor, maxPages, deadline, signal, onProgress, onPageCompleted })`: 流式分页背压消费，单页处理完成并落盘后再拉取下一页。

> **核心语义约束**：
> 1. **`meeting` 标签语义**：仅代表该邮件被识别为具有潜在日程影响，路由至 `main_agent` 作为 `high_impact` 待检项；**绝不代表已确认会议改期，更不构成入图或日历修改授权**。
> 2. **吞吐量与性能说明**：实测 5 封邮件纯本地 Laya CPU 推理耗时 15.016 秒（约 0.33 封/秒），仅据实报告该样本实测数据。严禁线性推算为已验证的大规模千封吞吐，生产路径依赖批推理与持久化断点避免重复计费与模型浪费。

---

### 链路三：设备系统指标主动提醒 (`DeviceAnomalyDecisionService`)
- **`p5.evaluateDeviceSample(sample, layaRequest)`**: 连续采样与迟滞过滤，经 Laya 决策后触发可逆安全建议卡片。

---

## 4. 向邮件连接器（@Potatos498）提出的精确分页消费接口契约

为了实现数千封邮件的高效、受控分流，P5 提供分页背压消费适配器，现向 `@Potatos498` 明确提出邮件提供商侧的精确分页端口规格：

```typescript
export interface MailPagedSourcePort {
  /**
   * 按游标分页拉取指定文件夹邮件列表
   * @param input.folder 文件夹路径（默认 'INBOX'）
   * @param input.cursor 游标对象（uidValidity 与 lastUid）；首次拉取传 undefined
   * @param input.limit 单页最大条数（建议 20~50 条，由连接器受控提供）
   * @param input.signal 中止信号；收到 abort 时连接器需立即中断网络请求并释放连接
   */
  fetchPage(input: {
    folder: string;
    cursor?: { uidValidity: number; lastUid: number } | undefined;
    limit: number;
    signal: AbortSignal;
  }): Promise<{
    messages: readonly {
      uid: number;
      folder: string;
      uidValidity: number;
      messageId?: string;
      from: string;
      to: string;
      subject: string;
      sentAt: string | null;
      snippet?: string;
    }[];
    uidValidity: number;
    nextCursor: { uidValidity: number; lastUid: number };
    hasMore: boolean;
  }>;
}
```

### 4.1 投影至 P5 `LayaTriageMessage` 契约
连接器或宿主在将邮件送入 P5 分流时，需执行如下安全脱敏投影（严禁传入正文全文或私人凭据）：
- `source`: `'mail:' + folder`（例如 `'mail:INBOX'`）；
- `messageId`: `msg.messageId || String(msg.uid)`；
- `sourceRevision`: `${msg.uidValidity}:${msg.uid}`；
- `text`: 规范化信头摘要（如 `发件人: ${msg.from}\n主题: ${msg.subject}\n摘要: ${msg.snippet ?? ''}`，限制 4000 字符内）；
- `highImpact`: 若邮件带有明确日历邀约 ICS 附件标记，可预置 `true`。

### 4.2 异常与游标失效契约
- **`CURSOR_EXPIRED`**: 若邮箱重建导致 `uidValidity` 发生变化，连接器应抛出 `ProtocolError('CURSOR_EXPIRED')`，P5 将重置游标并依策略重新对齐；
- **`CANCELLED`**: 传入的 `signal.aborted` 触发时，连接器立即终止 IMAP 连接并返回，不得抛出未捕获异常。

---

## 5. P8 生产总装挂载规范（供 Luna 串行集成参考）

在 P8 串行集成时，`apps/desktop/electron/main.js` 按主进程标准架构挂载 P5：

### 5.1 模块导入（`main.js` 头部）
```javascript
import { createCognitionP5Composition } from './cognition-p5-composition.js';
```

### 5.2 模块初始化与生命周期启动（在 `initializeProductServices` 或服务装配段落）
```javascript
// === P5 Cognition Composition ===
let p5Cognition;
if (localLaya && runtimeApplication) {
  p5Cognition = createCognitionP5Composition({
    application: runtimeApplication,
    userData: app.getPath('userData'),
    namespace: 'default',
    layaHost: localLaya,
    // 如 Runtime 尚未提供正式 Policy 评估端口，传入 undefined 保持 proposal 安全降级
    policyEvaluator: undefined,
    // 如尚未接入确认送达通知端口，传入 undefined 避免虚假送达并保持冷却解锁
    notificationPort: undefined,
    autoStart: false, // 显式受控启动
    onUpdate: publish,
  });

  // 显式启动 P5 认知生命周期
  await p5Cognition.start();
}
```

### 5.3 统一 IPC 分发（挂载在 `main.js` 的 `async function action(event, name, payload)` 中）
PersonalAgent 桌面端统一经由 `desktop:action` 派发。在 `action` 函数内增加如下受校验的分支：

```javascript
  // --- P5 主动决策与提案操作 ---
  if (name === 'cognition.proposals.list') {
    return p5Cognition?.getPendingProposals() ?? [];
  }

  if (name === 'cognition.proposals.apply') {
    if (!p5Cognition) throw Error('认知服务尚未就绪');
    if (!payload || typeof payload.eventId !== 'string' || !payload.eventId.trim()
      || typeof payload.source !== 'string' || !payload.source.trim()) {
      throw Error('提案采纳请求缺少有效的 eventId 或 source');
    }
    return p5Cognition.applyMeetingProposal({
      eventId: payload.eventId.trim(),
      source: payload.source.trim(),
      namespace: typeof payload.namespace === 'string' ? payload.namespace.trim() : undefined,
    });
  }

  if (name === 'cognition.receipts.list') {
    const filter = (payload && typeof payload === 'object') ? {
      status: typeof payload.status === 'string' ? payload.status : undefined,
      source: typeof payload.source === 'string' ? payload.source : undefined,
    } : undefined;
    return p5Cognition?.listMeetingReceipts(filter) ?? [];
  }
```

### 5.4 应用退出释放（在 `app.on('before-quit')` 或清理段落）
```javascript
  // 彻底释放 P5 主动认知事件监听、取消订阅并中止在途控制器
  p5Cognition?.dispose();
```
