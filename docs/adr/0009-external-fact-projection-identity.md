# ADR-0009：分离 Memory 事实身份与图节点版本

- 状态：proposed；未授权实现，待 `zemeng` 消费语义复核与 `goo122` 公共类型、持久格式及回滚评审。
- 日期：2026-09-17。
- Profile：`huawei_ict_agentarts`；关联 MOD-09、MOD-27、MOD-28、PA-024/025。
- 前置：ADR-0002、ADR-0005、ADR-0006、ADR-0008，以及 PR #73 的纯预览边界。
- 编号说明：本提案基于含 ADR-0008 的 PR #73；若合并前已有其他 ADR 占用 0009，须重编号，不能覆盖历史。

## 背景

当前 `@personal-agent/goals` 的 `NodeRef` 与 `@personal-agent/memory` 的
`FactRef` 恰好都有 `id/revision`，但不是同一个版本空间。Goal 图的节点 revision
由 `appendVersion` 按图中同 ID 的追加次数分配；Memory revision 则属于事实源。
PR #73 为保持可验证性，暂时只接受两者 ID/revision 相同且连续的子集，因此空图首次
看到 `MemoryFact@12` 会 `REBUILD_REQUIRED`。

把缺失的 Memory 1～11 伪造成图历史会泄露或虚构未授权历史，也会让图 revision 失去
“本图实际追加版本”的含义。把 Memory 身份编码进 `sourceRef` 又会破坏原始来源。
同时，Goals 当前不依赖 Memory；反向新增 `goals -> memory` 会把存储领域绑定到事实提供者，
并增加循环依赖风险。

持久化也不是透明扩展。当前 `parseGraph` 对节点键集合做严格相等检查，Runtime 将完整
`GraphSnapshot` 直接序列化到 migration 5 的 `coordination_graphs.snapshot_json`，没有
持久格式版本。新字段可由新 reader 兼容旧数据，但旧 reader 会拒绝带新字段的快照；
代码回滚本身不能保证已写入数据可降级读取。

## 提议

### 1. 两个版本空间保持分离

- `NodeRef {id, revision}` 继续只表示图内节点版本；Goal/Decision/Plan 的 dependencies
  仍固定到精确 `NodeRef`，不因外部事实更新而自动重绑。
- Graph 的 Fact 节点增加成对可选的 `externalRef` 与 `externalDigest`。二者必须同时存在
  或同时缺失，且只允许出现在 `kind: 'fact'` 的节点上。
- 缺少这对字段的旧 Fact 是 legacy/unmapped。新 reader 必须继续读取，但不得根据旧节点
  的 `id`、`revision` 或 `sourceRef` 猜测 Memory 来源，也不得就地补写推断出的身份。
- `sourceRef` 始终保留经过完整验证的 Memory 原值；不编码 externalRef、scope 或 digest。

建议的 Goals 自有结构如下，名称和长度限制在实现评审时冻结：

```ts
interface ExternalFactRef {
  kind: 'memory_fact';
  scopeEpoch: string;
  id: string;
  revision: number;
}

interface FactProjectionMetadata {
  externalRef?: ExternalFactRef;
  externalDigest?: string;
}
```

这只是图持久化所需的结构，不是 `Memory.FactRef` 的别名，也不要求 Goals 导入 Memory。
Memory→Graph 的类型转换、完整 FactVersion 校验和 digest 计算属于 cognition 投影层。
如未来有第二种事实提供者，再评审是否提取到中立的低层公共包；本次不把它放进 wire
contracts，也不为单个消费者新建“共享 DTO”包。

### 2. 绑定范围与唯一稳定映射

可信 Host 为投影固定 graph namespace 及不透明 `scopeEpoch`。该 epoch 绑定 namespace、
consumer 和精确 sensitivity scope；普通消费者不能选择或改写。映射身份是：

```text
(GraphSnapshot.namespace, externalRef.scopeEpoch, externalRef.id)
```

