# P5 真实 Laya、目标与主动认知：桌面端装配与 P8 集成规格说明

- **模块 ID**: P5 (`@personal-agent/cognition` & `apps/desktop/electron/cognition-p5-composition.js`)
- **负责人**: `zemeng` (Gemini 代理开发与验收)
- **目标 Profile**: `huawei_ict_agentarts`
- **对应 PR**: #215
- **关联 Issue**: #212

---

## 1. P5 专属桌面适配入口与端口集成

为严格遵守协作规范、杜绝并发修改共享文件，P5 所有的端侧装配均内聚在专属文件：
**`apps/desktop/electron/cognition-p5-composition.js`**

### 1.1 构造参数与端口注入契约

```javascript
import { createCognitionP5Composition } from './cognition-p5-composition.js';

const p5 = createCognitionP5Composition({
  application,          // RuntimeApplication 实例（必须提供 application.runtime.bindCoordinationStore）
  userData,             // 宿主 userData 目录绝对路径（用于收据与 checkpoint 持久化）
  namespace: 'default', // 目标协作图谱 namespace（默认 'default'）

  // 本地模型宿主（直接传入 createLocalLayaHost 返回的单例）
  // P5 仅消费 public 方法 layaHost.choose(req) 与 layaHost.classify(req)
  // 严禁读取私有闭包属性，不暴露认证 API Key，杜绝启动第二个模型进程
  layaHost,

  // 受信 Policy 评估端口（必须由宿主正式配置；缺省时禁止自动执行，协调器降级为 proposal）
  policyEvaluator: {
    evaluateExecution: async ({ eventId, source, inputs, risk }) => ({
      allowed: true, // 仅在正式授权/白名单时允许，否则返回 allowed: false, reason: '...'
    }),
  },

  // 确认投递通知端口（必须连接真实通知宿主；缺省时不假宣告成功，不锁定冷却窗口）
  notificationPort: {
    sendAdvisoryNotification: async (notif) => {
      // 实际投递到桌面通知卡片或系统托盘
      return { delivered: true };
    },
  },

  autoStart: true,      // 是否在构造后立即就绪（默认 true）
  now: Date.now,
  onUpdate: () => {
    // 图谱变更、状态切换或提案刷新回调
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
              │         disposed (终态)           │
              └───────────────────────────────────┘
```

1. **`snapshot()`**:
   返回当前快照，包含 `{ state, ready, activeSubscriptionCount, hasMeetingCoordinator, hasMailPipeline, hasDeviceAnomalyService, hasExecutionPort, hasPolicyEvaluator, hasNotificationPort, layaHostState, namespace }`。
2. **`await p5.start()`**:
   若 `layaHost` 处于 `stopped` 状态，触发 `layaHost.start()` 启动底层模型；状态迁移为 `running`，恢复所有事件源的主动消费。
3. **`await p5.stop()`**:
   状态迁移为 `stopped`，中止正在进行的请求控制器；所有绑定事件源发来的新事件将被静默丢弃（不消费），直接调用业务方法时拒绝（抛出异常）。
4. **`p5.dispose()`**（**非空实现**）：
   - 彻底释放并取消所有绑定的事件源监听（调用所有注册的 `unsubscribe`）；
   - 清空活动订阅列表与 AbortController 集合；
   - 状态迁移为不可逆的 `disposed`，后续任何业务调用或重启均明确抛出异常。

### 2.2 事件源订阅与消费（复用现有事件源，禁止另建调度器）

P5 提供三个标准事件源适配入口，统一兼容 `subscribe()`、`on()`、`addListener()` 接口：

1. **日历改期事件绑定**：
   ```javascript
   // calendarSource 为 P1 日历连接器或事件发射器
   const sub = p5.bindCalendarSource(calendarSource);
   // 释放单个订阅：
   sub.unsubscribe();
   ```
2. **邮件批量分流绑定**：
   ```javascript
   // mailSource 发射 'batch' 或提供 subscribe
   const sub = p5.bindMailSource(mailSource);
   sub.unsubscribe();
   ```
3. **系统指标采样绑定**：
   ```javascript
   // telemetrySource 发射 'sample' 或提供 subscribe
   const sub = p5.bindDeviceTelemetrySource(telemetrySource);
   sub.unsubscribe();
   ```

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

## 4. P8 生产总装与 main.js 最小挂载补丁需求

在 P8 串行集成时，`Luna` 只需在 `apps/desktop/electron/main.js` 的对应生命周期节点插入以下确切代码块：

### 补丁 A：文件顶部导入（约 line 40）
```javascript
import { createCognitionP5Composition } from './cognition-p5-composition.js';
```

### 补丁 B：模块实例化与装配（在 localLaya 与 runtimeApplication 初始化完成后，约 line 770）
```javascript
// === P5 Cognition Composition (Priority 5 Integration) ===
let p5Cognition;
if (localLaya && runtimeApplication) {
  p5Cognition = createCognitionP5Composition({
    application: runtimeApplication,
    userData: app.getPath('userData'),
    namespace: 'default',
    layaHost: localLaya,
    policyEvaluator: {
      evaluateExecution: async ({ eventId, source, inputs, risk }) => {
        // 与主进程安全策略集成：高风险禁止自签，低风险受控放行
        return { allowed: risk === 'low', reason: risk === 'low' ? 'Low risk policy auto-approved' : 'High risk requires user review' };
      },
    },
    notificationPort: {
      sendAdvisoryNotification: async (notif) => {
        // 投递到主窗口或系统通知
        mainWindow?.webContents.send('notification.show', notif);
        return { delivered: true };
      },
    },
    onUpdate: () => {
      // 刷新前端主动决策与提案卡片
      publish();
    },
  });

  // 绑定事件源（如有已实例化的连接器）
  if (calendarConnector) {
    p5Cognition.bindCalendarSource(calendarConnector);
  }
  if (mailConnector) {
    p5Cognition.bindMailSource(mailConnector);
  }
}
```

### 补丁 C：IPC 接口挂载（在 IPC 注册段落，约 line 1250）
```javascript
  ipcMain.handle('cognition.proposals.list', async () => {
    return p5Cognition?.getPendingProposals() ?? [];
  });

  ipcMain.handle('cognition.proposals.apply', async (_, query) => {
    if (!p5Cognition) throw new Error('Cognition P5 composition not initialized');
    return p5Cognition.applyMeetingProposal(query);
  });

  ipcMain.handle('cognition.receipts.list', async (_, filter) => {
    return p5Cognition?.listMeetingReceipts(filter) ?? [];
  });
```

### 补丁 D：应用退出与资源释放（在 app.on('before-quit') 或 cleanup 段落，约 line 1680）
```javascript
  // 释放 P5 主动认知事件监听与订阅
  p5Cognition?.dispose();
```
