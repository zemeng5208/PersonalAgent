# MOD-14 VOICE-SESSION-01：语音会话最小生命周期

> 维护入口（2026-10-07）：项目主要负责人为 zemeng；当前分工以 [模块分工](../../docs/MODULE_ASSIGNMENTS.md) 为准，最新状态见 [ROADMAP](../../docs/ROADMAP.md)。历史日期、作者和验收结论按原记录保留。

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

2026-09-24 对齐当前 main 后，定向 TypeScript typecheck/build 通过，
`concurrent-start.test.mjs` 与 `voice-session.test.mjs` 共 14/14 通过，架构依赖检查
1/1 通过。并发替换清理、订阅重入和 operation 单次释放修复保留。当前工作树未安装
`node_modules`，TypeScript 使用主工作树已安装的同版本编译器与 Node 类型运行；
本机 Node/npm 为 26.3.0/11.16.0，正式版本门禁以 CI 为准。

本记录的证据仅为 `mock`。真实麦克风采集、回声/VAD、真实 ASR/TTS、Windows 音频设备、
播报打断实机体验、数据出机同意、供应商费用/限流、Desktop 状态显示和公共 wire 接线
均未验收，因此 PA-007 与 MOD-14 整体不能标记 done。

## 根接线状态与剩余交接

1. 根 `package.json` 已在 client 后加入 `@personal-agent/voice`；唯一根
   `package-lock.json` 已离线刷新，仅增加 voice workspace 和 node_modules link。
   与当前 main 合并时保留了 main 的 Runtime deadline 测试和接口目录；共享根差异仅为
   voice 工作区构建顺序与 lock 登记，待 `goo122` 非作者复核。
2. 由受信 Desktop/Runtime composition 注入真实或显式 Unavailable 适配器；Renderer 不得
   持有凭据、直接上传音频或直接导入本包私有实现。
3. 若要公布 `voice.start` / `voice.stop`，先由公共协议负责人协调 wire 语义、音频
   Artifact/分片/背压和消费黑盒测试；现有 `voice.stop` 的 capture/playback 结果不能被
   私自解释为“只停止播报”。
4. 未来 Runtime adapter 只能把 `consumeTranscript` 映射成显式 `task.submit`；
   `stopSpeaking` 不得接线到 `task.cancel`。真实任务取消仍使用现有公共取消 API。
5. Desktop 尚未接线，真实麦克风验收尚未执行；在完成可见设备状态、真实 ASR/TTS、
   打断与数据边界读回前，接口目录继续保持语音能力 `unavailable`。

## 2026-09-30：首版 Live 宿主与共享历史修复

本节是后续 Desktop 消费增量，不改写上述历史 package 验收。当前根主控委派
MOD-14 对话维护 `apps/desktop/electron/live-voice-host.js`；P8 已在
`b34af799d27a2f4cc0d108d5c6dbc831f53edfce` 明确无在途编辑并交接。
实现基线为 main `803089919171d655b7a76c2df51cd2c297bf1d6f`，
profile 仍为 `huawei_ict_agentarts`。不修改原 voice package 或实时 provider，
不修改公共 wire、根 manifest/lock、SIS/Live 加密配置或 Runtime 的任务状态。

增量行为：

- `live-voice-history.js` 是原 `Conversations` 的进程内覆盖层，不建新任务库。
  磁盘写入失败不停止音频；失败消息保留到下次转写或开启 Live 时回补。
  UI 最近 20 条限制不会丢弃尚未保存的消息；同身份修订保留原创建时间，
  重放按消息 ID 去重，不按相同文字删除不同轮次。
- 初始和续接 Live 都合并文字任务与语音上下文，仅 `succeeded` 才作为成功回答；
  历史标为参考数据，宿主不会因恢复重发历史工作。
- 每个 `request_work` 独立绑定受理的 taskId。同 callId/同 goal 共享一次结果，
  换输入拒绝；并发失败只读本次 task，unknown/等待状态不宣称完成。
  consumer 工厂失败不再卡住会话。停止 Live 仍不调用 `task.cancel`。
- 停止期间等待在途连接完成释放，再允许新会话；连接关闭只调用一次。
  同步设备释放异常也继续清理其他资源，释放不明时禁止重开。

P8 消费合同：

1. 原宿主 API 保留，新增 `historyMessages()` 返回
   `{id,sessionId,role,text,createdAt}[]` 的独立副本，包含未保存覆盖层。
2. `readContext` 的持久语音消息必须保留 `id`，避免与覆盖层重复。
3. 文字上下文将 `historyMessages()` 与原 `Conversations.history` 按 ID 合并、
   按任务创建时刻截断；不把尚未保存的语音排除在文字后续轮次之外。
4. `onTaskSubmitted` 先保留受理 task 的内存 goal 关联，再保存 Desktop 元数据。
   元数据失败不能改写 Runtime 的受理状态。

