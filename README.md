# 观测站稀疏归档的逻辑内容与成员领取

Node.js 资料接收项目。当前版本保留来源原件并提供单次预览，尚未具备整批收件入口。项目的用途是让接收方区分“能打开来源”和“已经可靠取得可交付资料”。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证当前预览、真实来源交互及收件存储。`npm run demo` 启动本地来源，执行一次真实预览，输出取得的内容和证据摘要后自动关闭。`npm run acceptance` 检查收件扩展接口；当前尚无 collect，因此这些检查会明确失败，不属于现有预览的故障。功能交付后，应该同时保留现有测试并通过收件检查，不能把新增检查改成跳过。

Linux 环境可用 `docker build -t sparse-tar-intake:local .` 预装依赖，然后 `docker run --rm --network none sparse-tar-intake:local` 验证底座。`docker run --rm --network none sparse-tar-intake:local npm run demo` 展示真实预览。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。收件功能开发后的演示应在同一环境运行收件检查，不靠预设结果文本代替产品执行。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储，preview 本身不会声称已经完成业务接收。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。
