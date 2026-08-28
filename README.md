# 本地轻量化能碳管理平台

本项目是一个面向本地使用和临时演示的能碳管理平台。默认采用轻量化单机架构：前端通过 Vite 本地运行，后端使用 Node.js + Express，数据存储在本机 SQLite 文件中。平台聚焦表格导入、能耗统计、基础台账、碳排放核算、预测管理和本地备份恢复，不默认引入远程数据库、Redis、微服务或分布式部署能力。

## 完整使用说明书

面向管理员和业务用户的完整安装、权限、导入、台账、核算、预测、备份恢复及故障排查说明，请从 [能碳管理平台使用说明书](docs/使用说明书/README.md) 进入。需要从空隔离库按当前 29 项 manifest 完成导入、主动计算和中控验收时，直接阅读 [项目使用步骤](docs/使用说明书/项目使用步骤.md)。根 README 保留开发启动与临时演示要点，具体业务操作、风险边界和功能覆盖状态以正式使用说明书为准。

## 功能概览

以下仅列出已实现能力的简要分组；模块入口、数据来源、权限和非自动联动边界请查阅正式使用说明书 [第 00 章：侧边栏模块总览与数据链路](docs/使用说明书/00-侧边栏模块总览与数据链路.md)。

- 总览与数据接入：中控按年度展示真实能耗、已核算碳排和预算预警；数据导入支持普通能耗模板、表格校验、字段映射、批次追溯及错误与警告明细。
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

| 变量 | 作用 | 默认值或边界 |
| --- | --- | --- |
| `PORT` | 后端 API 端口，并同步决定 Vite `/api` 代理目标 | 空白时 `3002`；只接受 1—65535 的十进制整数 |
| `DATA_DIR` | 本地数据根目录 | `data/` |
| `UPLOADS_DIR` | 上传文件目录 | `DATA_DIR/uploads` |
| `BACKUPS_DIR` | 备份文件目录 | `DATA_DIR/backups` |
| `SQLITE_PATH` | SQLite 数据库文件路径 | `DATA_DIR/energy-carbon.sqlite` |
| `CHARCOAL_ADMIN_PASSWORD` | 仅在全新数据库首次创建或恢复 inactive 内置 `admin` 时使用；至少 8 位 | 无默认值，触发对应路径时必须设置 |
| `CORS_ALLOWED_ORIGINS` | 额外允许的前端 Origin，逗号分隔；仅接受合法 `http:` / `https:` 精确 Origin | 空 |
| `VITE_API_BASE_URL` / `VITE_API_BASE` | 前端默认 API Base；Tunnel 模式下两个兼容变量均强制为同源 `/api` | `/api` |
| `CLOUDFLARED_BIN` | 官方 `cloudflared` 可执行文件的完整绝对路径 | 必须填写完整绝对路径，或留空从 PATH 查找；非绝对路径会在服务启动前失败且不回退 PATH |
| `TUNNEL_TRANSPORT_PROTOCOL` | Quick Tunnel 传输协议 | 官方值仅允许 `auto`、`quic`、`http2`；模板默认 `auto`，UDP/QUIC 不稳定的本机可改为 `http2`；启动器始终显式传入 `--protocol` |

项目会自动加载根 `.env`。首次配置请从 `.env.example` 复制并只在本机维护；真实 `.env` 已忽略，不得提交。配置优先级为“终端/系统已有环境变量 > 根 `.env` > 默认值”，已有进程环境不会被 `.env` 覆盖。

注意：active `admin` 不会因 `CHARCOAL_ADMIN_PASSWORD` 变化而自动轮换密码；需要改密时使用平台密码修改或重置流程。不要分享管理员明文密码。

