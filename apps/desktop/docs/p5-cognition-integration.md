# P5 真实 Laya、目标与主动认知：桌面端装配与 P8 集成规格说明

- **模块 ID**: P5 (`@personal-agent/cognition` & `apps/desktop/electron/cognition-p5-composition.js`)
- **负责人**: `zemeng` (Gemini 代理开发与验收)
- **目标 Profile**: `huawei_ict_agentarts`
- **对应 PR**: #215 (最新 Head: `2c9d3fc`)
- **关联 Issue**: #212

---

## 1. P5 专属桌面适配入口

为严格遵守协作规范、杜绝并发修改共享文件，P5 所有的端侧装配均内聚在专属文件：
**`apps/desktop/electron/cognition-p5-composition.js`**

### 构造与端口注入

```javascript
import { createCognitionP5Composition } from './cognition-p5-composition.js';

const p5 = createCognitionP5Composition({
  application,          // RuntimeApplication 实例（必须提供 application.runtime.bindCoordinationStore）
  client,               // Client 实例（用于任务提交与外部事件通讯）
  userData,             // 宿主 userData 目录绝对路径（用于收据与 checkpoint 持久化）
  namespace: 'default', // 目标协作图谱 namespace（默认 'default'）
  inference,            // LayaInferencePort（真实 LocalLayaHttpTransport 实例）
  
  // 受信 Policy 评估端口（必须由宿主正式配置；缺省时禁止自动执行，协调器降级为 proposal）
  policyEvaluator: {
    evaluateExecution: async ({ eventId, source, inputs, risk }) => ({
      allowed: true, // 仅在正式授权/白名单时允许，否则返回 allowed: false, reason: '...'
    }),
  },
  
  // 确认投递通知端口（必须连接真实通知宿主；缺省时不假宣告成功，不锁定冷却窗口）
  notificationPort: {
    sendAdvisoryNotification: async (notif) => {
      // 实际投递到桌面通知卡片或托盘
      return { delivered: true };
    },
  },
  
  now: Date.now,
  onUpdate: () => {
    // 图谱变更或提案状态刷新回调
  },
});
```

---

## 2. 纵向业务链路消费契约

### 链路一：会议改期纵向闭环 (Priority 1)

```
[外部日历变更] 
       │
       ▼
p5.processMeetingEvent(event)
       │
       ├─► 检查持久收据 (FileMeetingDecisionReceiptStore: (namespace, source, eventId))
       ├─► 崩溃窗口精确核对 (eventId + sourceRef + summary + sourceRevision)
       ├─► 内存拓扑推导 3 个真实候选方案 (adjust_schedule / defer_and_verify / escalate_conflict)
       ├─► 真实本地 Laya SLM 推理决策
       │
       ├──[已配置 Policy 且 Laya 决策高置信度 (adjust_schedule)]
       │        ▼
       │   CAS appendBatch 整批原子写入图谱 ──► status: 'applied' (记录持久收据)
       │
       └──[未配置 Policy / Policy 拒绝 / 模型返回 review (uncertain)]
                ▼
           status: 'proposal' 或 'requires_review' (记录持久收据，图谱保持原状)
                │
                ▼ 用户在 UI 看到“待决策提案”
                │
           p5.applyMeetingProposal({ eventId, source }) (用户手动批准执行)
                ▼
           CAS appendBatch 整批原子写入图谱 ──► status: 'applied'
```

#### 输入事件契约 (`MeetingRescheduleEvent`)
由 `@Potatos498` P1 日历连接器在检测到改期时发射：
```typescript
export interface MeetingRescheduleEvent {
  readonly eventId: string;               // 外部唯一事件 ID (如 cal-sync-20260929)
  readonly source: string;                // 来源 (如 calendar:work)
  readonly meetingFactId: string;         // 图谱中已有会议事实节点 ID
  readonly originalSummary: string;       // 原始摘要
  readonly newSummary: string;            // 变更后摘要 (包含新时间)
  readonly sourceRevision: string;        // 外部提供者版本 (etag/syncToken)
  readonly expectedBaseRevision?: string; // 可选：预期图谱已有版本 (防陈旧版本冲突)
  readonly detectedAt: string;            // ISO 时间戳
  readonly deadline: string;              // ISO 截止时间
  readonly signal: AbortSignal;           // 取消信号
}
```

