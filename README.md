# 本地轻量化能碳管理平台

本项目是一个面向本地使用和临时演示的能碳管理平台。默认采用轻量化单机架构：前端通过 Vite 本地运行，后端使用 Node.js + Express，数据存储在本机 SQLite 文件中。平台聚焦表格导入、能耗统计、基础台账、碳排放核算、预测管理和本地备份恢复，不默认引入远程数据库、Redis、微服务或分布式部署能力。

## 完整使用说明书

面向管理员和业务用户的完整安装、权限、导入、台账、核算、预测、备份恢复及故障排查说明，请从 [能碳管理平台使用说明书](docs/使用说明书/README.md) 进入。需要从空隔离库完成青岚智造园区 25 项导入、主动计算和驾驶舱验收时，直接阅读 [项目使用步骤](docs/使用说明书/项目使用步骤.md)。根 README 保留开发启动与临时演示要点，具体业务操作、风险边界和功能覆盖状态以正式使用说明书为准。

## 功能概览

以下仅列出已实现能力的简要分组；模块入口、数据来源、权限和非自动联动边界请查阅正式使用说明书 [第 00 章：侧边栏模块总览与数据链路](docs/使用说明书/00-侧边栏模块总览与数据链路.md)。

- 总览与数据接入：驾驶舱按年度展示真实能耗、已核算碳排和预算预警；数据导入支持普通能耗模板、表格校验、字段映射、批次追溯及错误与警告明细。
- 能源管理：提供能耗统计、月度预算、能源消费分析、能效对标、能流分析以及能效平衡与优化。
- 基础台账：维护组织/用能单元、计量器具、计量抄表、产能单元、月度产量和发电台账。
- 碳与预测：维护碳因子并主动计算排放量，基于本地历史能耗配置和运行轻量预测。
- 系统管理：提供本地用户、角色、菜单和按钮权限管理，以及本机 SQLite 备份的创建、下载、恢复和删除。

## 技术栈与本地数据

- 前端：Vite、本地静态前端，入口位于 `client/`。
- 后端：Node.js + Express，入口位于 `server/src/index.js`。
- 数据库：SQLite 本地文件，默认路径为 `data/energy-carbon.sqlite`。
- 上传文件：默认保存到 `data/uploads/`。
- 备份文件：默认保存到 `data/backups/`。

可用环境变量：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `PORT` | 后端 API 端口 | `3002` |
| `DATA_DIR` | 本地数据根目录 | `data/` |
| `UPLOADS_DIR` | 上传文件目录 | `DATA_DIR/uploads` |
| `BACKUPS_DIR` | 备份文件目录 | `DATA_DIR/backups` |
| `SQLITE_PATH` | SQLite 数据库文件路径 | `DATA_DIR/energy-carbon.sqlite` |
| `CHARCOAL_ADMIN_PASSWORD` | 全新数据库首次初始化或恢复停用的内置管理员时，为内置账号 `admin` 设置的初始密码；至少 8 位 | 无默认值，触发初始化时必须设置 |
| `CORS_ALLOWED_ORIGINS` | 额外允许的前端 Origin，逗号分隔；仅接受合法 `http:` / `https:` 精确 Origin | 空 |
| `VITE_API_BASE_URL` / `VITE_API_BASE` | 前端构建或启动时的默认 API Base；仅接受同源 `/api` 或本机回环 API 地址 | `/api` |

注意：后端 CORS 默认只接受本地来源，例如 `localhost`、`127.0.0.1`、`[::1]`。Cloudflare Quick Tunnel 当前推荐只把 Vite `7777` 暴露为一条公网入口，浏览器使用同源 `/api`，再由 Vite 代理到 Express `3002`；Vite 会把上游 `Origin` 固定为本地开发来源，因此随机 `trycloudflare.com` 域名变化后不需要写入 `CORS_ALLOWED_ORIGINS`，也不需要为此重启后端。`CORS_ALLOWED_ORIGINS` 仅用于绕过 Vite、由浏览器直接跨域访问 Express 的兼容场景，必须填写精确可信的 `http:` / `https:` Origin，禁止使用 `*` 或 wildcard。

## 环境要求

- Node.js 18 或更高版本。
- npm。
- 如需外网临时访问，可另行安装 Cloudflare Tunnel 的 `cloudflared` 或 ngrok。

## 安装依赖

在项目根目录执行：

```bash
npm install
```

## 本地启动方式

本项目的前端和后端需要分别启动。

全新数据库首次启动时，系统会初始化内置管理员账号 `admin`，但不会提供默认密码。启动后端前必须通过环境变量设置至少 8 位的 `CHARCOAL_ADMIN_PASSWORD`；已有可用内置管理员时无需重复设置。PowerShell 示例：

```powershell
$env:CHARCOAL_ADMIN_PASSWORD = "请替换为至少8位的安全密码"
npm run dev:server
```

macOS、Linux 或 Git Bash 示例：

```bash
CHARCOAL_ADMIN_PASSWORD='请替换为至少8位的安全密码' npm run dev:server
```

终端 1：启动后端 API。若已完成管理员初始化，可直接执行：