后端 CORS 默认只接受本地来源，例如 `localhost`、`127.0.0.1`、`[::1]`。Cloudflare Quick Tunnel 只把 Vite `7777` 暴露为一条公网入口，浏览器使用同源 `/api`，再由 Vite 代理到当前 `PORT` 的 Express；随机 `trycloudflare.com` 域名不需要写入 `CORS_ALLOWED_ORIGINS`。`CORS_ALLOWED_ORIGINS` 仅用于绕过 Vite、由浏览器直接跨域访问 Express 的兼容场景，必须填写精确可信的 `http:` / `https:` Origin，禁止使用 `*` 或 wildcard。

## 环境要求

- Node.js 18 或更高版本。
- npm。
- 如需一键 Cloudflare 临时外网访问，用户需从 Cloudflare 官方渠道预安装官方 `cloudflared`，并确保 PATH 可发现，或将 `CLOUDFLARED_BIN` 设置为可执行文件的完整绝对路径；项目不会自动下载。非绝对路径会在服务启动前失败且不回退 PATH。

## 安装依赖

在项目根目录执行：

```bash
npm install
```

## 本地启动方式

先复制根环境模板并在本机维护：

```powershell
Copy-Item .env.example .env
```

项目会自动读取根 `.env`。全新数据库首次创建或恢复 inactive 内置管理员时，必须填写至少 8 位的 `CHARCOAL_ADMIN_PASSWORD`；留空会使初始化失败。用户名固定为 `admin`。已有 active `admin` 时，环境密码变化不会自动改密。

本地排障时，前端和后端分别启动。

终端 1：启动后端 API：

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

浏览器会把 `/api` 请求发送到当前页面同源地址；本地开发时由 Vite 代理到 `http://127.0.0.1:<PORT>`。Vite 代理目标会与后端 PORT 自动同步；Vite 自身仍固定监听 `127.0.0.1:7777` 且启用 `strictPort`，端口占用时不会静默切换。也可以在浏览器地址后显式指定同源值：

```text
http://127.0.0.1:7777/?apiBase=%2Fapi
```

前端只接受同源 `/api` 或本机回环 API 地址。URL 中的 `apiBase` 参数只覆盖本次页面初始化，不会自动写入浏览器 `localStorage`；它在本次初始化时优先于浏览器已保存值。只有通过顶部导航栏的 API Base 配置入口显式保存可信值，才会持久化到 `localStorage`。因此带 `?apiBase=%2Fapi` 的分享 URL 可以确保本次初始化使用 `/api`，但后续访问不带参数的地址时，仍可能恢复此前显式保存的值。如需让后续无参数访问也使用默认值，应在页面配置入口显式保存 `/api`，或清理浏览器站点数据。

Vite 开发服务器启用严格文件服务边界：`server.fs.strict=true`，`server.fs.allow` 只允许 `client/` 与项目根 `node_modules/`。项目根、`data/`、真实 `.env`、SQLite、上传和备份等其他路径不得通过 `/@fs/` 读取；`/__open-in-editor` 被固定拦截为 HTTP 404，且不得触发本机编辑器。该边界降低临时开发分享风险，但 Vite 仍是开发服务器，不等同生产部署；本地或公网演示仍必须使用隔离、脱敏数据。

相关自动测试通过纯配置工厂、注入式环境对象、系统临时环境文件和隔离 SQLite 验证，不读取开发者真实根 `.env`，也不以真实业务 SQLite 作为安全探针。真实浏览器和公网结果仍按手工测试执行。

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
| `npm run dev:server` | 启动 Node.js + Express 后端；保留为本地排障入口 |
| `npm run dev:client` | 启动 Vite 前端，固定监听 `127.0.0.1:7777`；保留为本地排障入口 |
| `npm run dev:cloudflare` | 统一启动 Express、Vite 和一条指向 Vite 的官方 Cloudflare Quick Tunnel |
| `npm run test:logic` | 运行纯逻辑测试 |
| `npm run verify:special` | 运行特殊场景验证脚本 |
| `npm run audit:summary` | 运行审计摘要脚本 |
| `npm run check` | 对前后端和脚本执行 Node.js 语法检查 |

## 基本使用流程

