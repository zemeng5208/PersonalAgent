# @personal-agent/mail

MOD-21 · 邮件连接器——QQ 邮箱提供商工作包（PA-014，P1）。负责人 `Potatos498`，评审者 `goo122`。

## 职责

- **多账号绑定**：`MailAccountRegistry` 支持同一实例绑定多个邮箱（bind/unbind/按 `accountRef` 分发；重复 bind 同 ref 为换绑）；凭据的持久化与加密存储归宿主（桌面端 safeStorage 模式，参照既有 Pangu API Key 设置），本包只在运行时持有已构造的提供商实例。
- 邮件增量同步：游标 `uidValidity:lastUid`，只返回 UID 更大的新邮件；`uidValidity` 变化（文件夹重建）→ `CURSOR_EXPIRED`，需从头同步（与 feeds 同规则）。
- 条目规范化（`ConnectorItem`）：`occurredAt` 取邮件 Date 头的 UTC 瞬间（缺失回退抓取时刻并在 `contentRef` 标注）；**`sensitivity: 'private'`（邮件内容敏感，条目只含发件人/收件人/主题/已读状态，不含正文）**；`dedupeKey = folder:uid:messageId`。
- 动作：`mark_seen`（幂等，本地化确认）；`send`（外部写，见下）。

## 非职责

- 分类、摘要、草稿：PA-014 的这些环节由 MOD-04 模型层完成，连接器只供数据与动作。
- 其他邮箱提供商（IMAP 通用化、Gmail/Outlook）：后续按提供商拆分工作包。
- 授权码的获取与存储：用户在 QQ 邮箱设置生成授权码，装配层经环境变量注入（`PA_QQ_MAIL_USER` / `PA_QQ_MAIL_AUTH_CODE`），不进仓库、不进前端快照。

## 发送语义（PA-014：发送需对应授权；超时先核对结果）

- `send` 是外部写，`scope` 由宿主授权链控制（ADR-0003）。
- **超时不等于失败**：SMTP 超时/连接中断映射为 `state: 'unknown'`——邮件可能已发出。证据链标注 `unconfirmed`，消费方必须先到已发送文件夹核对结果，**不得直接重发**。
- **幂等键防重发**：同一 `idempotencyKey` 的重放返回先前结果（含 unknown），不会产生第二次发送；换输入复用同一键 → `INVALID_ARGUMENT`。

## 公共入口

`src/index.ts` 导出 `register`、`MailConnector`、`MailService`、`FakeMailProvider`、`QQMailProvider`、`messageFromImap`/`messageToItem`、游标编解码与全部类型。

### 工具

| 工具 | 版本 | Scope | 副作用 | 幂等 | 恢复 |
| --- | --- | --- | --- | --- | --- |
| `mail.inbox` | 0.1.0-alpha.1 | `mail:read` | read | ✓ | ✓ |
| `mail.accounts` | 0.1.0-alpha.1 | `mail:read` | read | ✓ | ✓ |

`register(host, {provider, accountRef?, registry?, now?})`：`provider` 必填（缺失抛 `INVALID_ARGUMENT`，Fake 仅测试用），作为默认账号绑定（`accountRef` 缺省 `local`）；可传入宿主维护的 `registry` 实现多账号。入参 `account`（绑定多个账号时指定，可用 `mail.accounts` 查询；只绑一个或存在显式默认时可省略——默认账号被解绑且剩多个账号时省略会报 `INVALID_ARGUMENT` 并列出可选项）、`cursor`（按账号隔离）、`limit` 1..100（默认 20）、`folder`（默认 INBOX）。

### 连接器（ConnectorPort）

manifest：`id=mail`、`accountTypes=['qq']`、`capabilities=['fetchChanges','search','getItem','performAction']`、`authentication='password'`（QQ 授权码）、`syncStrategy='incremental'`、`verification`＝Fake `mock` / QQ `conditional`。未 `connect()` 前数据方法抛 `UNAUTHORIZED`；不支持的动作抛 `UNSUPPORTED_CAPABILITY`。

## QQ 真实提供商（imapflow + nodemailer）

- **读侧 IMAP**：`imap.qq.com:993`（SSL），LOGIN 用完整邮箱地址＋授权码；`UID SEARCH uid:N:*` 增量、`FETCH ENVELOPE+FLAGS` 取元数据、`UID STORE +FLAGS.SILENT (\Seen)` 标已读。
- **写侧 SMTP**：`smtp.qq.com:465`（SSL），`AUTH LOGIN`；`socketTimeout` 取发送超时参数。
- 新增外部依赖 `imapflow@1.7.8`（MIT）与 `nodemailer@10.0.0`（MIT-0）：真实账号集成需要协议正确的客户端，自写 TLS 协议栈未经真实验证风险更高；`fast-xml-parser` 已有获批先例。归 `goo122` 评审确认。
- 网络错误映射：认证失败 → `UNAUTHORIZED`（不可重试）；超时 → `TIMEOUT`（可重试）；连接类故障 → `EXTERNAL_FAILURE`（可重试）。

## 取消、超时与重试

读侧由宿主 `ToolContext.signal`/deadline 门禁；写侧超时语义见上（unknown，不盲重试）。

## 测试

`node --test test/*.test.mjs`（14 项，12 离线 + 2 门控 live）：游标编解码与畸形拒绝；增量分页三页取尽＋同游标零重复＋跨页去重；条目语义（Date 头/缺失回退/`private`）；uidValidity 轮换 → `CURSOR_EXPIRED`；mark_seen 幂等且生效；发送确认与同键重放不重发；**超时 → unknown → 同键核对仍 unknown 不盲重发**（PA-014 核心）；输入校验；搜索与单条；连接器全链路；`messageFromImap` 边界；工具 schema/scope。

真实读回（门控，需授权码）：

```sh
PA_MAIL_LIVE=1 PA_QQ_MAIL_USER=<QQ邮箱地址> PA_QQ_MAIL_AUTH_CODE=<授权码> node --test packages/connectors/mail/test/
# 真实发送（会发一封测试邮件，独立开关防误发）：
PA_MAIL_LIVE=1 PA_MAIL_LIVE_SEND=1 PA_QQ_MAIL_USER=… PA_QQ_MAIL_AUTH_CODE=… PA_QQ_MAIL_TO=<收件地址> node --test packages/connectors/mail/test/
```

## 已知限制

- `QQMailProvider` 的网络路径未经本机验证（需授权码，live 门控待执行）——协议映射逻辑（envelope→条目、游标、错误映射）已离线固定，live 结果待补记。
- QQ 邮箱 IMAP 有连接频率限制，连接为惰性单例（复用直至不可用）；无 IDLE 推送（增量靠游标轮询，调度建议由宿主给出）。
- 搜索为客户端过滤（拉全量窗口后按主题/发件人匹配），未用 IMAP SEARCH；大邮箱应改服务端搜索。
- 文件夹列表的 `uidValidity` 仅在 `fetchPage` 打开邮箱时可得，`listFolders` 返回 0 占位。
