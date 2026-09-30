# P8 参考工具及共享装配增量

目标为 `huawei_ict_agentarts`；集成树 `mvp-assembly/PersonalAgent`，分支 `codex/zemeng/p8-mvp-final-integration`。模块源保持原作者所有权。

## 当前接线

- 正式启动默认 Competition Profile；显式 Fake 联调选择 Local，空/非法 profile 拒绝。
- 原 Conversations 元数据升级 v3，保存 panel/workspace 各自辅助模型及思考偏好；任务受理时固定模型配置引用与步数。旧 v1/v2 可读，旧应用不能读取 v3，因此回退必须保留数据并使用兼容版本。
- 子任务允许、拒绝、直接取消均恢复原父任务与已确认 dispatch，不创建新子任务或重复授权消费。
- RSS due-check 使用既有 Runtime worker 和订阅源绑定；feed collect 经过原 HostTool/Policy，管理员页面不能直接确认交付。完整来源 Evidence 联接与兴趣消费仍待装配验收。
- MCP 采用固定官方 SDK/filesystem 服务，默认关闭。接入 P6 可信工作区绑定，执行前后验证当前许可；配置变更、撤回和退出取消原任务并停止原服务。仅内容 hash/读取确认元数据可云导出。
- 固定参考 Skill 在 worker 层调用原工具端口。原任务与学习 checkpoint 可原子创建；恢复仅核验已确认的原 execution、输入、Policy、Evidence 和配置引用，再完成纯摘要步骤，不重试 MCP。
- Runtime 技术尾注仅在可信 Competition 来源下从正文投影分离；原 resultSummary 保留，验证身份在详情显示。

## 本次必要检查

- `mcp`、`skills`、Runtime 定向 TypeScript 编译通过。
- 原父子任务允许/拒绝/取消、对话偏好、启动 profile：新增 6 项通过。
- `node --test apps/runtime/test/reference-skill-application.test.mjs apps/desktop/test/result-text.test.mjs`：3/3，通过真实官方 stdio 与 SQLite/Policy 路径；零审批前读取、允许后读取 1 次、确认后中断恢复读取仍 1 次，原 Evidence 被保留。
- 共享 Desktop JS 语法及差异检查通过；新控件尚未做实际桌面渲染验收。
- 安装先尝试离线，因 `ENOTCACHED` 停止；随后官方 registry `--ignore-scripts --no-audit --no-fund` 成功，97 包。锁文件由 npm 生成，未运行安装脚本。

使用 Node 26.3/npm 11.16；未找到项目要求的 Node 24.15/npm 11.12，因此不能宣称匹配运行版本验收。没有重新运行全量检查、旧模块测试或真实模型。

## 尚未完成

知识库与记忆/学习正式 facade、Skill 云端分派及 RSS 来源证据仍在接线；真实 Goal/Laya/v16 云源/Policy/CAS、账户服务、原生桌面和恢复整体验收未执行。上述定向通过不等于 MVP 完成或产品发布。
