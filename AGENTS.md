# 大屏项目维护入口

开始修改前，请完整阅读根目录 [.agent](.agent)，其中说明前端、Node 网关、Java 后端、管理后台和工人 App 的职责与接口关系。

运行文件直接位于 `public/`；不存在管理后台的 `src → public/src` 同步步骤。修改后执行 `npm test`，通过本地 HTTP 服务验证相关流程。
