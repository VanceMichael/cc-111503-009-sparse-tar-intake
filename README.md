# 观测站稀疏归档的逻辑内容与成员领取

Node.js 资料接收项目。保留来源原件的普通成员预览，并提供整批 `collect` 收件入口：按 PAX 与 GNU sparse 1.0 语义取出每个成员真正的逻辑内容和来源范围，区分有效数据与逻辑空洞。项目的用途是让接收方区分“能打开来源”和“已经可靠取得可交付资料”。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证普通成员预览、收件入口、真实来源交互及收件存储。`npm run demo` 启动本地来源，先执行一次普通成员预览，再执行一次真实收件，输出逻辑区间、空洞、来源偏移与证据摘要后自动关闭。`npm run acceptance` 检查收件扩展接口，必须与测试一同通过，不能把检查改成跳过。

Linux 环境可用 `docker build -t sparse-tar-intake:local .` 预装依赖，然后 `docker run --rm --network none sparse-tar-intake:local` 验证底座。`docker run --rm --network none sparse-tar-intake:local npm run demo` 展示真实预览与收件。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。收件演示应在同一环境运行收件检查，不靠预设结果文本代替产品执行。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储。`preview` 只列物理成员，不声称已经完成业务接收；`collect` 只在成员闭合且可靠取得时把记录放进 `records`，并把特殊业务与损坏情况放在 `pending`/`diagnostics`。收件不按归档路径向宿主文件系统解包。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。
