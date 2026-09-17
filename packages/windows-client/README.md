# Windows Client：只读系统观测首片

`@personal-agent/windows-client` 当前只提供 `createSystemObservationTool()`：一个通过现有
`RegisteredTool` / ToolGateway 边界调用的只读聚合观测工具。

它用两次 `node:os` CPU tick 采样计算系统整体利用率，同时返回逻辑处理器数量、内存总量/
可用量、系统 uptime 和采集时间。`requestedSampleWindowMs` 只表示请求的 tick 间隔，不冒充
实测采样耗时。它不会读取或返回 hostname、用户名、进程、命令行、路径、
文件、网络地址或凭据，也不会提权、启动 PowerShell、接入或发布 TraceGuard。

进程归因、磁盘 I/O、温度和网络活动在结果中明确标记为 `unavailable`。这些聚合值只说明
观测到的资源压力，不能证明电脑变慢的原因。

工具需要最小 scope `computer:system:read`，输入必须是空对象；deadline 或取消会中止采样并
清理计时器，不自动重试。默认 probe 使用 `node:os`，测试通过注入的合成 probe 验证，不读取
开发机数据。使用注入 probe 时结果固定标记 `source=injected`，不构成真实本机观测证据；仅默认
适配器标记 `source=node:os`。

当前只交付 provider slice。Competition Profile 仍是 text-only，未接本地工具提案；因此本包
不代表 Desktop、AgentArts、MOD-16 或 PA-011 已完整验收。

验证：

```sh
npm run typecheck --workspace=@personal-agent/windows-client
npm run build --workspace=@personal-agent/windows-client
npm run test --workspace=@personal-agent/windows-client
```
