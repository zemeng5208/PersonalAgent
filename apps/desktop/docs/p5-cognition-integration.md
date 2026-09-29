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

### 链路二：脱敏邮件分流分析 (`MailTriagePipeline`)
- **`p5.triageMails(messages, options)`**: 批量分流脱敏邮件，自动更新文件级持久化断点；

### 链路三：设备系统指标主动提醒 (`DeviceAnomalyDecisionService`)
- **`p5.evaluateDeviceSample(sample, layaRequest)`**: 连续采样与迟滞过滤，经 Laya 决策后触发可逆安全建议卡片。

---

## 4. P8 生产总装挂载规范（供 Luna 串行集成参考）

在 P8 串行集成时，`apps/desktop/electron/main.js` 按主进程标准架构挂载 P5：

### 4.1 模块导入（`main.js` 头部）
```javascript
import { createCognitionP5Composition } from './cognition-p5-composition.js';
```

### 4.2 模块初始化与生命周期启动（在 `initializeProductServices` 或服务装配段落）
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

### 4.3 统一 IPC 分发（挂载在 `main.js` 的 `async function action(event, name, payload)` 中）
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

### 4.4 应用退出释放（在 `app.on('before-quit')` 或清理段落）
```javascript
  // 彻底释放 P5 主动认知事件监听、取消订阅并中止在途控制器
  p5Cognition?.dispose();
```
