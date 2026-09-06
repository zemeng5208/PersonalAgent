# 授权策略（MOD-05）

`@personal-agent/policy` 提供任务级内存授权策略。授权绑定 `authorizationRef`、任务、工具、scope、到期时间和可选使用次数；支持立即撤销。工具调用方不能把自报 scope 当作授权。

当前实现是 MOD-05 的最小可验证切片：授权不持久化，重启后失效；只支持绑定单个任务和工具的授权，不代表 PA-023 的持续授权管理已经完成。生产 Runtime 后续负责生成不可预测的授权引用并将授权决策持久化。

验证：

```sh
npm run build --workspace=@personal-agent/policy
npm run test --workspace=@personal-agent/policy
```