1. 执行 `npm install`，从 `.env.example` 复制根 `.env`；全新库首次创建或 inactive 管理员恢复前填写至少 8 位的 `CHARCOAL_ADMIN_PASSWORD`。
2. 本地排障分别执行 `npm run dev:server` 和 `npm run dev:client`，打开 `http://127.0.0.1:7777/`；临时公网演示使用 `npm run dev:cloudflare`。
3. 日常业务操作按 [正式使用说明书](docs/使用说明书/README.md) 选择对应章节。
4. 首次演示或完整验收必须使用隔离 `DATA_DIR`，并按 [天坤集团项目使用步骤](docs/使用说明书/项目使用步骤.md) 执行当前 29 项领域导入、主动计算和最终验收。
5. 不要把所有文件交给通用导入中心：每个模板必须进入对应领域页面；普通能耗支持 `.xlsx/.xls/.csv`，新式单表受控导入通常只支持 `.xlsx/.csv`，多工作表只支持 `.xlsx`。

## 使用 Cloudflare Tunnel 进行外网访问

### 适用场景

Cloudflare Tunnel 适合临时给同事或设备体验本地页面，也可以在拥有 Cloudflare 域名时配置同一个公网域名按路径转发前端和后端。

当前项目已有本地登录、RBAC 权限和审计边界，但 Cloudflare Tunnel 不会额外提供生产级 HTTPS 终止治理、公网访问控制或安全防护。请只在可信、短期、脱敏的隔离环境中演示，不要把包含真实企业能耗、碳因子、备份恢复等敏感数据或管理能力的本地实例直接暴露到公网。

用户指定的 `https://higher-things-strongly-decent.trycloudflare.com/?apiBase=%2Fapi` 不能由当前 Quick Tunnel 命令固定、保留或保证下一次启动仍指向本机。该地址只能在 Cloudflare 当次实际将流量路由到对应 Tunnel 时有效；启动器不会把它冒充为当前启动结果。

### 前置步骤

1. 从 `.env.example` 复制并维护本机 `.env`，使用隔离、脱敏的数据目录。
2. 用户从 Cloudflare 官方渠道预安装官方 `cloudflared`；确保 PATH 可发现，或把 `CLOUDFLARED_BIN` 设置为完整绝对路径。项目不会自动下载；非绝对路径会在服务启动前失败且不回退 PATH。
3. `TUNNEL_TRANSPORT_PROTOCOL` 只允许 `auto`、`quic`、`http2`；模板默认 `auto`，当前网络的 UDP/QUIC 不稳定时可仅在本机 `.env` 改为 `http2`。
4. 如本机默认配置候选中存在 `config.yml` / `config.yaml`，启动器会在服务启动前失败，只检查存在性，不读取或修改文件。

### 推荐的一键 Quick Tunnel 方式

在项目根的单个终端执行：

```bash
npm run dev:cloudflare
```

命令会统一启动 Express、Vite 和唯一一条指向 Vite `7777` 的 Quick Tunnel。`PORT` 会同时决定 Express 端口和 Vite `/api` 代理目标；Tunnel 模式强制 `VITE_API_BASE_URL`、`VITE_API_BASE` 为同源 `/api`，Host 仍固定为 `127.0.0.1`，Vite 仍固定使用 7777 `strictPort`。启动器始终显式传入配置后的 `--protocol auto|quic|http2`。

首次真实 Tunnel 前，不要直接执行一键命令。先只启动本地 Express/Vite，按第 13 章使用非敏感样本确认页面和同源 `/api/health` 为 2xx、项目根与 `data/` 的 `/@fs/` 探测为 403、`/__open-in-editor` 为 404 且不触发编辑器；任一安全探测出现 2xx 时禁止启动 Tunnel。只有本地安全预检通过后才运行一键命令；公网阶段还要使用与本机无关的固定合成绝对路径重复 403/404 验证，禁止发送 URI 编码后仍可逆的真实项目根或 editor 文件路径。

