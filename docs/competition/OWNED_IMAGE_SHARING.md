# 协作者使用 GHCR 预览镜像

2026-10-09。代码、接口和设计通过 PR 分享；镜像通过 `ghcr.io/zemeng5208/personal-agent-owned` 分享。预览发布不合并 main，也不表示华为云已验收。精确 tag/digest 和 Actions 证据见后续发布记录，不能提前把流程说明当发布成功。

## 获取与本地运行

镜像关联 `zemeng5208/PersonalAgent` 仓库；按 GitHub Packages 实际访问设置提供协作者读取。受信发布流程只使用 Actions 的 `packages: write` 权限，不将用户令牌、云导出或私人数据库放入镜像。

拿到发布记录的固定 digest 后：

```powershell
docker pull ghcr.io/zemeng5208/personal-agent-owned@sha256:<发布记录中的digest>
```

平台列表需从实际 manifest 读回。本轮发布流程生成 linux/arm64 与 linux/amd64，分别服务华为运行环境与常见开发电脑。私有包若要求登录，使用自己的 GitHub 凭据和 `read:packages` 权限，不共享他人 token；有仓库读权限仍应以包的实际访问设置为准。

镜像依赖真实模型配置。创建本机未提交的秘密配置文件，按 [Runtime README](../../apps/agentarts-runtime/README.md) 填写宿主配置，再绑定仅本机端口：

```powershell
docker run --rm --name personal-agent-preview -p 127.0.0.1:8080:8080 --env-file <本机秘密配置文件> ghcr.io/zemeng5208/personal-agent-owned@sha256:<digest>
```

在容器中使用 `agentarts` 监听模式，宿主端口仅绑定 127.0.0.1；不要把 `standalone-validation` 的容器内 127.0.0.1 误当可映射入站地址。直接裸容器不作为公网安全服务。密钥不写 Dockerfile、命令历史或聊天；缺配置启动失败是预期行为，不默认替换成 Fake。

## 仓库可下载的离线副本

发布 Actions 同时上传 ARM64 `.tar` 工件。若个人 GHCR 读取暂未配置，可使用自己的仓库权限从对应 Actions run 下载 `owned-agentarts-arm64-<source-commit>`，然后：

```powershell
docker load --input personal-agent-owned-arm64.tar
```

下载与加载不需要共享模型密钥；镜像仍需自己的运行配置。这是确实生成后才能使用的工件，来源、哈希与 run URL 以发布记录为准。

## 边界与协作

当前镜像接口为 HTTP `/ping`、`/invocations`；目标 WSS 主通道/HTTPS 备用、Wiki 自动同步和完整监管未交付。所有接口详见 [镜像接口](OWNED_IMAGE_INTERFACES.md)。镜像不包含本地工具宿主，不能单靠运行容器控制协作者电脑。

协作者修改通过公开契约和独立分支提交；Wiki 由 goo122 实施，业务连接器和 DEV-WORKFLOWS 仍按既有所有权。合并前两人各自在自己电脑打开当前设计并提交阅读声明/审批，禁止强制合并、--admin、跳过检查或直接推 main。
