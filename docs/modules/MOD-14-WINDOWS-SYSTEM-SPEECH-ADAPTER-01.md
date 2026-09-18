# MOD-14-WINDOWS-SYSTEM-SPEECH-ADAPTER-01：Windows 识别与播报适配器

- Profile：`huawei_ict_agentarts`；实现身份：`zemeng` / `zemeng5208`。
- 用户是产品负责人和最终授权来源；主任务统一指挥；`goo122` 协调共享根与非作者评审。
- 工作树：`.worktrees/zemeng-voice-recognition-adapter`；分支：`codex/zemeng/voice-recognition-adapter`。
- 基线：PCM buffer `e09f420`；状态：`review` / provisional，本地提交后交主控整合，不独立推送。

## 生产边界

`createWindowsSystemSpeechPorts()` 保持现有 `SpeechRecognitionPort` / `SpeechOutputPort`
不变，返回两个 provider-specific 适配器和一个幂等异步 `dispose()`。首版只接受既有
PCM S16LE / 16 kHz / 单声道、严格 `zh-CN`、有限 ISO deadline 和 AbortSignal；识别与
播报分别只在现有 manager 的显式 `recognizeAudio()` / `speakReply()` 路径启动。

固定 helper 是本工作包拥有的 `packages/voice/host/windows-system-speech.ps1`。生产入口只从
可信模块位置解析该脚本，并从受信 `SystemRoot` 解析 Windows PowerShell 5.1；调用方不能
传入 executable、script、命令、参数、设备或执行策略。每次 operation 启动一个隐藏子进程：

- recognition 只通过 stdin 接受最多 1,920,000 bytes 的 PCM，使用固定格式与 zh-CN
  `DictationGrammar`，stdout 只返回有界 text/locale JSON；
- output 只通过 stdin 接受最多 8,000 字符的 UTF-8 文本，选择已安装 zh-CN voice 并向
  默认音频设备播报，stdout 只返回完成 JSON；
- stderr 被有界读取后丢弃，不写日志；无音频文件、网络、凭据或自动重试；
- deadline、父取消、stop 和 dispose 请求终止精确子进程；结果失败与实际 close 分开，
  清理等待有界，未收到 close 不报告已释放；自有输入及已缓存输出在取消或终态覆零。

这新增了可信主进程调用固定子进程的 provisional 进程形态，但没有 Renderer shell、任意
命令入口、公共 wire 或第二套 session/Runtime 循环。兼容性要求为 Windows、Windows
PowerShell 5.1、`.NET Framework System.Speech`、已安装 zh-CN recognizer/voice，以及允许
执行随包固定脚本的生产策略。未来打包必须保留该脚本的固定相对位置并采用签名/正常策略；
不得沿用一次性 probe 授权或静默加 `-ExecutionPolicy Bypass`。

## 证据与限制

主控只在用户一次性明确授权后执行原固定内存 probe，结果为 zh-CN、43,680 PCM bytes、
合成后固定语法匹配、零麦克风/文件/云。该授权已耗尽；本工作包不重复 probe，也不运行
开放听写、真实播放或麦克风。

定向自动测试使用进程双替身，只验证正常识别/播报帧、输入快照、无重试、父取消与 stop
等待 close、畸形/超长响应、默认策略在 helper 启动前拒绝时的 unavailable 映射，以及固定
脱敏错误。原工作树已通过 voice TypeScript typecheck、build、3/3 定向测试和 31/31 voice
workspace 测试；这些历史测试都没有启动 PowerShell、System.Speech、麦克风、扬声器或网络。

上述结果不证明当前生产脚本可被执行；当前开发机的
默认 PowerShell 脚本策略仍可能阻止生产启动，因此 Desktop 必须继续显示 unavailable，
直到具体签名/打包或持续生产权限另行授权并完成真实设备验收。

## 2026-09-18 清理失败修复

- operation 的取消/超时结果立即失败，不能无限等在子进程 close 上；stop/dispose 单独
  等待资源释放。等待上限为 2,000 ms，这是错误收敛预算，不是 Windows 回收时限保证。
- kill 返回 false、抛错或迟迟无 close 时，不盲目重试 kill，不按名称/PID 另杀进程。
  预算耗尽后返回固定 `EXTERNAL_FAILURE`，保留精确子进程跟踪并将适配器隔离。
- 同一适配器最多一个尚未 close 的 helper；隔离后拒绝新调用。晚到输出被丢弃，真实
  close 仍执行本地清理，但不能反转既有取消/失败结果或自动解除隔离。
- dispose 重复调用共享同一结果，不将先前清理失败改报成功。不更改固定 launcher、
  执行策略、Desktop 默认 unavailable 或设备授权。
- 新增两组进程替身/虚拟时钟回归覆盖取消+kill false、deadline+kill throw、清理未确认、
  禁止新进程、重复 stop/dispose 及晚结果。实际检查结果以该修复头 CI/评审记录为准；
  本增量不包含真实进程、麦克风、播放或云验收。
