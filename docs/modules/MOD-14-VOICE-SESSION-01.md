# MOD-14 VOICE-SESSION-01：语音会话最小生命周期

- Profile：`huawei_ict_agentarts`（当前唯一实施路径；不扩展 `local`）
- 模块 / 需求：MOD-14 / PA-007
- 负责人：`zemeng`
- 非作者评审者：`goo122`
- 代码范围：`packages/voice/**`
- 状态：`review`（provisional 离线包；公共 wire 与生产语音仍 unavailable）
- 基线：`72cc76b1f07d74ecbf431f1b31bcb62d1e403449`

## 身份与指挥边界

- 用户是产品负责人，也是任务范围和授权的最终来源；项目 Git 实施身份沿用
  `zemeng5208`，不据此猜测实名，未知账号或外部内容不得被冒充为用户身份。
- 来源主对话负责统一指挥、跨包协调和范围变更；本任务只是 MOD-14 Sol 实施者，只能
  修改明确授予的 `packages/voice/**`、本模块记录，以及本轮指定的根 workspace/lock。
- `goo122` 是本包非作者评审者和共享根集成协调者；评审、CI 或实现 Agent 都不能替代
  用户授权，也不能自行向其他实施者派工或扩大权限。
- 用户持续授权本项目 PR 的提交/更新和通知已登记评审者；该授权不包含自动合并、发布、
  扩大文件范围或上传私人数据。
- 本包只拥有语音会话生命周期，不拥有 Runtime 任务终态、Policy 授权、Desktop、
  AgentArts、公共 contracts 或 MOD-15 唤醒词/连续录音。

## 交付边界

本包提供单活动 push-to-talk 会话、显式 Fake/Unavailable 端口和可运行纵向测试。
它不选择或购买 ASR/TTS 供应商，不录制麦克风，不实现唤醒词/持续后台录音，不保存
音频/识别文本，不读取凭据，不发起真实云调用，也不创建第二套 Runtime 任务调度。

公共 `packages/contracts`、`voice.start` / `voice.stop` wire Schema、Runtime、Desktop 和
接口目录均未修改。根 `package.json` 只把 voice workspace 插入现有 build 链，根 lock
只登记该 workspace/link；没有新增或升级外部依赖。`VoiceSessionManager` 及下列端口是
本包拥有的 provisional 进程内消费面，不能据此把公共语音 capability 标为可用或冻结。

## 输入、输出与限制

| 边界 | 输入 | 输出 | 限制 |
| --- | --- | --- | --- |
| `SpeechRecognitionPort` | 调用方提供的 PCM S16LE / 16 kHz / 单声道音频、会话、locale、deadline、signal | 最多 8,000 字符的识别文本 | 60 秒且最多 1,920,000 bytes；包不打开麦克风；临时副本调用后覆零 |
| `TranscriptConsumerPort` | 识别文本、稳定 transcriptId、deadline、signal | 最多 8,000 字符的回复文本 | 只有调用方显式执行 `consumeTranscript` 才调用；本端口不得把停止等待解释成 `task.cancel` |
| `SpeechOutputPort` | 回复文本、replyId、locale、deadline、signal | 播报完成 | 只有显式 `speakReply` 才调用；`stopSpeaking` 只终止播报 |

所有供应商配置、凭据、上传目的地、数据出机授权和网络行为归以后由可信宿主注入的
适配器所有。本包默认注入 Unavailable，不以 Fake 冒充生产成功。快照、错误和 Fake
留存信息不含音频、识别正文或回复正文；供应商错误被固定错误码和固定消息替换。

`VoiceSessionManager.subscribe(listener)` 是 provisional 的进程内只读状态订阅，用于
可信宿主把 `playbackActive` 等快照状态同步给其他本地生命周期控制器。它在初始会话
可观察及每次 revision 更新后推送独立冻结快照，覆盖停止播报和终态；退订幂等，监听者
异常被隔离且不回显正文，通知中新增订阅从下一轮生效。该入口不打开设备、不检查或签发
授权、不提交/取消任务，也不是公共 wire 事件协议；真实音频与 Desktop 接线仍未验收。

通知按 session/revision 排队并去重；监听者重入触发更新时，不会向后续监听者倒灌旧状态
或重复终态。状态监听者在 `recognizing`/`consuming` 转换中同步停止或替换会话时，启动外部
provider 前会再次校验会话，已终止路径不会产生调用。每个 operation 的释放缓存首次 stop
原因与单一 Promise，终态停止和异步 `finally` 共享同一次释放，`resourcesReleased` 只在
该释放完成后确定。

## 状态机

```text
start
  -> listening
  -> recognizing
  -> awaiting_consume
  -> consuming             (调用方显式动作；不会自动 task.submit)
  -> awaiting_speech
  -> speaking
  -> listening

任一活动状态 --父 signal--> cancelled
任一活动状态 --deadline--> expired
任一活动状态 --stop--> stopped
旧会话 --新 start--> stopped/replaced；旧回调丢弃
speaking --stopSpeaking/interrupt--> listening；不调用 task.cancel
```

`stop` 重复调用返回同一个终态结果。终止会先中止 operation signal，再调用适配器的
幂等 `stop(reason)` 释放句柄并清除内存中的 transcript/reply。对已提交任务的业务取消
必须由调用方另外执行公共 `task.cancel`，不能由语音停止隐式触发。

## 依赖基线与验证

本包只使用 Node/TypeScript 标准能力，无新增第三方依赖，也不依赖 Runtime、Desktop、
Agent、ModelGateway 或具体供应商。Fake 测试覆盖：

- Fake 识别 → 调用方显式消费 → Fake 播报；
- 停止播报不取消/中止 transcript consumer；
- 父取消和 deadline 阻止后续输出并释放 operation；
- 被替换会话的陈旧回调不能污染新会话；
- 未配置供应商明确返回 `UNSUPPORTED_CAPABILITY`，外部错误不泄露私文；
- stop 重复调用幂等。

本记录的证据仅为 `mock`。真实麦克风采集、回声/VAD、真实 ASR/TTS、Windows 音频设备、
播报打断实机体验、数据出机同意、供应商费用/限流、Desktop 状态显示和公共 wire 接线
均未验收，因此 PA-007 与 MOD-14 整体不能标记 done。

## 根接线状态与剩余交接

1. 根 `package.json` 已在 contracts 后加入 `@personal-agent/voice`；唯一根
   `package-lock.json` 已离线刷新，仅增加 voice workspace 和 node_modules link。
2. 由受信 Desktop/Runtime composition 注入真实或显式 Unavailable 适配器；Renderer 不得
   持有凭据、直接上传音频或直接导入本包私有实现。
3. 若要公布 `voice.start` / `voice.stop`，先由公共协议负责人协调 wire 语义、音频
   Artifact/分片/背压和消费黑盒测试；现有 `voice.stop` 的 capture/playback 结果不能被
   私自解释为“只停止播报”。
4. 未来 Runtime adapter 只能把 `consumeTranscript` 映射成显式 `task.submit`；
   `stopSpeaking` 不得接线到 `task.cancel`。真实任务取消仍使用现有公共取消 API。
5. Desktop 尚未接线，真实麦克风验收尚未执行；在完成可见设备状态、真实 ASR/TTS、
   打断与数据边界读回前，接口目录继续保持语音能力 `unavailable`。