```bash
npm run dev:server
```

默认监听地址：

```text
http://127.0.0.1:3002
```

终端 2：启动前端页面。

```bash
npm run dev:client
```

默认监听地址：

```text
http://127.0.0.1:7777
```

前端默认 API Base 为：

```text
/api
```

浏览器会把 `/api` 请求发送到当前页面同源地址；本地开发时由 Vite 代理到 `http://127.0.0.1:3002`。也可以在浏览器地址后显式指定同源值：

```text
http://127.0.0.1:7777/?apiBase=%2Fapi
```

前端只接受同源 `/api` 或本机回环 API 地址，并会把可信值写入浏览器 `localStorage`。如需恢复默认值，可在页面的 API Base 输入框中改回 `/api`，或清理浏览器站点数据。

## 常用访问地址

| 用途 | 地址 |
| --- | --- |
| 前端页面 | `http://127.0.0.1:7777/` |
| API 根信息 | `http://127.0.0.1:3002/api/` |
| API 健康检查 | `http://127.0.0.1:3002/api/health` |
| API 启动信息 | `http://127.0.0.1:3002/api/bootstrap` |
| API 元信息 | `http://127.0.0.1:3002/api/meta` |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev:server` | 启动 Node.js + Express 后端 |
| `npm run dev:client` | 启动 Vite 前端，监听 `127.0.0.1:7777` |
| `npm run test:logic` | 运行纯逻辑测试 |
| `npm run verify:special` | 运行特殊场景验证脚本 |
| `npm run audit:summary` | 运行审计摘要脚本 |
| `npm run check` | 对前后端和脚本执行 Node.js 语法检查 |

## 基本使用流程

1. 执行 `npm install` 安装依赖；全新库启动前设置至少 8 位的 `CHARCOAL_ADMIN_PASSWORD`。
2. 分别执行 `npm run dev:server` 和 `npm run dev:client`，打开 `http://127.0.0.1:7777/`。
3. 日常业务操作按 [正式使用说明书](docs/使用说明书/README.md) 选择对应章节。
4. 首次演示或完整验收必须使用隔离 `DATA_DIR`，并按 [青岚智造园区项目使用步骤](docs/使用说明书/项目使用步骤.md) 执行备份、25 项领域导入、主动计算和最终验收。
5. 不要把所有文件交给通用导入中心：每个模板必须进入对应领域页面；普通能耗支持 `.xlsx/.xls/.csv`，新式单表受控导入通常只支持 `.xlsx/.csv`，多工作表只支持 `.xlsx`。

## 使用 Cloudflare Tunnel 进行外网访问

### 适用场景

Cloudflare Tunnel 适合临时给同事或设备体验本地页面，也可以在拥有 Cloudflare 域名时配置同一个公网域名按路径转发前端和后端。

当前项目已有本地登录、RBAC 权限和审计边界，但 Cloudflare Tunnel 不会额外提供生产级 HTTPS 终止治理、公网访问控制或安全防护。请只在可信、短期、脱敏的隔离环境中演示，不要把包含真实企业能耗、碳因子、备份恢复等敏感数据或管理能力的本地实例直接暴露到公网。

### 前置步骤

先在本机启动后端和前端：

```bash
npm run dev:server
npm run dev:client
```

### 推荐的 Quick Tunnel 完整临时体验方式

只启动一条指向 Vite `7777` 的 Quick Tunnel：

```bash
cloudflared tunnel --url http://127.0.0.1:7777 --http-host-header 127.0.0.1:7777
```

Vite 会接收公网页面及其同源 `/api` 请求，并把 `/api` 代理到本机 Express `3002`。正式分享入口使用：

```text
https://<随机域名>.trycloudflare.com/?apiBase=%2Fapi
```

不要把 `/login?redirect=?apiBase=%252Fapi` 当作分享入口。`%252F` 可能出现在合法的嵌套 URL 编码中，但该示例的 `redirect` 解码后缺少前导 `/`，登录逻辑会按安全规则回退到 `/`；应直接从根入口传入顶层 `apiBase=%2Fapi`。

该单隧道链路不需要把每次随机生成的公网 Origin 写入 `CORS_ALLOWED_ORIGINS`。停止并重新启动 `cloudflared` 获得新域名后，只需更新分享链接，Vite 和 Express 可保持运行，后端不需要重启。以上命令、链路说明和分享入口就是 Quick Tunnel 的必需核心步骤，不依赖克隆后可能不存在的本地补充文档。

### 固定域名的同源路径转发

如果你有 Cloudflare 管理的域名，也可以使用命名隧道，把同一个域名的 `/api/*` 转发到后端，其余路径转发到前端。示例配置：

```yaml
tunnel: energy-carbon-demo
credentials-file: C:\Users\<你的用户名>\.cloudflared\<tunnel-id>.json

ingress:
  - hostname: energy.example.com
    path: /api/*
    service: http://127.0.0.1:3002
  - hostname: energy.example.com
    service: http://127.0.0.1:7777
  - service: http_status:404
```

常用命令示例：

