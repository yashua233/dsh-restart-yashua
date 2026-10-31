# 安全策略 / Security Policy

## 报告漏洞

**请不要用公开 issue 报告安全问题。**

用 GitHub 的私密漏洞报告：
<https://github.com/yashua233/dsh-restart-yashua/security/advisories/new>

一般 7 天内回应。修好并发版后会在 Security advisories 里公开说明。

## 这个插件会动什么

它要重启宿主进程，所以触碰的东西比一般插件多。全部列出：

| 动作 | 具体做什么 | 风险 |
|---|---|---|
| 结束进程 | 按**可执行文件路径**精确匹配同名进程并结束 | 只动同一个 exe 的实例，不按进程名乱杀 |
| 让位 asar | 若 `resources\app` 已解包，把 `app.asar` 改名为 `app.asar.bak` | 否则 Electron 仍优先加载 asar，解包目录的修改不生效 |
| 写日志 | `$DSH_HOME/logs/restart.log` | 只有进程号、asar 是否让位、启动是否成功，不含会话内容 |
| 生成脚本 | 临时目录里一个 `.js` 加一个计划任务，跑完自动删除 | 用 `wscript.exe` 以 detached 方式启动，脱离本进程树 |

不联网、不读会话内容、不碰凭据。

## HTTP 入口的两道门

侧栏按钮走 `POST /dsh-restart/restart`，这条路能直接打断整个应用：

- **同源校验**：`sec-fetch-site: cross-site` 一律 403；`Origin` 与 `Host` 不一致也 403。别的网页没法诱导你的浏览器替你重启。
- **强制确认**：请求体没有 `confirm: true` 直接返回 `428 needs_confirmation`，绕开界面也打不动。

## 已知取舍

- 插件以 DSH 进程的身份运行，拥有该进程的全部权限——包括结束进程和改名文件。装之前请确认你读过这段代码。
- 重启会**中断当前会话**。这是它的功能，不是缺陷，所以每一处入口都强制二次确认。

## Security Policy (English)

Please **do not** report security issues in public. Use GitHub's private vulnerability reporting link above. Restarting touches processes and files, and the full inventory of what this plugin does is listed in the table above — no network calls, no session content, no credentials.
