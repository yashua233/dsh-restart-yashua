# dsh-restart-yashua

> 快速跳转：[安装](#安装) · [三种用法](#三种用法) · [配置](#配置) · [启动前体检](#启动前体检) · [兼容性](#兼容性) · [遇到问题](#遇到问题) · [相关插件](#相关插件)

**中文** | [English](./README.en.md)

一键重启 DeepSeek Harness —— 侧栏按钮、`/restart` 指令、`harness_restart` 工具，三条入口共用同一套实现。重启会中断当前会话，所以每一处都强制先问一次。

## 安装

```bash
# 从 GitHub
dsh plugin --profile desktop add github:yashua233/dsh-restart-yashua

# 从 npm（若已发布）
dsh plugin --profile desktop add dsh-restart-yashua

# 本地目录（开发或自己改的时候）
dsh plugin --profile desktop add link:/path/to/dsh-restart-yashua
```

`desktop` 是桌面端默认的 profile 名，web 端通常是 `web` 或你自定义的名字——用你自己的那个（`~/.dsh/profiles/` 下能看到的目录名）。装完重启一次 DeepSeek Harness 生效。

## 三种用法

| 入口 | 怎么用 | 确认方式 |
| --- | --- | --- |
| 侧栏按钮 | 点「重启 Harness」 | 就地展开确认条，点「重启」才动手 |
| 指令 | `/restart --yes` | 必须带 `--yes`，不带只提示 |
| 工具 | `harness_restart action=restart confirm=true` | 必须 `confirm: true`，否则只返回「需要确认」 |

侧栏按钮是两段式：第一次点击不重启，按钮原地变成「重启会中断当前会话，确定吗？」+［重启］［取消］。这是最容易被误触的入口，所以放在最显眼的位置也加最厚的门。

## 相关插件

- [dsh-qq-mail-notify](https://github.com/yashua233/dsh-qq-mail-notify) — 每轮工作真正停下后把摘要发到 QQ 邮箱，某一轮跑太久还会先发一封进度通报。改完它的配置之后，正好点本插件的按钮重启生效。
- [dsh-mail-command](https://github.com/yashua233/dsh-mail-command) — 配合上面那个把邮件变成双向通道：回信让任务继续/停止，或批准一次越界操作。它的口令是落盘的，**本插件重启后旧口令依然有效**，不用重新发信。

本插件与另外两个都互不依赖，三者可以任意组合；`dsh-mail-command` 与 `dsh-qq-mail-notify` 之间的关系见它们各自的 README。

## 启动前体检

每次 `harness_restart action=status`、以及每次真正重启之前，插件会把已知会导致「DSH 打不开」的情况查一遍（只读，不改任何文件）：

| 检查项 | 对应真实故障 |
| --- | --- |
| profile 配置带 UTF-8 BOM | 启动时 `JSON.parse` 直接抛错，应用秒崩 |
| 本地登录 cookie 累积过多 | 请求头超过 16KB，握手 431，界面报「认证失败」 |
| `client.js` 模块 id 与包名不一致 | `duplicate factory registration`，Web 端卡在启动阶段 |
| 目录名与包名不一致 / 入口文件缺失 | 包解析不到，显示「未安装」 |
| 装了插件却没登记进 `bundles` | 依赖在但加载不到 |
| `bundles` 里登记了没装的包 | `cannot resolve profile bundle` |
| `app.asar` 与解包目录并存 | Electron 优先 asar，改了 app 目录不生效 |
| 宿主模块被第三方补丁改过 | 典型的是审批被短路成「一律自动放行」，所有「等你授权」的功能静默失效且不报错 |

发现问题时会在工具返回里直接给出**是哪一项、什么后果、怎么修**；重启照常执行（重启本身常常就是为了让修复生效），问题只是提前告诉你，免得重启完还是一样打不开。

## 重启是怎么做到的

按「最干净的先试，不行再往下退」排了三层：

1. **桌面运行时服务** —— 如果宿主提供了 `desktopRuntime` / `desktopActions` 的 `requestRestart`，直接交给它，Electron 自己 relaunch。最干净，首选。
2. **脱离进程树重来** —— 没有运行时服务时，写一个 `wscript` 脚本用 `detached + unref` 的方式起出去，再让脚本自己做三件事：按 `ExecutablePath` **精确匹配**同名进程（`DeepSeek Harness.exe` / `DSH Desktop.exe`）全部 `taskkill`，等它们真的消失；如果 `resources\app` 已解包而 `app.asar` 还在，先把 asar 改名让位（否则 Electron 仍优先加载 asar）；最后拉起一个干净的 GUI。
3. **都不成立** —— 明确返回失败，让你手动重启，绝不假装成功。

第 2 层有个容易忽略的点：Host 进程本身是 `ELECTRON_RUN_AS_NODE` 模式跑起来的 `DeepSeek Harness.exe`，和 GUI 主进程**同名同路径**。所以重启不能按进程名杀，必须按可执行文件路径精确匹配，否则会误杀同一个 exe 的其它实例。

## 为什么要写文件再杀进程

杀自己的父进程会连带杀掉自己，所以第 2 层必须先把动作写成一个独立脚本，交给 `wscript.exe` 以 `detached` 方式启动——它不在宿主进程树里，宿主被杀时它能活下来继续干活。脚本里同时清掉了 `ELECTRON_RUN_AS_NODE` 和 `DSH_PERMISSION_MODE` 两个环境变量，避免新拉起的 GUI 继承了宿主模式变成无界面的哑进程。

## HTTP 入口的两道门

侧栏按钮走 `POST /dsh-restart/restart`，这条路能直接打断整个应用，所以加了两层防护：

- **同源校验**：`sec-fetch-site: cross-site` 一律 403；`Origin` 和 `Host` 不一致也 403（`dsh-app://app` 是桌面端页面自身的 origin，属于正常情况，放行）。别的网页没法诱导你的浏览器替你重启。
- **强制确认**：请求体没有 `confirm: true` 直接返回 `428 needs_confirmation`。界面自己会弹确认框，这条是防止有人绕开界面直接打接口。

### 体检的开关

走配置文件 `~/.dsh/dsh-restart.json`，改完即时生效，也可以走「设置 → 重启与体检」：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `preflight.crashLogs` | `true` | 是否回看 `crash-*.log` |
| `preflight.crashLogDays` | `7` | 回看多少天 |
| `preflight.sessions` | `true` | 是否检查会话文件（只能查明显异常） |

会话文件按**解压后的内容**判定，不看压缩后多少字节：空会话（只有 session 头、没有消息）是正常的，不会报；解不开、解压后为空、首行不是 session 头才报异常。

## 日志与排障

每次重启都会写 `$DSH_HOME/logs/restart.log`，关键几行：

```
begin exe=...
pids=1234,5678
left=0
asar swap: ok
started
```

- `left=0` 说明旧进程全清干净了；不是 0 说明有进程杀不掉（通常是权限或另一个用户会话里的实例），脚本会放弃启动，避免出现两个实例。
- `asar swap: skipped (no unpacked app or no asar)` 是正常情况——没有解包过就没什么要让位的。
- 想确认宿主的重启能力，用 `harness_restart action=status`，它会返回当前环境、可用的重启路径和延迟。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后三条入口都不注册 |
| `delayMs` | `1200` | 从触发到真正动手的缓冲毫秒数，留给工具结果和 HTTP 响应送达客户端 |

写在 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: dsh-restart-yashua
      name: 'dsh-restart-yashua'
      config:
        delayMs: 2000
```

## 兼容性

- **只声明实测过的那个版本：`0.2.1-rc.5`**。`package.json` 里 `dshTarget` 和 `dsh.compatibility.dsh` 都是它，没有范围。
- 为什么不写成 `>=x <y`：DSH 还在开发者预览，官方明确说会有破坏性变更，**跨一个小版本（0.2.1 → 0.2.2）就可能装不上或行为不对**。写范围等于替你赌那些版本，我不赌。
- 想装在别的版本上：把 `dsh.compatibility.dsh` 改成你手上的版本再试。能跑是运气，跑不动是常态——反馈时请带上版本号。
- 桌面端依赖 `wscript.exe`（Windows 自带）；web 端如果宿主提供了 `desktopRuntime` 服务，走第 1 层，不需要 wscript。
- 只重启**同路径**的桌面进程。Linux / macOS 上的第 2 层不适用，会落到第 3 层返回「需要手动重启」。

## 遇到问题

重启出岔子时，先看它自己的体检——八类已知故障会直接点名：

```powershell
harness_restart action=status
```

再加一条身份自查（改过包名、或插件显示「未安装」时必跑）：

```powershell
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  scripts\check-identity.mjs
```

重启日志在 `$DSH_HOME/logs/restart.log`，末尾几行就够定位：`left=0` 表示旧进程清干净了，非 0 说明有进程杀不掉（通常是权限，或另一个用户会话里还有实例），脚本会放弃启动以免出现两个宿主。

还是不行就提 issue：<https://github.com/yashua233/dsh-restart-yashua/issues>。走 issue 而不是私信，后面遇到同样问题的人能搜到。

带上这几样，能省好几轮来回：

- DSH 版本、本插件版本（`package.json` 的 `version`）；
- `harness_restart action=status` 的完整输出；
- `restart.log` 的最后十几行；
- 你的环境：桌面端还是 web、Windows 版本、DSH 是安装在默认路径还是解包目录。

**路径里如果带了用户名，贴之前先打码**。

## 隐私

不联网、不收集任何数据。唯一的副作用是写 `$DSH_HOME/logs/restart.log`，内容只有进程号、asar 是否让位、启动是否成功这几项，不含任何会话内容。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
