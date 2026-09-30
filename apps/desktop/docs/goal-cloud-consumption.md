# P8 GoalCloud 消费接线

Profile：`huawei_ict_agentarts`；公开 Goal 工具及 Scope 仍为 provisional。沿用 Runtime Policy、现有 Goal 工具和 coordination store，无 wire/迁移变化。

`goals.list/get` 的读取结果现在包含完整的 `dependencies: [{id,revision}]`。结果出口策略由 `desktop-goal-cloud-projection-v1` 调整为 `desktop-goal-cloud-projection-v2`；后续发布/目录绑定应消费当前精确 Schema。工具名称和版本维持现有公开 Goal 工具约定。

依赖 ID 经过与目标 ID 相同的敏感文本检查；丢失/非法依赖元数据会使整个目标不可投影，不用空数组替代。返回值只包含引用，不含依赖 Fact 正文或 sourceRef。复制依赖列表，外部修改不能影响本地图谱。

仅补齐读取数据不授予写入，也不将主动任务的会话前缀加入通用允许列表。P5 当前修复范围和不确定 RECHECK 必须由 P5 的可信 review/selection/current revision 绑定区分。主动任务写入应消费同一 `cognition.commit_repair` 端口和精确候选，不通过宽泛 goals.create/revise 绕过范围约束。

局部验证：`node --test apps/desktop/test/goal-cloud-dependencies.test.mjs` 两个显式 Fake 检查通过，覆盖 list/get 与结果出口保留准确 refs、返回值隔离，以及不完整/危险 refs 整体拒绝。未调用模型、未写图谱、未执行真实 Goal 修复。
