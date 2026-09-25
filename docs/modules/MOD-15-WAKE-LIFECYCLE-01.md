# MOD-15-WAKE-LIFECYCLE-01：唤醒会话生命周期离线首片

- Profile：`huawei_ict_agentarts`；模块负责人：`zemeng`；实现者：Luna（授权等待修复）与 zemeng（生命周期订阅）。
- 非作者评审：`goo122`；本次主对话由用户（产品负责人/授权源）授权，主代理负责总协调。
- 当前独立工作树：`e15c/PersonalAgent`；分支：`codex/zemeng/mod15-voice-wake-restoration`。代码恢复自旧 `codex/zemeng/voice-wake-lifecycle`，其 PR #65 因当时被 #61 吸收而关闭；#61 当前已收窄为 MOD-14，最终差异不再包含本包。
- 本次文件范围：`packages/voice-wake/**` 与本文件；根构建、锁文件及接口目录由主控协调，不修改 MOD-14、Runtime、contracts 或公共 wire。
- 状态：`in_progress` / provisional；离线实现不等于接口冻结或模块 done。

## 交付边界

本首片提供默认关闭的 `WakeLifecycleController`，消费两个注入端口：

1. 可信宿主 `WakeAuthorizationPort.check()` 返回允许、有限 `expiresAtMs` 和宿主持有的
   `revocationSignal`；控制器不能签发、延长或重新绑定授权。
2. `WakeSignalSource.subscribe()` 仅在显式 `enable({deadlineAtMs})` 且宿主允许后调用；调用方
   必须提供有限的绝对 deadline，授权检查和源订阅共享这个有效期上界。源收到固定的
   `wake`、`device_unavailable` 或 `error` 分类。控制器向调用方只发固定的
   `{kind, sessionId, occurredAtMs}`，不自动提交任务、不携带文本或音频。

`disable()`/`stop()`、授权撤销、期限、设备不可用和 `dispose()` 会立即取消订阅并递增
epoch；迟到的旧回调被丢弃，重复 stop/dispose 幂等。播放期间由调用方设置
`setPlaybackActive(true)` 抑制唤醒；`cooldownMs` 是显式配置的本地抑制窗口，不宣称
误触率或回声指标。期限和调用方 `AbortSignal` 同时贯穿授权检查与源订阅；宿主休眠后
若到期定时回调延迟，下一次 `enable()` 会先释放已过期的旧订阅或终止旧授权等待。

本地 MOD-14 组合可调用 `subscribeLifecycle(listener)`。它只投递冻结的
`{state, sessionId, expiresAtMs}`，首次订阅同步给出当前快照，后续稳定状态按值去重；返回
幂等退订函数。监听器错误隔离且只转成固定 `CALLBACK_FAILED`，不阻断其他监听器。源在
`subscribe()` 内同步失败时不会产生伪 `listening`，监听器重入触发终态时也不会向后续
监听器倒灌旧状态。该订阅不携带文本、音频、外部错误、授权对象或 Runtime 权限。

## 明确排除

- 不打开麦克风、不录音、不实现 ASR/唤醒算法、不访问云端。
- 不复制 MOD-14 的 `voice.start/stop`、播放/停止播报或 `task.cancel` 语义。
- 不自动获取授权、不自动 `task.submit`，不把 Fake 事件描述为识别成功。
- 本首片不包含 MOD-14 装配、真实硬件、真实误触/回声测试、供应商选择或发布接线。

`@personal-agent/voice-wake/testing` 的 Fake 时钟、授权和事件源只证明生命周期分支。
真实 VoicePort、录音设备、唤醒算法和宿主接线仍按接口目录保持 `unavailable`，须由后续
工作包和非作者评审分别验收。

## 验收入口

```text
npm.cmd run typecheck --workspace=@personal-agent/voice-wake
npm.cmd test --workspace=@personal-agent/voice-wake
```

本次恢复验证（2026-09-25）：使用主工作树已安装的 TypeScript 与 Node 类型，
对 `packages/voice-wake/tsconfig.json` 运行定向编译，通过；随后以
`node --test --test-isolation=none packages/voice-wake/test/voice-wake.test.mjs` 验证同一测试文件，
21/21 通过。当前工作树没有独立 `node_modules`，因此没有运行普通 workspace 脚本或 `npm ci`。

测试覆盖默认零订阅、显式启用单订阅、重复启用、撤销/过期/断设备/关闭/销毁、旧 epoch
迟到回调、休眠后到期回调延迟、播放/冷却抑制、deadline/cancel、非合作授权、固定错误脱敏，以及生命周期
初始/终态、冻结、去重、退订、异常隔离和同步源失败。测试不是实机误触、回声或 ASR
准确率证据；本次未运行真实音频、云服务、Electron 或 MOD-14 装配。当前主线的根
`build` 尚未加入本包，`package-lock.json` 也没有本 workspace 的登记；这两处须由共享根
文件负责人协调后再进行 CI 集成。恢复的包没有外部依赖。本机 Node 26.3/npm 11.16
与仓库要求的 Node 24.15/npm 11.12 不同，声明版本验证以 CI 为准。

本模块由 `zemeng` 负责并交由 `goo122` 进行非作者评审；本代理自测不能替代该批准。
MOD-14 旧组合 PR #70 曾提供只读 `subscribeLifecycle` / `VoiceSessionManager.subscribe`
绑定及播放状态抑制，但其代码已从当前 #61 净差异移出；当前包不包含生产音频源、
授权提供者或算法。供应商选择、实际麦克风释放、误触率、回声与打断仍需独立真实验收。