cloudflared 原始日志可能提前出现随机域名，但域名分配不代表分享链路已经可用。启动器严格按“发现合法 Quick Tunnel Origin（最多 60 秒）→ 回环 metrics `/ready` 返回 HTTP 200（最多 90 秒）→ 公网 `/api/health` 满足健康 JSON 契约（最多 90 秒）”串行判断，每次请求最多 3 秒；只有三阶段全部成功后才打印以下带 `[share]` 前缀的就绪信息：

```text
[share] 公网 Origin：https://<随机域名>.trycloudflare.com
[share] 完整分享 URL：https://<随机域名>.trycloudflare.com/?apiBase=%2Fapi
[share] 公网健康地址：https://<随机域名>.trycloudflare.com/api/health
[share] 公网链路已就绪
```

正式分享只使用 `[share] 完整分享 URL`，不得复制此前 cloudflared 原始日志中的随机域名。Quick Tunnel URL 随机且重启后会变化，不落盘保存，也不支持指定或保留某个 `trycloudflare.com` 子域名；把历史地址硬编码到启动器输出、浏览器打开逻辑或环境变量，不会让 Cloudflare 将该地址重新路由到当前进程。不要启动第二条 API Tunnel，不要把公网绝对地址写入 API Base、CORS 或长期配置。停止时启动器按 Tunnel → Vite → Express 清理，只处理自己拥有的 PID；不按名称或端口杀未知进程，也不承诺 SIGKILL、断电或系统崩溃时完成清理。

`npm run dev:server` 与 `npm run dev:client` 保留为本地排障和 Tunnel 前安全预检入口。当前开发机已安装并真实运行官方 cloudflared 2026.8.2：本地 Express、Vite 和同源代理已通过，但首次公网 `/api/health` 最终超时并触发清理；本轮可靠性与 Vite 公网安全边界修复后的下一节点是用户先完成本地 403/404 安全预检，只有通过后才进行真实 Tunnel 复测。不得写成公网链路已经通过。完整配置、分阶段诊断和手工验收见[第 13 章](docs/使用说明书/13-临时外网访问.md)、[第 14 章](docs/使用说明书/14-限制风险与故障排查.md)和[Cloudflare 一键手册](docs/Cloudflare临时外网访问手册.md)。

### 命名隧道与固定域名（不属于一键 Quick Tunnel）

如果你有 Cloudflare 管理的域名，也可以另行设计命名隧道，把同一个域名的 `/api/*` 转发到后端，其余路径转发到前端。固定入口必须使用该自有 Zone 下的主机名；`cloudflared --hostname` 不能为当前无账号 Quick Tunnel 保留指定的 `trycloudflare.com` 子域名。该方案不由 `npm run dev:cloudflare` 创建或管理，不得把下列示例视为当前一键入口的自动配置。示例配置：

```yaml
tunnel: energy-carbon-demo
credentials-file: C:\Users\<你的用户名>\.cloudflared\<tunnel-id>.json

ingress:
  - hostname: energy.example.com
    path: /api/*
    service: http://127.0.0.1:<PORT>
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

这样前端页面和 API 使用同一个公网来源，可避免双随机隧道。由于该命名隧道示例让浏览器经 Cloudflare 直接访问 Express，而不是由 Vite 代理 `/api`，还必须把 `https://energy.example.com` 作为精确可信 Origin 配置到 `CORS_ALLOWED_ORIGINS`；禁止 wildcard。长期使用前还需自行完成 Cloudflare 凭据、访问控制和运维治理。

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

如果再单独执行 `ngrok http <PORT>` 暴露后端，并把页面 `apiBase` 指向后端 ngrok 地址，浏览器会因为前端域名和 API 域名不同而触发跨域校验。只有将前端 ngrok Origin 精确配置到后端 `CORS_ALLOWED_ORIGINS` 后，才适合可信短期演示；当前项目不会面向任意公网 Origin 自动开放 CORS。

### 完整体验方式

