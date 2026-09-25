# 比赛知识链路：公开演示资料

`vault/` 中的内容由本项目为演示新写，全部为虚构示例；不摘录第三方作品、真实人员、账号或私人 Vault。允许在本项目的公开文档与比赛演示中展示。

可信宿主只能显式把 `vault/` 作为只读根目录注入 `knowledge.search`；本目录不会自动注册为生产知识源。当前集成测试使用 Fake Coordination 和注入的 HTTP 响应验证 AgentArts JSON 适配器，不调用真实 AgentArts。公开资料也不代表已授权真实付费云调用。
