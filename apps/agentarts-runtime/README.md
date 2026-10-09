# 自有 AgentArts Runtime 镜像

<!-- current-design-20261009 -->
> 当前目标与协作规则（2026-10-09）：[完整设计](../../docs/design/resident-developer-agent-20261008/DESIGN.md) · [离线阅读/全部 SVG](../../docs/design/resident-developer-agent-20261008/index.html) · [两人确认与本机阅读门槛](../../docs/reviews/DESIGN_READING_GATE.md)。WSS 主通道、HTTPS 备用；Wiki 记忆由 goo122 接入。goo122 与 Potatos498 均确认后才可按授权合并，禁止强制合并/管理员绕过。设计不等于已实现；本文历史验收与作者记录保留，旧合并规则以当前门槛为准。

目标为 `huawei_ict_agentarts`；同一核心代码支持显式 `standalone-validation` 验证。
本入口提供标准 8080 `/invocations` 与 `/ping`，无需把现有 TS 改写为 Python。
ModelGateway 是唯一模型入口，真实提供者由宿主配置，不会缺配置回退 Fake。

## 配置与运行

使用仓库 `.node-version` 的 Node 24.15.0、npm 11.12.x。先运行根构建。
以下配置由可信部署宿主注入，密钥不要填入 Dockerfile、Git、日志或聊天：

- `PA_AGENT_HOST_MODE`：`agentarts` 或 `standalone-validation`，必须明确。
- `PA_AGENT_MODEL_BASE_URL`：HTTPS OpenAI Chat Completions 兼容入口，包含版本路径。
- `PA_AGENT_MODEL`：实际模型名；每角色可用 `PA_AGENT_FAST/WORLD/PLAN/REVIEW_MODEL` 覆盖。
- `PA_AGENT_MODEL_KEY_FILE` 或 `PA_AGENT_MODEL_API_KEY`：宿主秘密文件或运行时环境；每角色可独立覆盖。
- `PA_AGENT_MAX_OUTPUT_TOKENS`：单角色输出预算，默认 2048；修复最多顺序调用三个角色，无自动重试。
- `PA_AGENT_TIMEOUT_MS`：服务期限上限，默认 60000；取与原 `X-PA-Deadline` 的较早值。
- `PA_AGENT_WORKFLOW_GOAL_INPUT`：可选的单一旧 Workflow 输入名。
- `PA_AGENT_INBOUND_TOKEN`：可选额外入站保护；至少32字符，调用方走已有Authorization宿主注入。

`npm run start --workspace=@personal-agent/agentarts-runtime`。
独立模式只绑定 127.0.0.1，不改变 Desktop 的正式比赛 endpoint。
AgentArts 模式监听 0.0.0.0，必须由平台入站认证保护；直接运行裸容器不等于安全公开服务。
session 与 request 头只用于关联，不记录模型输入和凭据，不宣称已迁移平台会话存储。

## 构建与回滚

`npm run image:context --workspace=@personal-agent/agentarts-runtime` 生成新的 allowlist 上下文。
仅复制本入口和四个公开依赖包的 dist/schema/package.json，不复制 Desktop/Runtime、
私人数据库、`.env`、云导出或当前根目录其他文件。

在返回的 context 目录执行：

```powershell
docker buildx build --platform linux/arm64 --load -t personal-agent-owned:20261008 .
docker image inspect personal-agent-owned:20261008 --format '{{.Os}}/{{.Architecture}}'
```

固定依赖来自根锁文件；基础镜像固定24.15.0标签及2026-10-08读回的多架构索引 digest，已确认含 linux/arm64/v8。
2026-10-08 已构建并实测 `personal-agent-owned:20261008`，读回 linux/arm64、USER node。
索引 digest 为 `sha256:d126119af47c23445280d831e0f4b04c49c92403902d8d751340739962eb96e5`，
后续代码修改应重新生成上下文、构建并登记新的 digest。
只在同区域 SWR 与 AgentArts 新 runtime/version 部署，先保留旧 runtime。
ping 仅证明进程健康；真实模型、工具、trace、评估及取消须分别验证。
回滚为恢复旧 endpoint/配置，不清库、不重做已确认工具，不删除旧云资产。

当前状态及缺口见 `docs/modules/AGENTARTS-OWNED-IMAGE-MIGRATION.md`。

## 生产入口的离线验证

`test/production-transport.mjs` 是手动运行的合成传输检查，不会随普通单元测试读取真实模型配置。
在项目忽略目录用 OpenSSL 生成短期证书和私钥（SAN 包含 IP 127.0.0.1），
将测试目录和证书目录只读挂载到镜像，设置 `PA_TEST_TLS_DIR` 为容器内证书目录，
执行 `node apps/agentarts-runtime/test/production-transport.mjs`。
目录需包含 `key.pem`、`cert.pem`；容器使用 `--network none`。
该脚本启动实际生产入口，仅子进程通过 `NODE_EXTRA_CA_CERTS` 信任此测试证书，
验证既有 HTTPS Provider、四角色路由、错误、期限及关闭；不关闭 TLS 校验，不调用真实模型。

原始导出清点：`npm run inventory --workspace=@personal-agent/agentarts-runtime -- <原件绝对路径> <新清单绝对路径>`。
清单只输出白名单元数据和源片段哈希，保留原件在项目忽略目录；不执行 DSL 或 Python，不输出认证配置。
