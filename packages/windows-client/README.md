# Windows Client：只读系统观测首片

`@personal-agent/windows-client` 当前只提供 `createSystemObservationTool()`：一个通过现有
`RegisteredTool` / ToolGateway 边界调用的只读聚合观测工具。

它用两次 `node:os` CPU tick 采样计算系统整体利用率，同时返回逻辑处理器数量、内存总量/
空闲量、系统 uptime 和采集时间。`sampledFrom` / `sampledUntil` 为两次读取的墙钟边界，
`actualSampleWindowMs` 为单调时钟测得的读取区间（含 probe 开销）；
`requestedSampleWindowMs` 仅是请求的等待间隔。时钟被注入时这些字段只属于合成证据。
它不会读取或返回 hostname、用户名、进程、命令行、路径、
文件、网络地址或凭据，也不会提权、启动 PowerShell、接入或发布 TraceGuard。

`describeSystemObservationCapabilities()` 公开提供者支持的 CPU、内存和 uptime 字段，及未实现的
进程归因、磁盘 I/O、温度和网络活动；它不是生产握手或本次读取成功的保证。实际调用成功后，
这些未实现字段仍在结果中标记为 `unavailable`。采样失败返回脱敏 `EXTERNAL_FAILURE`，
取消返回 `CANCELLED`，deadline 过期返回 `TIMEOUT`；不会把缺失/失败值伪装成零。
这些聚合值只说明
观测到的资源压力，不能证明电脑变慢的原因。

工具需要最小 scope `computer:system:read`，输入必须是空对象；deadline 或取消会中止采样并
清理计时器，不自动重试。默认 probe 使用 `node:os`，测试通过注入的合成 probe 验证，不读取
开发机数据。使用注入 probe 时结果固定标记 `source=injected`，不构成真实本机观测证据；仅默认
适配器标记 `source=node:os`。

`register(host)` 将工具交给现有 `ToolHost` 并返回注销函数；可信宿主也可通过 Runtime 的工具数组显式装配。
当前 main 的 Runtime/Application 已重新导出 `createSystemObservationTool`，Desktop 的
`createPublicConnectorHost` / `createProductToolsComposition` 使用该工厂注册本工具，再向 Runtime 注入 tools。
只有实际注册后才能在能力发现中公布，缺工厂时保持不可用；此接线不等于实际采样、授权或云端消费成功。
提供者结果是本地输出；没有为其配置 Competition 结果出口时，不自动将系统指标发送到 AgentArts。
本包不代表 Desktop、AgentArts、MOD-16 或 PA-011 已完整验收。

## 通知消费者与真实读回

提供者的采样窗口默认 250 ms，可配置为 1～5000 ms。`actualSampleWindowMs` 是本次
CPU tick 读取的单调时间区间，`requestedSampleWindowMs` 是请求等待间隔；两者都不是
持续通知的调度周期。结果字段为 `unavailable`，不增加 `unavailableMetrics` 别名或第二套 DTO。

可信 Desktop 使用 Runtime/Application 的 `startSystemObservationSession({expiresAt, intervalMs})`、
`sampleSystemObservationSession(sessionId)` 和 `stopSystemObservationSession(sessionId)`。
当前 `intervalMs` 至少 1000 ms，且不得超过剩余许可期限。许可只在本进程内有效，停止或重启
不能从历史 checkpoint 恢复许可。Runtime 的 `readCurrentSystemObservationSample(taskId)`
只返回仍在当前许可内、任务成功、有 confirmed 结果与 Evidence 引用的 `node:os` 观测，
形状为 `{taskId, source, timestamp, cpuPercent, memoryPercent, samplingIntervalMs, evidenceRefs}`；
其中 `samplingIntervalMs` 是会话调度周期。它是 Runtime 公开宿主入口，不是本包新增 wire capability。
`p5-system-observation-source` 消费这一读回；通知消费者不能把直接 provider 输出冒充 Runtime Evidence。

2026-09-30 一次独立真实 Windows provider 读取使用 Node 24.19.0，默认采样窗口 250 ms，
实际窗口 264.4 ms，来源 `node:os`，输出 Schema 校验通过。脱敏本地收据保存采样时间与
不可用项，未保存指标数值、设备标识或私人内容；没有制造高负载。这仅补充提供者实机证据，
不证明持续通知、Runtime 会话授权、桌面渲染或 AgentArts 消费。

验证：

```sh
npm run typecheck --workspace=@personal-agent/windows-client
npm run build --workspace=@personal-agent/windows-client
npm run test --workspace=@personal-agent/windows-client
```

Windows 普通用户实机读回：先在仓库根执行 `npm ci`、构建 contracts 与本包，然后在非管理员
PowerShell 用独立新文件执行：

```powershell
$evidence = Join-Path $env:LOCALAPPDATA ("mod17-provider-" + [guid]::NewGuid().ToString("N") + ".json")
node packages/windows-client/scripts/capture-windows-evidence.mjs $evidence
```

输出文件必须不存在，脚本不会覆盖；Windows 文件访问权限继承用户的 LocalAppData 目录，
仅在本机保存并分享经审核的脱敏内容。脚本只保存来源、采样时间、
Schema 校验与不可用项等脱敏元数据，不保存 CPU/内存数值、用户名或设备标识。
这次调用直达 provider，**不验证**终端是否已提权、生产授权、capability 握手、AgentArts 或 Desktop。