```bash
cloudflared tunnel login
cloudflared tunnel create energy-carbon-demo
cloudflared tunnel route dns energy-carbon-demo energy.example.com
cloudflared tunnel run energy-carbon-demo
```

访问时使用同一个域名，并把 API Base 指向同域名下的 `/api`：

```text
https://energy.example.com/?apiBase=%2Fapi
```

这样前端页面和 API 处于同一公网来源，可避免双随机隧道带来的跨域配置复杂度。

### 生产部署提醒

Cloudflare Tunnel 可以降低临时访问门槛，但不等于生产部署方案。若要长期对外提供服务，应至少补齐身份认证、访问控制、备份策略、HTTPS/域名治理、日志审计、数据脱敏和反向代理安全配置，并评估是否需要从本地 SQLite 升级到更适合多人并发和灾备的架构。

## 使用 ngrok 进行外网访问

### 前置步骤

1. 安装 ngrok 并完成账号登录。
2. 在本机启动后端和前端：

```bash
npm run dev:server
npm run dev:client
```

### 临时只展示前端

```bash
ngrok http 7777
```

命令会输出一个 `https://*.ngrok-free.app` 或你的 ngrok 域名。该方式主要用于查看前端页面。远端浏览器默认无法访问你本机的 `127.0.0.1:3002` 后端。

如果再单独执行 `ngrok http 3002` 暴露后端，并把页面 `apiBase` 指向后端 ngrok 地址，浏览器会因为前端域名和 API 域名不同而触发跨域校验。只有将前端 ngrok Origin 精确配置到后端 `CORS_ALLOWED_ORIGINS` 后，才适合可信短期演示；当前项目不会面向任意公网 Origin 自动开放 CORS。

### 完整体验方式

ngrok 的完整外网体验同样建议走“单一公网来源”：先用反向代理把前端和后端合并到同一个本地端口，再用 ngrok 暴露该端口。路径规则应保持：

- `/api/*` 转发到 `http://127.0.0.1:3002`
- 其他路径转发到 `http://127.0.0.1:7777`

例如你已用本地反向代理合并到 `http://127.0.0.1:8080` 后，可执行：

```bash
ngrok http 8080
```

然后用 ngrok 输出的公网地址访问：

```text
https://<你的-ngrok-域名>/?apiBase=%2Fapi
```

如果需要长期稳定地址，请使用 ngrok 静态域名或边缘路由能力，并配合访问控制。不要把没有鉴权的备份恢复、数据导入和台账管理能力直接暴露到公开互联网。

## 安全注意事项

- 本项目默认是本地轻量化单机平台，不是开箱即用的公网生产系统。
- 不要在公网临时隧道中上传真实敏感能耗、组织、计量器具、碳因子或备份文件。
- 不要把“系统/备份恢复”能力暴露给不可信访问者；恢复操作会替换当前本地 SQLite 数据库。
- 外网演示前建议使用脱敏数据或临时数据库，并单独设置 `DATA_DIR` 指向演示目录。
- 演示结束后及时停止 `cloudflared` 或 `ngrok` 进程。
- 如需对外长期使用，请先补充认证、授权、日志审计、访问白名单、备份治理和运维监控。

## 常见问题与排查

### 前端提示无法连接本地 API

1. 确认后端已启动：`npm run dev:server`。
2. 访问 `http://127.0.0.1:3002/api/health`，确认返回成功。
3. 检查前端页面的 API Base 是否为 `/api`，或是否被 URL 参数、浏览器 `localStorage` 改成了旧地址。

### 端口被占用

- 后端默认使用 `3002`，可通过 `PORT` 调整。
- 前端命令固定使用 `127.0.0.1:7777`，如需更换端口，需要调整 `package.json` 中的 `dev:client` 脚本。

### 外网地址能打开页面，但数据加载失败

Quick Tunnel 场景先确认分享链接使用 `/?apiBase=%2Fapi`，并确认 Vite `7777` 与 Express `3002` 都仍在运行。浏览器只访问一条指向 Vite 的公网隧道，同源 `/api` 由 Vite 代理到 Express；不需要为随机域名配置 `CORS_ALLOWED_ORIGINS`。只有绕过 Vite、让浏览器直接跨域访问 Express 时，才需要把调用页面的精确可信 Origin 写入该环境变量，且禁止 wildcard。

### 导入失败或出现警告

1. 优先下载系统提供的 Excel 模板。
2. 检查月份是否可标准化为 `YYYY-MM`。
3. 检查能源类型、单位和数值是否符合模板说明。
4. 在导入批次中查看错误明细和 warning，按行号修正后重新导入。

### SQLite 数据或备份在哪里

默认在项目根目录下的 `data/` 中：

- 数据库：`data/energy-carbon.sqlite`
- 上传文件：`data/uploads/`
- 备份文件：`data/backups/`

如果设置了 `DATA_DIR`、`SQLITE_PATH`、`UPLOADS_DIR` 或 `BACKUPS_DIR`，请以环境变量指向的位置为准。

### 想重置演示数据

先停止前后端服务，备份或移动当前 `data/` 目录，再重新启动后端。后端启动时会初始化本地数据目录和 SQLite 数据库。请谨慎操作，避免误删真实数据。