ngrok 的完整外网体验同样建议走“单一公网来源”：先用反向代理把前端和后端合并到同一个本地端口，再用 ngrok 暴露该端口。路径规则应保持：

- `/api/*` 转发到 `http://127.0.0.1:<PORT>`
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
2. 访问实际 `PORT` 对应的 `http://127.0.0.1:<PORT>/api/health`，确认返回成功。
3. 访问 `http://127.0.0.1:7777/api/health`，确认 Vite 代理已同步到同一 PORT。
4. 检查前端页面的 API Base 是否为 `/api`。URL 参数只影响本次初始化；无参数访问可能恢复此前通过页面配置入口保存到 `localStorage` 的旧值。

### 端口被占用

- 后端默认使用 `3002`，可通过合法 `PORT` 调整；Vite `/api` 代理会同步变化。
- 前端固定使用 `127.0.0.1:7777` 和 `strictPort`，占用时明确失败，不自动换端口。
- 先核对监听 PID 和进程身份，优先回到原终端停止；不要按名称或仅凭端口杀未知进程。

### 外网地址能打开页面，但数据加载失败

Quick Tunnel 场景先确认日志已依次完成“公网域名已发现”“Edge 连接已就绪”“公网链路已就绪”，并且只使用同组输出中的 `[share] 完整分享 URL`；不要使用 cloudflared 原始日志中提前出现的随机域名。失败诊断会区分 HTTP 530/502、Content-Type 非 JSON、JSON 无效、健康契约不符，以及请求 Error/cause 的稳定 name/code，但不会输出响应正文、错误 message、stack、随机 URL 或敏感信息。确认 Vite `7777` 与实际 `PORT` 的 Express 都仍在运行。浏览器只访问一条指向 Vite 的公网 Tunnel，同源 `/api` 由 Vite 代理到 Express；不需要为随机域名配置 `CORS_ALLOWED_ORIGINS`。只有绕过 Vite、让浏览器直接跨域访问 Express 时，才需要把调用页面的精确可信 Origin 写入该环境变量，且禁止 wildcard。

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

不要直接删除、移动或依赖后端启动自动重建当前 `data/`。默认数据库整库格式化必须使用受控 CLI。npm 入口默认、`--check` 和 `--verify` 可用；Windows 正式 execute 推荐直接使用 Node 入口，避免 npm 参数转发歧义：

```bash
npm run format:default-db
npm run format:default-db -- --check
npm run format:default-db -- --verify
node scripts/format-default-database.js --execute "FORMAT data/energy-carbon.sqlite; CLEAR data/uploads; KEEP data/backups"
```

正确的正式确认文本必须作为 `--execute` 后的单个参数逐字符一致，不附加其他确认参数。`--check` 和 `--verify` 只读；`--verify` 使用严格 readonly、临时副本及 data/正式 SQLite/WAL/SHM/uploads/backups 前后完整快照保护诊断，uploads 缺失时不自动创建。主库及存在的 WAL/SHM sidecar 会在快照、checkpoint、备份和 staging 边界执行 lstat、普通文件、realpath containment 与单链接检查。`--execute` 只允许项目默认路径、精确确认文本、可确认停写、合法管理员密码、充分磁盘空间、已验证 manual backup、trusted schema profile、candidate 和回滚安全门。既有 `data/backups` 文件必须保留。

截至 2026-08-28，正式 execute 已完成：新库 schema 为 `2026-08-28-formal-canonical-v3`，新库 quick/integrity/FK 通过，uploads 已清空，历史 backups 保留并新增已验证 manual backup，服务已恢复。当前应从《项目演示操作说明.md》01 开始进行页面和 01—29 全流程手工验收；不能把当前登录注销后产生的审计记录写成空，也不能把 API 复核写成浏览器、视觉或 Excel/WPS 已通过。完整操作、备份恢复和当前证据见[备份恢复与维护态](docs/使用说明书/12-备份恢复与维护态.md)。
