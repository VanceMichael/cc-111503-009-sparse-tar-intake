# 来源接口与资料语义

支持512字节ustar头、x/g PAX记录及GNU.sparse.major=1/minor=0。PAX记录为十进制字节长度、空格、key=value和LF；g跨成员，x仅下一成员。同一成员可被多个x头覆盖，后出现的记录优先；值为空的记录删除继承自g的属性。PAX `path`、`size`（物理大小）和`GNU.sparse.realsize`可覆盖原始头部字段。sparse1.0 map位于成员数据开头，第一行为extent数量，后续offset/length交替十进制行，补齐至512边界；载荷存各extent串接，GNU.sparse.realsize是逻辑大小，GNU.sparse.name为逻辑名。extent必须非负、递增、不重叠且不超逻辑边界。物理header size含map填充和实际载荷。fixture仅普通文件与稀疏文件，无需支持硬链接或设备节点。接收保存在内容地址对象中，不按归档路径写宿主文件。

## 收件器扩展接口

现有 `src/intake.mjs` 导出 `preview(source, store)`，只做预览。收件器入口为新增的 `collect(source, store)`，由调用方负责创建和关闭来源及 Inbox。`npm run acceptance` 调用这一入口。返回的 `records` 是可正式交付资料，不把未确认片段放进该集合；特殊业务的 pending 和 diagnostics 独立返回。原始证据通过 Inbox 保存，正式记录应含证据引用。接口不规定内部架构，允许增加模块和持久表，但不能移除原预览或更改来源语义。

## 可观察边界

- 两段extent之间和末尾的逻辑空洞
- PAX中文路径的字节长度
- g属性与下一成员x覆盖
- 同路径多次出现不覆盖原件
- 重叠/越界map及物理载荷截断

## 公开的结果字段

`acceptance/collection.test.mjs` 给出当前集成方使用的结果字段及最小示例，说明的是输出契约而非内部处理步骤。除这些示例外，以上来源语义也属于功能范围，不能靠场景名称分支返回固定答案。`status` 仅在对应资料闭合且可靠取得时为 complete。

## collect 的结果与证据

除验收示例字段外，`collect` 还返回：

- `mode`：固定为 `logical-sparse-collection`，与 `preview` 的 `physical-member-preview` 区分。
- `packageSha256` / `packageSize` / `package.evidence`：物理包摘要。它覆盖来源交付的全部字节（含补齐和归档结束块），与任何成员的逻辑摘要互不替代。
- 每条记录：`order`（归档顺序，从 0 起）、`path`、`headerOffset`、`dataOffset`、`type`、`sparse`、`physicalSize`、`mapSize`、`storedSize`（实际有数据的字节数，不含空洞）、`logicalSize`、`logicalSha256`、`physicalSha256`（成员物理头+map+载荷）、`headerSha256`、`attributes`（生效后的 PAX 属性）。
- `extents`：每段 `offset`/`length`（逻辑区间）、`sourceOffset`（包内绝对偏移）、`sha256`，以及按 256 KiB 分块的 `chunks`（`logicalOffset`/`length`/`sourceOffset`/`sha256`/`evidence`）。分块保证单次分配有界，长 extent 不会被整块读入内存。
- `holes`：只列空洞区间 `offset`/`length`，不复制零字节；`layout` 按逻辑顺序交错给出 `hole` 与 `extent`，可直接看出哪些逻辑区间有到手数据。
- `evidence`：`package`、`header`、`extendedHeaders`、`map`、`extents` 各项 Inbox 证据 id；原始 tar 头按原始偏移逐块保存，重复路径的每次出现都有各自的头和偏移。

异常处理：map 重叠/逆序/越界/非十进制、map 填充含非零字节、物理载荷与 extent 总长不符、PAX 记录损坏、头部校验和错误都使 `status` 为 `incomplete`，相关成员不进入 `records`。`pending` 给出原因代码与上下文；载荷截断时还会给出已读到的逻辑分块 `received` 和缺失的物理区间 `missing`（不会把未取得的部分补零当成完整资料）。`diagnostics` 为人类可读说明。逻辑摘要按“空洞即零字节”对逻辑内容计算，仅当成员完整闭合时才输出。
