# MOD-17-COMPUTER-STATUS-01：电脑状态只读提供者

- Profile：`huawei_ict_agentarts`；负责人 `zemeng`；非作者评审 `goo122`；需求 PA-011。
- 基线：`4efa7f60feaaa007d73c80e7d90091e0caab3bc7`；状态：review 前的实现切片。
- 复用已合并 PR #59 的 `computer.system.observe@1.0.0` 与 `computer:system:read`。旧 `MOD-16-SYSTEM-OBSERVATION-01` 记录保留为历史；当前 MOD-16 的 Windows 执行另行开发。

## 可观测边界

默认 `node:os` 实际读取两次 CPU tick、逻辑核数、内存总量与空闲量、uptime。输出保留 `source=node:os`，并增加两次 CPU 读取的 UTC 墙钟边界与单调时钟测得的实际采样窗口；请求的等待间隔独立报告。注入 probe 仅标记 `source=injected`，属于合成测试。

提供者能力描述列明支持 CPU、内存和 uptime；不宣称每次探测都能成功。单次读取失败完整拒绝且仅返回脱敏 `EXTERNAL_FAILURE`；取消、超时分别为 `CANCELLED`、`TIMEOUT`，不使用虚构零值。进程归因、磁盘 I/O、温度、网络活动明确不可用。不读取用户名、主机名、进程、文件、网络地址或凭据；不得凭资源压力推断故障原因、温度或优化效果。

## 装配交接

本包的描述函数仅是提供者元信息。生产工具发现须由可信 Runtime/ToolHost 在实际注册时公布，未经注册仍应返回 `UNSUPPORTED_CAPABILITY`。需要 goo122 定义或确认 Competition Profile 真实工具注册入口，将 `createSystemObservationTool()` 显式注入，保留 Policy/ToolGateway 对 `computer:system:read` 的检查、取消和 deadline；不改变公共 wire Schema、根装配、锁文件或接口目录。Desktop 负责人须在现有安全 Client/Preload/IPC 路径消费 Runtime 的结果，显示来源、时间、不支持项和失败，不由 Renderer 直读 `node:os`。AgentArts 真实工具提案与回传证据另行验收。

## 实机验收（Windows 普通用户权限）

1. 在 Node 24、Windows 普通用户会话，授权 `computer:system:read` 后通过受信 ToolHost 调用一次，记录脱敏的 `source`、UTC 时间区间、实际/请求采样窗口及输出 Schema 校验结果；敏感原始观测值不进入 PR。
2. 交叉核对 OS CPU tick、内存和 uptime 的读取路径，另在受限机器上演练 probe 失败，证明返回脱敏 `EXTERNAL_FAILURE`，无零值替代；取消/过期均不能继续第二次读取。
3. 复核未注册与未授权时无 probe 读取，分别记录 `UNSUPPORTED_CAPABILITY` 与策略拒绝。检查 UI 明示不支持的指标和来源，不凭 CPU/内存作因果诊断。
4. 如需宣称 Competition 端到端可用，另记录真实 AgentArts deployment/API/trace、工具提案、Runtime 授权/执行及 Desktop 展示的一次关联读回。离线 Fake 与 Linux 运行结果不能替代该证据。

本环境没有 Windows 设备，实机步骤未执行。此切片不宣称 MOD-17、PA-011 或整体 MVP 完成。

### 先行的 provider 实机取证

在普通用户、非管理员 PowerShell 中，从仓库根执行（输出文件在用户的 LocalAppData 下，
每次使用新 GUID 文件名）：

```powershell
npm ci
npm run build --workspace=@personal-agent/contracts
npm run build --workspace=@personal-agent/windows-client
$evidence = Join-Path $env:LOCALAPPDATA ("mod17-provider-" + [guid]::NewGuid().ToString("N") + ".json")
node packages/windows-client/scripts/capture-windows-evidence.mjs $evidence
if ($LASTEXITCODE -ne 0) { throw "provider evidence capture failed" }
Get-Content $evidence
```

脚本仅允许 Windows、只创建新文件，成功终端输出 `PASS`，失败仅输出脱敏错误码且退出非零。
Windows 文件 ACL 继承该用户目录；只在本地保留，分享前再次检查脱敏字段。
证据 JSON 不含原始 CPU/内存值、主机名、用户名、文件路径、网络信息或凭据。
检查 `source=node:os`、`schemaValid=true`、`aggregateValuesPresent=true`、采样时间与不可用项；
`productionAuthorizationVerified=false` 和 `agentArtsVerified=false` 是刻意保留的边界。
这一步直调 provider，不能自动证明 PowerShell 未提权，也不能替代上面的 ToolHost 权限拒绝、
能力握手或 AgentArts 真实闭环验收。记录操作人对普通用户会话的确认即可，不在证据 JSON 中
伪造“已验证普通权限”。