第一次看到一个可见事实时，Host/投影层分配一个不泄露原始 fact ID 的稳定图节点 ID，
并把映射随 Fact 节点历史一起持久化，不另建第二个权威事实库或映射数据库。并发首次映射
仍由图 CAS 决出唯一提交者；失败方刷新图后复用已经持久的映射。

第一次可见版本可以是 `Memory@12 -> GraphFact@1`，无需补齐隐藏或已丢弃的 1～11。
以后同一外部事实的可见修正继续使用相同图节点 ID，但图 revision 独立增长，例如
`Memory@13 -> GraphFact@2`。首个投影可携带指向未投影 Memory 历史的 `corrects`；首个之后
的新投影必须修正当前已映射的精确 externalRef，缺口要求 reconciliation，不静默跳过。

相同精确 externalRef 已存在时：

- digest 相同：幂等 no-op；
- digest 不同：固定完整性错误，不覆盖旧节点；
- externalRef revision 早于或等于当前映射头、但图历史中没有该精确 Ref：拒绝倒插为最新，
  返回 reconciliation/rebuild 类失败；不重排历史。

scope 收缩或绑定 epoch 变化后不能复用旧 epoch 的映射来恢复先前可见内容。旧图历史和
依赖如何保留、隔离或物理删除仍由删除策略决定；本 ADR 不用新 epoch 自动删除历史，
也不把 namespace 标签当身份认证。

### 3. externalDigest 的规范化与限制

投影层必须先完成 PR #73 等级的完整 `FactVersion` 验证，再按固定字段顺序生成规范载荷。
建议 v1 digest 覆盖：

- 域分隔标识 `personal-agent/memory-fact/v1`；
- `ref.id/revision`、`summary`、原始 `sourceRef`；
- `observedAt`、`validFrom`、`validUntil`；
- `sensitivity`、`state`、`confirmation`；
- `corrects.id/revision`，不存在时使用明确的 `null`。

使用规范 UTF-8 JSON 和 SHA-256，存储为 `sha256:<lowercase-hex>`。不能对调用方原始对象
直接 `JSON.stringify`，也不能忽略 metadata、corrects 或 confirmation。digest 只证明
“同一规范输入得到同一指纹”，不是来源真实性、用户确认、授权、Evidence 或执行成功。
它与事实采用相同敏感级别，不得进入公开日志、错误、AgentArts 提示或出机载荷；
`externalDigest`（亦即来源内容指纹）绝不是出机许可，低熵内容仍可能被猜测。

### 4. 兼容、持久格式与回滚门槛

- 新 Goals reader 必须同时读取 legacy 节点和带成对字段的新 Fact；字段只出现一个、出现在
  非 Fact、结构非法或 digest 格式错误时 fail closed。
- 旧 reader 不承诺读取新字段。首个新格式写入前，必须由 `goo122` 选择并评审持久版本方案，
  例如在存储 envelope/列中登记版本，或定义 GraphSnapshot v2；不能修改 migration 5 的既有含义。
- 新 reader 需要 dual-read，writer 切换必须显式。降级必须有已验证的备份/转换或明确禁止；
  仅回滚代码不能称为可恢复，因为旧 parser 会拒绝新字段。
- 持久格式、迁移、Runtime adapter、备份与回滚由 `goo122` 负责；图/影响语义、映射规则和
  消费者验收由 `zemeng` 负责。任何 wire Schema/capability 变化另立工作包。

在上述公共类型和持久门槛获批前，PR #73 的等号映射与首次 `revision > 1` fail-closed
限制继续有效；本提案不改变其行为、接口状态或证据等级。

### 5. 若接受后的接口与所有权

| 负责人 | 所需变更 | 不在该变更内 |
| --- | --- | --- |
| `zemeng` | cognition 的 Memory→Graph 映射、规范 digest、幂等/冲突/影响消费者测试 | Memory 存储、Runtime migration、feed ack |
| `goo122` | Goals 的 `NodeInput`/`NodeVersion` 可选成对字段、dual parser；可信 Host 的 scope epoch 绑定；持久格式版本、迁移、备份和回滚 | Goal/Decision/Plan 语义自动修复 |
| 双方评审 | 接口目录状态、精确长度/算法版本、旧数据升级与失败语义 | 自动提升为 frozen、wire capability 或真实数据授权 |

