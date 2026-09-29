# P1 接线基线与所有权登记（Potatos498 → goo122 确认请求）

版本：1.0 · 日期：2026-09-29 · 作者：`Potatos498` · 请求确认人：`goo122`（共享底座/Runtime/SecretStore/StoragePort 负责人）· 关联：Issue #212、接线方案 PR #88（已批）、#107（MVP 口径）

## 0. 本文目的

Issue #212 将全部非线上 AgentArts 的 MVP 实现、接线和收尾交给我；#107 明确五包 Runtime 注册与真实验收是 MVP 必需。goo122 在接线方案 PR #88 的批复第 4 条要求："Phase 1 开工时先固定目录所有权和接线基线，再按文档的合成验收逐项交付。" 本文即该基线登记，请 goo122 逐节确认或修订；**确认后我立即开 Phase 1 实现 PR。**

## 1. 目录与文件所有权登记（唯一写入者）

| 路径 | 唯一写入者 | 说明 |
| --- | --- | --- |
| `packages/connectors/**`（weather/feeds/mail/calendar/productivity 既有 + 后续 social） | `Potatos498` | MOD-20~26 长期所有权（#107 重申）；业务逻辑、Provider、测试 |
| `packages/notifications/**`、`packages/productivity/**` | `Potatos498` | MOD-23/MOD-20 既有所有权 |
| `packages/memory/**`、`packages/learning/**` | goo122（在途 #209~#211）→ 交接后 `Potatos498` | 交接边界见 §4 |
| `apps/runtime/src/connectors-runtime.ts`（Phase 1 新文件） | `Potatos498` | 五包工具收集与组合工厂，唯一新文件 |
| `apps/runtime/src/index.ts`、`application.ts` 等既有 Runtime 文件 | `goo122` | 我只在 goo122 认可的最小接入点提 diff（预期 ≤10 行：import + tools 数组接入），或由 goo122 亲自落 |
| 根 `package.json`、`package-lock.json` | `goo122` | Phase 1 无新外部依赖，预计仅 workspace link 变化由 npm 生成 |
| `apps/desktop/electron/main.js`、`view.js` | `zemeng` | P2 Desktop 接线不属 Phase 1；我仅提需求 |

## 2. 需要的接口（请求 goo122 提供或确认归属）

| 接口 | 现状 | 需要的决定 |
| --- | --- | --- |
| `ConnectorHost` + `SecretStorePort.read`（connector-host，已合并） | 已在 main | Phase 1 mail 凭据走此受信路径；`secretRefs: ['qq-mail-authcode']` 声明待你确认 ref 命名 |
| KV `StoragePort` 适配（#88 批复第 3 条归你） | **未实现** | 请确认：实现放 `packages/storage`（我建议）还是 apps/runtime；迁移号从 8 起；受信 namespace 命名规则（建议 `p1-connectors`） |
| `TaskRuntime.listSchedules` / `reconcileSchedules`（#197 已合并） | 已在 main | productivity 提醒对账直接消费，无需新接口 |
| `notifications.planSchedules()` → `runtime.createSchedule()` 桥 | notifications 包已导出 planSchedules；runtime 侧 createSchedule 已在 | Phase 2 的组合点在 connectors-runtime.ts，Phase 1 不做 |
| Runtime 启动凭据注入形态 | 未定 | Phase 1 先支持环境变量注入（`PA_QQ_MAIL_USER/AUTH_CODE` 已有约定）+ SecretStore 路径并行可插；桌面 UI 归 zemeng（Phase 3） |

## 3. Phase 1 接线基线（照 #88 批复逐项）

1. **模式**：`RegisteredTool[]` 收集 → `createRuntimeApplication({tools, profile: 'huawei_ict_agentarts', …})`（你在 #88 批复第 1 条已确认 Competition + tools 成立）。
2. **九工具**：feeds.collect、feeds.subscriptions（feeds:read）；mail.inbox、mail.accounts（mail:read）；todo.list（todo:read）；todo.create、todo.update（todo:write）；notifications.status（notifications:read）；research.search（research:read）。
3. **凭据**：mail 走 `ConnectorHost.readSecret` 受信路径； SecretStore 异常规范化（取消=CANCELLED、其他=脱敏 EXTERNAL_FAILURE）+ 合成哨兵回归照你批复第 2 条。
4. **无凭据降级**：mail 不注册不报错；其余四包无凭据依赖正常注册。
5. **StoragePort**：productivity/notifications 等 goo122 侧适配器落地后再接——Phase 1 首批只接 feeds/mail/research 三个不依赖 KV 存储的包；productivity/notifications 在适配器合并后作为 Phase 1b。
6. **验收**：每包「审批流调用成功 + scope 拒绝 + 无配置不注册」集成测试（照 weather-integration 模式，预计 +12 项）；合成哨兵回归（凭据占位断言）。

## 4. goo122 在途记忆线的交接请求（#209~#211）

你尚未在 Issue #212 登记交接头。请登记：

1. **剩余未完成部分**的精确清单（#209 集成增量 +3892/-36、#210 +203/-19、#211 +133/-4 相对各自基线还缺什么）；
2. **唯一文件移交**：`packages/memory/**`、`packages/learning/**`、相关测试何时由我接手；
3. **保留给你的部分**确认（私人记忆控制器与其测试，按 Issue #212 你已声明保留）；
4. 三 PR 的串行合并顺序确认（#209 → #210 → #211？）。

我已完成 #202~#208 的非作者评审（全部 APPROVED）。交接前不重写你的代码；交接后剩余增量（备份删除、跨库恢复、真实来源路径）由我承接。

## 5. 优先级与顺序确认

按 #88 批复第 4 条与 #107 新口径的合并理解：

1. **现在**：Competition Golden Path 优先（zemeng/goo122）——我不抢；
2. **本 PR 确认后立即**：Phase 1 实现 PR（feeds/mail/research 三包 + 适配器归你的部分并行）；
3. **Phase 1 合并后**：productivity/notifications 接入（Phase 1b）+ Phase 2 调度闭环；
4. **MOD-26**：等产品负责人（你/用户）确认首版平台后再登记子任务。

## 6. 请逐节回复

- §1 所有权表：确认或修订；
- §2 接口表：StoragePort 适配归属与 namespace 命名；
- §3 Phase 1 基线：三包首批（feeds/mail/research）+ 二批（productivity/notifications）的拆分是否认可；
- §4 交接头：按四点登记；
- §5 顺序：无异议请回复"按此执行"。
