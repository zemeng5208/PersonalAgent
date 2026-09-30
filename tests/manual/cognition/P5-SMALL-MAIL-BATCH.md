# 同单例 Laya：小型邮件分页验收准备

仅准备，未执行。Goal 真实验收优先；P8 在同一个已 ready 的 owned Laya 模型槽顺带执行此批次，不新建 host、不 start/stop 模型、不安装、不联网 QQ、不发送云。

`mail-batch-small.json` 是 8 条不同、非空的公开合成信头，没有私人账号或正文。它们涵盖会议变动、工程、订阅、订单、个人交流和不明主题；不固定模型应选标签，不改变 description/阈值，不为 uncertain 制造成功。`.invalid` 地址不会用于网络。生产 `ConnectorItem.sensitivity` 仍由邮件契约标为 private，这不是把合成素材当真实私信。

## 已存在的复用入口

- P8 的 `localLaya.classify(request)` → Runtime `createLocalInboxClassifier` → `LocalLayaBatchHttpTransport` / `LayaTriageService`，实际政策已是 multi_state、chunk4、probability 0.70、margin 0.15。
- 正式 `createInboxTriagePipeline` 公开消费该 classify 端口，用同一已有加密 `StoragePort` 保存 metadata/receipt/classifier fingerprint/分页游标。每完成一个 chunk 保存记录，整页有未完成分类不推进游标。
- 原 `p5-local-laya.mjs` 的透明计数和计时思路可复用；该文件直接运行会启动 host 和旧 24 条吞吐/设备场景，不能 import 或整段重跑。`MailTriagePipeline.processPagedStream` 是既有 P5 域入口；本轮优先使用 P8 正式 Runtime `processPage/readCursor/snapshot`，免于把旧域缓存当生产分页证明。
- `@personal-agent/mail` 已公开 `messageToItem`，按现有逻辑转换上述信头，不另写私有解析器、Fake Laya 或第二套 pipeline。

```js
const fetchedAt=new Date().toISOString();
const items=fixture.messages.map(message=>messageToItem(message,fixture.accountRef,fetchedAt));
const first={accountRef:fixture.accountRef,folder:'INBOX',nextCursor:'1:4',hasMore:true,items:items.slice(0,4)};
const second={accountRef:fixture.accountRef,folder:'INBOX',cursor:'1:4',nextCursor:'1:8',hasMore:false,items:items.slice(4)};
// 各 processPage 调用由当前隔离会话附加真实 signal/deadline。
```

使用一个全新隔离 metadata namespace/缓存目录，初始 summary.total=0、readCursor=undefined。使用 P8 现有 labels/meetingLabels；getClassifierFingerprint 原样复用真实 loaded artifact identity + LOCAL_INBOX_CLASSIFIER_FINGERPRINT 的既有组合。重建必须沿用同目录、namespace、labels 和同一个 loaded host/fingerprint。不能以固定字符串替代当前 identity。

## 一次批次与暂停恢复

1. 透明 classify wrapper 只记录调用开始/结束的 `performance.now()`、实际请求 messageId/sourceRevision/非空数和返回结果，不改请求或结果。它仍调用相同 `localLaya.classify`。第一页实际返回、持久读回后记录 processPage 的 classified/reused/complete/cursorAdvanced 与 snapshot，保存首 4 个真实 receiptId。
2. 第一页完整时 readCursor 应为 `1:4`。在页边界撤销或暂停当前隔离处理许可；以已取消 signal 请求第二页，应实际返回 CANCELLED 且 classify 调用计数不增加、游标仍 `1:4`。这是页边界暂停，未验证强行中止正在运行的 Torch 前向。
3. 重建同一 metadata storage/pipeline，关闭或释放旧隔离实例，沿用同一个透明 wrapper 和真实 classifier identity。先回放同一第一页：classified=0、reused=4、receiptId 逐条相同、classify 计数不增加、游标不回退；缺稳定 identity 或未完成记录时如实记失败，不手写缓存。
4. 当前新许可下处理第二页：仅剩 4 条进入真实推理。完整时 readCursor=`1:8`、snapshot.total=8，首 4 条 receiptId 保持，第二页 4 条有独立真实 receipt。若出现 unavailable/invalid_response/deadline/cancelled，保存真实 reason 与游标，不刷重试来制造完整。

两个新分类页共 8 个不同非空输入；预期正常时各一个 multi_state chunk，但以实际请求/返回记录为准。暂停与缓存回放不计入新推理吞吐。若要证明页内 partial checkpoint 的真实恢复，还需另一个明确受控的真实中断场景；本小批次不据页边界暂停宣称该项已验收。

## 必须保存的读回

- 准确集成 head、真实 loaded model identity、现有策略指纹、labels/阈值/batching，以及统一槽的起止时间。
- 每次真实 classify：输入数、不同 messageId/sourceRevision、`batching`、label/candidateLabel/route/reason/abstained、scores.answerConfidence/margin/entropyConcentration、impactScores 和真实 receiptId；SDK confidence 不是校准正确率，保留 calibrated=false。
- 每页真实 classify 调用 wall duration 与 processPage 总 wall duration。公开 classify 耗时包含本地 HTTP、模型与响应校验，不能说成单独 Torch CPU 前向计时；没有服务端精确计时就不填该值。
- 实际新推理输入数、有效结果数、自动分类数、uncertain/needsReview/highImpact 数分别记录。needsReview 从正式 snapshot 读；不可只按 label 非空推成自动安全分类。失败请求的 attempted 数另记，不能冒充已分类。
- 吞吐只用实际新推理非空输入 / 同批次真实 classify wall 时间，并同时给有效结果数。缓存、空白、旧记录、暂停、health、reopen 和人为等待从该分子/分母剔除；整体场景耗时另列。
- storage 持久读回的游标、各页 classified/reused/complete、取消错误、重建前后 receiptId/总数、透明计数未增加的回放证据。只在项目 ignored cache 保存，不记录 Key、私人数据或原始 HTTP。

此样本只提供 8 条合成信头的真实数据，不能线性声称千封在极短时间完成，也不证明 QQ/用户邮箱/实际 UI 已验收。性能差时先交准确数据给根/P8，按真实瓶颈另做可逆优化，保持 0.70/0.15 和真实 Laya。