`GraphSnapshot`、`NodeInput`、`NodeVersion` 的具体 v2 形状只有在持久方案选定后才能冻结。
本 ADR 不修改 contracts Schema，不新增生产 capability，也不授权把真实私人事实写入图或云端。

## 理由与影响

该设计让图历史只记录实际投影过的版本，既能从任意当前可见 Memory revision 开始，又能
继续以 NodeRef 固定依赖和传播影响。映射及 digest 随图保存，可在不新增事实库的前提下
提供幂等和冲突证据；Memory 仍是完整 FactVersion 的唯一权威来源。

代价是 Goals 公共领域类型、严格 parser 和持久格式都需要兼容变更；旧二进制不能读取新写入，
digest 还增加敏感派生数据治理。大图按 history 查 externalRef 的索引和性能属于实现评审，
不能通过新增未事务化旁路表绕过。

## 不采用的方案

- **继续永久要求 FactRef revision 等于 NodeRef revision**：可保留为 PR #73 的临时安全子集，
  但不能处理正常 bootstrap 的高 revision 头。
- **为 1～11 创建占位图节点**：伪造未观察历史并可能泄露数量，拒绝。
- **把外部身份写进 sourceRef**：破坏来源语义和可审计性，拒绝。
- **Goals 直接导入 Memory.FactRef**：跨负责人领域耦合并增加依赖环风险，拒绝。
- **单独建立映射数据库/第二事实库**：引入新的事务与恢复权威，当前拒绝；若性能迫使增加
  索引，也必须是同一图事务内可重建的派生索引。
- **按原始 fact ID 确定图 node ID**：泄露标识并可能与 legacy/其他 kind 冲突；使用图内持久、
  Host 分配的稳定 opaque ID。

## 最小验收条件

1. 空图可将完整验证后的 `MemoryFact@12` 投影为 `GraphFact@1`，不生成 1～11 占位，
   `sourceRef` 原样且完整图历史可重放。
2. 同一精确 externalRef + 同 digest 重投为 no-op；同 Ref + 不同 digest 固定完整性拒绝，
   错误不回显事实正文。
3. `Memory@13` 在相同 namespace/scope epoch 下复用同一图 ID 并成为 GraphFact@2；
   未映射旧 Ref 不得倒插为最新，修正链缺口显式 reconciliation。
4. 并发首次映射只能一个 CAS 成功；冲突刷新后得到同一稳定映射，不产生两个图节点或部分历史。
5. 外部事实更新只追加 Fact；既有 Goal/Decision/Plan dependencies 不自动重绑，影响分析仍只标记
   精确旧 NodeRef 的传递依赖，非相关节点 KEEP。
6. scope epoch 变化/收缩使旧映射不可复用；旧可见内容不得通过 legacy fallback 或旧头复活。
7. 新 reader 能读取既有 legacy 图且不猜来源；成对字段校验覆盖缺一、非 Fact、恶意结构与 digest；
   旧 reader 拒绝新格式的限制有明确升级/降级说明。
8. SQLite 关闭重启后 externalRef/digest 和映射唯一性读回；格式版本、迁移、备份与回滚由
   `goo122` 验收，且架构门禁证明没有 `goals -> memory` 依赖。
9. digest 测试覆盖 metadata、corrects、confirmation 任一变化都会改变指纹，并证明 digest
   不进入公开 Evidence/日志/云载荷，也不作为授权或真实性判断。

## 复审条件

只有公共类型、dual-reader、持久格式版本、迁移/回滚、scope epoch Host 绑定、CAS 重启验收和
非作者评审全部完成后，才可把状态从 proposed 调整为 accepted。即使接受，本地图提交也不能
被称为完整 feed 原子消费；投影、去重、影响登记和 checkpoint 的同事务要求仍受 ADR-0008 约束。
