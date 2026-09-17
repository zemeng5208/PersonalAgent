# MOD-14-VOICE-PCM-BUFFER-01：有界 PCM 分块累积

- Profile：`huawei_ict_agentarts`；实现身份：`zemeng` / `zemeng5208`。
- 用户是产品负责人和最终授权来源；来源主任务统一指挥；`goo122` 协调共享根与非作者评审。
- 工作树：`.worktrees/zemeng-voice-pcm-buffer`；分支：`codex/zemeng/voice-pcm-buffer`。
- 基线：PR #75 提交 `b322d019`；状态：`review` / provisional，本地提交后交主控整合，不独立推送。

## 范围与职责

本工作包只持有外部显式 push-to-talk 采集器交付的短期 PCM 字节，直到可信宿主一次性
取出 `VoiceAudioClip`。它不打开麦克风、文件或网络，不选择 ASR/TTS，不读取凭据，不写
音频日志，不创建语音会话或 Runtime 状态机，也不调用 `task.submit` / `task.cancel`。

公开同步 API：

```ts
interface VoicePcmBufferOptions {
  readonly signal: AbortSignal;
  readonly deadline: string;
  readonly maxDurationMs?: number;
}
interface VoicePcmBuffer {
  append(chunk: Uint8Array): void;
  finish(): VoiceAudioClip;
  dispose(): void;
}
function createVoicePcmBuffer(options: VoicePcmBufferOptions): VoicePcmBuffer;
```

格式固定为现有 `pcm_s16le` / 16 kHz / 单声道；调用方不能另传 format。每个 chunk 必须
非空且为完整 16-bit frame，append 立即复制进首次写入时分配的单个连续缓冲区，避免极小
分块造成不受字节上限约束的对象开销。chunk 长度通过 TypedArray 内建 getter 读取一次，
恶意 own getter / Proxy 不能泄露异常正文或改变已保存内容。累计字节同时受
`MAX_AUDIO_BYTES` 和可选 `maxDurationMs * 32` 约束，超限固定拒绝且不截断。finish 返回
独立合并副本，duration 为 `ceil(bytes / 32)`，随后覆零并释放内部缓冲区。

finish/dispose 后的 append、重复 finish 和空 finish 固定返回 `INVALID_STATE`；dispose 幂等。
父 signal 和严格 ISO deadline 在创建、append、finish 与闲置期间都生效，取消或超时立即
覆零内部音频，后续固定返回 `CANCELLED` / `TIMEOUT`。所有终态都清理 deadline timer 和
abort listener；用户取消只影响本地缓冲区。

## 验证边界

定向测试覆盖四组：分块合并与调用方修改隔离；frame、时长和全局字节上限且不截断；
取消/deadline 对闲置缓冲区的释放与固定错误；finish/dispose 生命周期和后续拒绝。
验证不包含麦克风、WAVE 解析、System.Speech、供应商、文件、云端、Desktop 或 Runtime。

- voice TypeScript `--noEmit`：通过。
- voice 独立 build：通过。
- `node --test --test-isolation=none packages/voice/test/pcm-buffer.test.mjs`：4/4 通过。
