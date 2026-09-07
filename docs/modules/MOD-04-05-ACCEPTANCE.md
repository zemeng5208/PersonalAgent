# MOD-04/05 验收工作包

- 负责人：goo122；评审者：zemeng 或 Potatos498。
- 分支：`codex/mod-04-05-acceptance`；工作树：`.worktrees/mod-04-05-acceptance`。
- 基线：`0f7dc1e`，包含已合并的 ARCH-03（PR #24）。
- 范围：Model/Agent、Policy/ToolGateway、Runtime Application 与必要存储适配及测试。
- 状态：本地离线验收通过；用户选择先离线交付，真实调用暂不执行。待非作者评审和集成。

| 验收项 | 初始证据 | 本轮结果 |
| --- | --- | --- |
| 模型与 Agent 有界循环 | 原有主循环 | 通过：预算、错误、强制超时取消、显式 JSON 工具提案 |
| 授权持久化及一次性消费 | 原内存 Map | 通过：SQLite 迁移、重启消费、撤销、参数绑定 |
| 工具执行证据持久化 | 原无执行记录 | 通过：成功/失败/未知记录、Policy 决策、标准 Evidence 查询和错误脱敏 |
| 审批与重启恢复 | 原缺少实现 | 通过：拒绝、过期、revision 冲突、重复审批、原提案恢复 |
| Fake 模型到工具完整链路 | 原独立测试 | 通过：Application→Agent→审批→Gateway→Fake Weather→回答 |
| 真实盘古及只读工具验收 | 尚未调用 | 等待本地配置与授权 |

模块保持 review；测试通过、真实验收和非作者评审集成分别记录。

## 本轮验证

环境：Node 24.15.0、npm 11.12.1。实现提交 `d748b3c`（模型/Agent）、`76030ea`（权限/Runtime）、`8f444ce`（集成测试与真实验收入口）。

- `npm run check`：通过架构门禁、生成类型检查、严格类型检查和全工作区测试；3 项真实天气测试显式跳过。
- `node --test apps/runtime/test/mod-04-05-acceptance.test.mjs packages/agents/test/agents.test.mjs packages/models/test/structured-tools.test.mjs`：18/18 通过，包含后补的旧数据库迁移和 Agent 预算测试。
- `npm run test:text-smoke --workspace=@personal-agent/desktop`：通过，Fake 文字提交与回复、显示和复制行为正常。
- `npm run test:smoke --workspace=@personal-agent/desktop`：通过；本轮未复现旧记录中的拖动边界失败。
- `node --check tests/manual/mod-04-05-live.mjs`：通过；关闭真实开关时脚本输出 SKIPPED，未访问真实服务。
- 仓库未配置独立 lint 命令，不宣称执行了 lint。

## 后续真实验收

由用户在本地进程环境中配置 `PANGU_BASE_URL`、`PANGU_MODEL`、`PANGU_API_KEY`，不要提交或将密钥贴入聊天。用户授权后再设置 `PA_MODEL_LIVE=1`，在仓库根目录执行 `node tests/manual/mod-04-05-live.mjs`。

该脚本会进行一次文字连接检查，再请求北京当天天气，并只允许一次 `weather.forecast`；模型调用受 Agent 步骤、token 和截止时间限制。日志输出状态和计量，不输出密钥或完整对话。真实服务仍可能拒绝或返回不符合提案协议的内容，必须按实测结果记录。

桌面手动联调：`npm run start --workspace=@personal-agent/desktop -- --weather-tools`，在现有模型设置中配置盘古后提交天气问题，在后台授权页允许一次，再检查回答。该天气桌面链路的真实人工验收尚未执行。

## 剩余范围

- MOD-04：真实盘古工具提案能力待验收；流式 wire 协议未定义，PA-012 多 Agent 委派未实现。
- MOD-05：本轮完成任务级持久授权、审批和证据；跨任务持续授权管理、真实 Windows SecretStore 和真实写操作恢复仍需对应工作包。
- 任意工具的 confirmed 表示工具返回通过 Schema 校验，不等于外部业务已独立读回验证；Evidence 保留 conditional 等级。
- 本轮只做本地提交，不推送、不创建 PR；不得据此将整个 MOD-04/05 标为 done。

建议 PR 标题：`feat(runtime): MOD-04/05 离线审批与工具执行闭环`。说明应包含参数绑定授权、恢复与幂等行为、18 项定向测试和桌面 smoke 结果，并明确真实模型、完整持续授权和 PA-012 仍未验收。