验证：`node --test apps/desktop/test/live-voice-host.test.mjs
apps/desktop/test/live-voice-history.test.mjs` 共 18/18 通过；`git diff --check`
通过。覆盖多轮/续接/显式停止、失败回补与修订、并发 task 状态隔离、同 callId
幂等、consumer 工厂异常、在途连接关闭、同步释放失败及旧回调隔离。
独立合成夹具还实际读回原 `Conversations` JSON 文件：失败回补后的 user/assistant
与既有文字 task 共用该文件，修订同 ID 后重启读取不重复；未写入用户真实历史文件。
此证据为离线显式 Fake，仅证明宿主消费者行为；P8 的主进程/文字上下文消费、
真实千问双向音频与工具桥、物理麦克风/扬声器仍需在最终组合中分别验收。
磁盘持续不可写时，覆盖层不具备跨进程耐久性，不能宣称重启后仍保留未落盘消息。
当前增量为 `review` / `provisional`，不据此将 PA-007 或 MOD-14 整体标记 done。

## 2026-10-07：原面板与浏览器音频生命周期读回

本节是现有 PR #302 的独立消费证据，尚未合入 `main@4b5ec61`，保留前述历史结论。
使用原 panel HTML、Renderer、bootstrap、CSS/CSP 和 Chromium 原生 WebAudio；
IPC、Gateway 与桌面快照为显式 Fake；Live 采集回执为 Fake，PCM/WAV 为本地合成静音。
下述采集链使用浏览器明确的 Fake 设备，MediaStreamTrack/AudioWorklet API 实际运行。
没有调用真实 SIS、Live 或 AgentArts API，没有物理麦克风或扬声器验收。

- Live 正常链固定 head `70b506e8239f78b2376d27931fb764aaf869293c`：公开 Host 经原
  面板按钮收到 ready，原生 AudioContext 为 running/24 kHz；PCM 播放结束后原
  Renderer 发 drained，Host 恢复 listening。停止读回 context closed/stopped 后
  Host inactive；再次启动建立独立新 context，旧 context 保持 closed。ready/stopped
  各两次、drained 一次，Gateway close 与 Fake 麦克风授权/撤销各两次，console/pageerror 为零。
- 同一固定版本的故障链显式让 `context.close()` 拒绝：原 Renderer 报 error，Host
  经过原五秒确认期限保留释放未确认、active/hasActive 和错误原因。公开麦克风 Host
  的 Fake track 回执已 verified，而真实浏览器输出 context 仍 running；原面板手动
  录音与 Wake 禁用，重复 Live 点击没有新 context、Gateway 或麦克风授权。该结果
  证明两种资源读回必须分别核实，不能用采集回执推断输出已释放。
- SIS 播放固定 head `1a115444635d978191584f88f6e45efa86b1be14`：公开播放 Host 经原
  Renderer 对 50 ms WAV 实际 decode/resume/start/onended 后收到 completed，原生
  context 为 closed/44.1 kHz，Renderer 音频副本清零。第二个一秒 WAV 在 started 后
  并发停止，单一 stopped 回执、结果拒绝为已停止；两个 context 均 closed，音频副本
  清零，completed/stopped 各一次，error/release_failed 和 console/pageerror 为零。
- 采集链固定 head `5d68903956bd5614b9338fe2deae6318e877c4f3`：真实 localhost HTTP
  原页面和 MIME、原 CSP，经明确的浏览器 Fake media device/permission 开关，运行原
  AudioWorklet 与公开麦克风 Host/PCM source。两个逻辑订阅共享一个 native stream，
  均收到 16 kHz/3200 bytes 帧；释放首订阅后 track 仍 live，最后释放后实际读回
  track ended/context closed，Host verified。重开建立新代，旧代维持关闭，最终两代
  均 ended/closed，ready/stopped 各两次、console/pageerror 为零。最初虚拟 HTTP
  路由无法供 Worklet 独立加载的 AbortError 与生产清理读回保留；改用合法本地 HTTP
  后通过，没有放宽 CSP、禁用浏览器安全或修改生产源码。

私有诊断记录在 `.worktrees/mod15-host-20261007/.cache/review-evidence/20261007/`：
`live-native-webaudio-validation.md`、`live-native-webaudio-close-fault-validation.md`、
`sis-native-webaudio-validation.md`、`microphone-native-worklet-validation.md` 及相应
脚本、JSON、日志（包括首个 Worklet 宿主失败）。没有新增正式测试或重复
既有 Fake AudioContext 绿色套件。这些结果只核实真实浏览器 API 与公开 Host/原面板的
消费；Electron/Windows、实际 ASR/TTS、设备误触/回声、账号 API 和任务结果仍分别待现场验收。