#### 状态与恢复入口 API
- `p5.processMeetingEvent(event)`: 消费事件并返回决策回执；
- `p5.getPendingProposals()`: 返回所有待用户审批的提案及机器复核（`status === 'proposal' || status === 'requires_review'`）；
- `p5.applyMeetingProposal({ eventId, source }, options)`: 用户点击“采纳并执行”后，执行原子入图并更新回执为 `applied`；
- `p5.getMeetingReceipt(eventId, source)`: 按来源与事件 ID 读回持久收据；
- `p5.listMeetingReceipts(filter)`: 按状态或来源过滤收据列表。

---

### 链路二：脱敏邮件批量分流与时效分析

#### 输入契约
由 `@Potatos498` P1 邮件连接器在拉取邮件后提供脱敏信头投影：
```typescript
const summary = await p5.triageMails([
  {
    source: 'mail:work',
    messageId: 'msg-101',
    sourceRevision: 'v-etag',
    text: '发件人: 组织者\n主题: 会议推迟确认\n正文摘要: ...',
  },
], {
  deadline: new Date(Date.now() + 60_000).toISOString(),
  signal: abortController.signal,
});
```

#### 保证机制
- 自动持久化断点至 `${userData}/mail-triage-checkpoint.json`，缓存键绑定模型与标签指纹；
- 断点文件损坏或不可读时明确抛出异常，拒绝静默丢失进度；
- 吞吐率纯以实际推理耗时与实际推理消息数计算，严格剥离缓存命中；
- 输出高影响通知列表 `summary.highImpactNotices` 供主窗口展示。

---

### 链路三：设备系统指标主动提醒

#### 输入契约
消费 `@Luna` P6 提供的 Windows 系统遥测采样：
```typescript
const receipt = await p5.evaluateDeviceSample({
  source: 'node:os',
  timestamp: new Date().toISOString(),
  cpuPercent: 95,
  memoryPercent: 60,
  samplingIntervalMs: 5000,
});
```

#### 保证机制
- 连续 3 次采样超标才确认触发告警；
- 采样间隔跳跃（>2.5倍周期）自动重置未告警计数，迟滞区间（80%~90%）立即清空未告警计数，杜绝 95->85->95 误报；
- 候选仅限可逆安全建议卡片，绝对禁止杀进程或删文件；
- 仅在 `notificationPort.sendAdvisoryNotification` 返回 `{ delivered: true }` 时才锁定 300s 冷却，投递失败或未配置通知端口时保持冷却解锁以待重试。

---

## 3. P8 生产总装与集成规范

P8（全模块生产总装与端到端集成）由 `zemeng` 统筹。各模块在总装中的单向消费边界如下：

1. **共享文件占用约定**：
   - 共享 `apps/desktop/electron/main.js` 属于 P8 总装集成范围；
   - P5 保持独立的薄适配入口 `cognition-p5-composition.js`，总装时仅需一行导入并挂载：
     ```javascript
     import { createCognitionP5Composition } from './cognition-p5-composition.js';
     const p5Cognition = createCognitionP5Composition({ ... });
     ```
2. **IPC 桥接暴露（由 P8 在 main.js 中按需挂载）**：
   - `proactive.proposals.list`: 调用 `p5Cognition.getPendingProposals()`；
   - `proactive.proposals.apply`: 调用 `p5Cognition.applyMeetingProposal(query)`；
   - `proactive.mails.triage`: 调用 `p5Cognition.triageMails(messages)`；
3. **生命周期管理**：
   - 应用退出时调用 `p5Cognition.dispose()` 释放监听器与未完成句柄。
