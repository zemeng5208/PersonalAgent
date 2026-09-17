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
- deadline、父取消、stop 和 dispose 终止精确子进程并等待 close；自有音频在终态覆零。

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
脱敏错误。本工作树已通过 voice TypeScript typecheck、build、3/3 定向测试和 31/31 voice
workspace 测试；这些测试都没有启动 PowerShell、System.Speech、麦克风、扬声器或网络。

上述结果不证明当前生产脚本可被执行；当前开发机的
默认 PowerShell 脚本策略仍可能阻止生产启动，因此 Desktop 必须继续显示 unavailable，
直到具体签名/打包或持续生产权限另行授权并完成真实设备验收。
