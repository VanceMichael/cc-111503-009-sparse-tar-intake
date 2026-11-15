# 来源接口与资料语义

支持512字节ustar头、x/g PAX记录及GNU.sparse.major=1/minor=0。PAX记录为十进制字节长度、空格、key=value和LF；g跨成员，x仅下一成员。sparse1.0 map位于成员数据开头，第一行为extent数量，后续offset/length交替十进制行，补齐至512边界；载荷存各extent串接，GNU.sparse.realsize是逻辑大小，GNU.sparse.name为逻辑名。extent必须非负、递增、不重叠且不超逻辑边界。物理header size含map填充和实际载荷。fixture仅普通文件与稀疏文件，无需支持硬链接或设备节点。接收保存在内容地址对象中，不按归档路径写宿主文件。

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
