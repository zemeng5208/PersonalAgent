# MOD-14-15-WAKE-BINDING-01：语音与唤醒可信宿主组合

- Profile：`huawei_ict_agentarts`；模块负责人/实现身份：`zemeng` / `zemeng5208`。
- 用户是产品负责人和最终范围、授权来源；来源主任务统一指挥；`goo122` 负责非作者评审与共享根协调。
- 工作树：`.worktrees/zemeng-voice-wake-composition`；分支：`codex/zemeng/voice-wake-composition`。
- 状态：`in_progress` / provisional；本工作包未提交、未推送、未合并。

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
还必须通过 binding epoch 和当前 wake 生命周期双重校验，不能在终态后存活。

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
