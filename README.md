# 丰浩大屏端

独立运行的施工安全问答、扫码个人学习和项目培训视频终端。首页默认显示安全问答，用户点击“开始聆听”才使用麦克风；右上方提供“扫码学习”和“视频播放”。

## 本地启动

安装 Node.js 22 或更新版本，然后执行：

```sh
npm ci
cp .env.example .env
npm start
```

编辑 `.env` 配置后端地址和火山引擎凭证。使用管理员签发的 `http://127.0.0.1:4173/screen.html#token=...` 链接并点击“开始使用”；根地址显示授权入口。请通过 HTTP 服务访问，勿直接双击 HTML 文件。

问答需要 `VOLC_BOT_ID`、`VOLC_API_KEY`；语音还需要 `VOLC_SPEECH_APP_ID`、`VOLC_SPEECH_ACCESS_TOKEN` 及账号已开通的识别服务和音色。配置为空时能展示界面，但不能完成真实问答/语音。

扫码学习和视频资料来自独立的 `fenghao-backend` Java 服务，默认 http://127.0.0.1:8080 。在后端仓库执行：

```sh
mvn -DskipTests package
java -jar target/fenghao-safety-1.0.0.jar --spring.profiles.active=local
```

该配置使用后端 `data/` 中的持久化本地数据库。本仓库不包含 Java 后端、数据库或后台管理页面。

访问 token 不绑定电脑，首批每个 200 次，由后端记录成功开启次数。每次会话有效 24 小时，微信预览与同会话刷新不扣次；开启结果未知时保留同一 requestId 重试。#token 片段保留，方便从微信转发到其他电脑；sessionStorage 仅保存当前页面会话的恢复信息。旧 deviceId/deviceToken 链接兼容原学习流程，但问答与语音只接受有效 token 会话。视频入口仍要求项目管理员登录。

## 配置与部署

配置项见 [.env.example](.env.example)。环境变量优先于项目 `.env`；也可使用 `FENGHAO_ASSISTANT_ENV` 指定服务器上的配置文件。端口和后端地址也支持从 `.env` 读取。修改服务端配置后需重启。

默认仅监听本机。部署到大屏设备时可设 `FENGHAO_MANAGEMENT_HOST=0.0.0.0`，并配置 HTTPS 反向代理；麦克风要求 localhost 或 HTTPS，代理需支持 `/ws/voice` WebSocket 和问答 SSE 流式传输。浏览器只连接此服务，云端凭证留在 Node 进程。

## 验证与维护

```sh
npm test
curl http://127.0.0.1:4173/api/v1/assistant/status
```

完整应用关系、接口归属、状态与修改规范见 [.agent](.agent)。开发代理入口见 [AGENTS.md](AGENTS.md)。角色视频已经按约 1.3 倍速处理，请勿重复加速。当前视频是循环动作，不是真实逐字对口型。

拆分来源：`fenghao-frontend/management` 当前工作区（2026-09-06）。仅复制大屏必要运行文件，原后台仓库不受本次拆分影响。
