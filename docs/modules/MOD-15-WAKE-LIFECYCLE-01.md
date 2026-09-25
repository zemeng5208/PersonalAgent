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

## 中文唤醒的条件路径（2026-09-25，只读选型，未接入）

优先复用 MOD-14 的 Windows System.Speech 宿主，条件是目标机
`InstalledRecognizers()` 读回可用的 zh-CN 引擎，并在同一授权音频流上完成中文限定词表
识别、释放与误触/回声实测。微软提供限定 `Grammar`、连续
`RecognizeAsync(RecognizeMode.Multiple)` 和 `SetInputToAudioStream` API；当前 #124
宿主仅用 `DictationGrammar` 对完整片段调用 `Recognize()`，不能把它称为持续唤醒源。
API 依据：[已安装识别器](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.installedrecognizers?view=netframework-4.8.1)、
[异步识别](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.recognizeasync?view=netframework-4.8.1)。

若目标机没有可用 zh-CN 引擎，下一候选是 `sherpa-onnx-node` 与
`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`。官方提供 Windows x64/Node 包、中文英文
KWS 模型和从同一路 16 kHz 单声道 PCM 转为 `Float32Array` 后输入 KeywordSpotter 的示例；
本项目 Node 24/Windows 的实际二进制兼容、模型权重与词表再分发许可尚未验证。新增依赖
也须由根锁文件负责人处理，因此此候选尚未获准安装或发布。依据：
[安装说明](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html)、
[KWS 模型](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html)、
[Node 示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_keyword_spotter_transducer.js)。

两条路径均依赖 MOD-11/14 的**同一个**显式授权、有限期限的实时 PCM 帧源；当前 #122
只提供片段缓冲，#124 只提供整段识别/播报，尚无可供本包订阅的公开连续帧入口。
撤销、期限、设备失效和关闭时需停源并读回实际麦克风释放；本包的同步
`unsubscribe()` 只能证明已请求退订和旧事件失效，不能证明物理设备已关闭。
此项随 MOD-14 语音链集中实机验收，不单独重复跑整链。
