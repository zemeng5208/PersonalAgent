# MOD-14-15-WAKE-BINDING-01：语音与唤醒可信宿主组合

- Profile：`huawei_ict_agentarts`；模块负责人/实现身份：`zemeng` / `zemeng5208`。
- 用户是产品负责人和最终范围、授权来源；来源主任务统一指挥；`goo122` 负责非作者评审与共享根协调。
- 工作树：`.worktrees/zemeng-voice-wake-composition`；分支：`codex/zemeng/voice-wake-composition`。
- 状态：`review` / provisional；实现已提交在隔离分支，仅以 Draft PR 进入非作者评审，
  尚未合并或发布。

## 最小组合接口

`@personal-agent/voice` 导出：

```ts
interface VoiceWakeBindingOptions {
  readonly wake: WakeLifecycleController;
  readonly voice: VoiceSessionManager;
}

interface VoiceWakeBinding {
  handleWake(event: WakeDetectedEvent): void;
  dispose(): void;
}

function bindVoiceWake(options: VoiceWakeBindingOptions): VoiceWakeBinding;
```

MOD-15 的 `WakeLifecycleController` 构造接口保持不变。可信宿主显式把它的 `onWake`
回调接到 `binding.handleWake(event)`；绑定器本身不调用 `enable()`，不打开设备、不检查或
签发授权、不提交任务，也不接触音频、识别正文、凭据或 Runtime。

## 生命周期与隔离

绑定器订阅 `wake.subscribeLifecycle()` 和 `voice.subscribe()`。只有当前 wake 快照为
`listening` 且 number 型 `sessionId` 与事件一致时，才会创建一个父
`AbortController`，先按本地 epoch 登记，再异步调用：

```ts
voice.start({
  deadline: new Date(expiresAtMs).toISOString(),
  signal: parent.signal,
});
```

wake 的 number 型会话标识只用于关联，不能转换、复用或覆盖 voice 的 string 型标识。
有效 `expiresAtMs` 只转换为有限 ISO deadline，不延长授权。wake 退出 `listening`、切换
session、撤销、到期或设备失效时，绑定器中止对应 voice parent；异步 start 的迟到结果
还必须通过 binding epoch、当前 wake 生命周期及 `voice.current()` 同一非终态 session
校验，不能用过时 start 快照在终态或外部替换后继续占用绑定。

voice 快照中的 `playbackActive` 同步到 `wake.setPlaybackActive()`，让 MOD-15 在播报期间
抑制唤醒；绑定器不把该信号解释为 pause、revoke 或 `task.cancel`。`dispose()` 幂等，只
退订两个只读 feed、中止本绑定创建的 parent 并清除自身播放投影，不调用
`wake.dispose()`，也不销毁或接管调用方的 `VoiceSessionManager`。

## 范围与验证等级

- 实现范围：新建 `packages/voice/src/wake-binding.ts`，公开 index export，voice 对
  voice-wake 的 workspace 依赖，根 build/lock 的机械登记，组合测试及本文档。
- 不修改 MOD-15 公共实现，不新增 contracts/wire，不接 Runtime、Desktop、Renderer、
  麦克风、云端、AgentArts、真实 ASR/TTS 或唤醒算法。
- Fake 组合测试只证明授权 wake 单次启动、撤销/期限中止、播放抑制、异步 epoch 隔离和
  dispose 解绑；不证明真实设备、误触率、回声处理、数据出机授权或产品可用性。
- 两个基础包及本组合仍为 provisional/unavailable 边界；编译或 Fake 通过不提升冻结和
  生产状态，非作者评审、可信宿主接线与真实验收仍是后续门槛。

## 验证证据

- 定向执行 voice TypeScript `--noEmit` 与 build：通过。
- `node --test --test-isolation=none packages/voice/test/wake-binding.test.mjs`：6/6 通过，
  覆盖授权 wake 单次 start、number/string ID 隔离与 deadline 映射、撤销/期限、播放抑制、
  同步 disable 与迟到 start、start settle 前外部 stop、dispose 解绑和调用方对象所有权。
- 外部 stop 回归在修复前的旧绑定产物上为 5/6，第二次 wake 未启动；加入
  `voice.current()` 当前状态校验后为 6/6。该证据只证明本地确定性组合逻辑。
- 本轮按审查要求未重复运行全部 36 项基础包测试；MOD-14 的 PR #61 订阅重入修复和
  MOD-15 的 PR #65 生命周期提交均是本组合的明确前置，不能由本 Draft 替代各自评审。
- 本机 Node/npm 版本与仓库声明版本不同，正式工具链结果仍以 CI 为准；未执行真实音频、
  设备、云端、AgentArts、Desktop、Runtime、公共 wire 或 `task.submit` 验收。
