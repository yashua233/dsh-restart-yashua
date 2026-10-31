/**
 * dsh-restart-yashua —— 一键重启 DeepSeek Harness。
 *
 * 三条入口共用一套实现（lib/restart.js）：
 *   · 侧栏按钮   POST /dsh-restart/restart   （client.js 调）
 *   · 指令       /restart
 *   · 工具       harness_restart
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeEnvironment, reapStaleTasks, requestRestart, summarize } from './restart.js'
import { runPreflight, summarizePreflight } from './preflight.js'

export const name = 'dsh-restart-yashua'

/** webServer 走 ctx.inject 可选注入，tools 是硬依赖。 */
export const inject = ['tools']

const DEFAULTS = Object.freeze({
  enabled: true,
  /** 启动前体检的可调项：设置界面与 cordis config 都能改。 */
  preflight: Object.freeze({ crashLogs: true, crashLogDays: 7, sessions: true }),
  /** 从按下到真正动手的缓冲：留给 tool 结果 / HTTP 响应送达。 */
  delayMs: 1200,
})

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function headerOf(request, name) {
  const value = request.headers?.[name]
  if (Array.isArray(value)) return String(value[0] ?? '')
  return value === undefined ? '' : String(value)
}

/** 同源校验：重启是能打断整个应用的动作，跨站请求一律不接。 */
function allowRequest(request, response) {
  const site = headerOf(request, 'sec-fetch-site').toLowerCase()
  if (site === 'cross-site') {
    sendJson(response, 403, { ok: false, error: 'cross-origin blocked' })
    return false
  }
  const origin = headerOf(request, 'origin').trim()
  if (!origin) return true
  if (origin === 'null') {
    sendJson(response, 403, { ok: false, error: 'cross-origin blocked' })
    return false
  }
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    sendJson(response, 403, { ok: false, error: 'cross-origin blocked' })
    return false
  }
  const host = headerOf(request, 'host').trim()
  // 桌面端页面 origin 是 dsh-app://app，与 host 头不同源是正常的，放行。
  if (!host || origin.startsWith('dsh-app:') || originHost.toLowerCase() === host.toLowerCase()) return true
  sendJson(response, 403, { ok: false, error: 'cross-origin blocked' })
  return false
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULTS,
    ...(config || {}),
    // preflight 是嵌套对象，浅合并会被整体覆盖，这里单独合一次
    preflight: { ...DEFAULTS.preflight, ...((config && config.preflight) || {}) },
  }
  if (!cfg.enabled) return


  /** 插件自己的配置：$DSH_HOME/dsh-restart.json，改完即时生效。 */
  const settingsFile = () => {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    return path.join(home, 'dsh-restart.json')
  }
  const readSettingsFile = () => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    } catch {
      return {}
    }
  }
  const writeSettingsFile = (patch) => {
    const current = readSettingsFile()
    const next = { ...current, ...patch, preflight: { ...(current.preflight || {}), ...(patch.preflight || {}) } }
    const file = settingsFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
    return next
  }
  /** 体检开关：cordis config 打底，配置文件覆盖（所以界面上改了立即生效）。 */
  const preflightOptions = () => {
    const stored = readSettingsFile()
    const merged = { ...cfg.preflight, ...((stored && stored.preflight) || {}) }
    return {
      crashLogScan: merged.crashLogs !== false,
      crashLogDays: Number(merged.crashLogDays) || 7,
      sessionCheck: merged.sessions !== false,
    }
  }
  const status = () => describeEnvironment(ctx)

  // 启动时收拾上次重启留下的残局：那些进程早就不在了、计划任务却还挂着。
  // 尽力而为——权限不足是常态，任何失败都不该影响插件本身能不能用。
  try {
    reapStaleTasks((message) => {
      try {
        ctx.logger?.info?.(message)
      } catch {
        /* 日志失败无所谓 */
      }
    })
  } catch {
    /* 清理是附带的，失败就跳过 */
  }
  /** 跑一遍启动前体检；resources 目录用于判断 asar 与解包目录是否并存。 */
  const preflight = () => {
    try {
      const environment = describeEnvironment(ctx)
      const resources = environment.desktopExe
        ? path.join(path.dirname(environment.desktopExe), 'resources')
        : undefined
      return runPreflight({ resources, ...preflightOptions() })
    } catch (error) {
      return { ok: true, checkedAt: Date.now(), findings: [], errors: [], warnings: [], failed: String(error?.message ?? error) }
    }
  }
  const restart = (options = {}) =>
    requestRestart(ctx, {
      reason: options.reason || 'manual',
      delayMs: options.delayMs === undefined ? cfg.delayMs : options.delayMs,
    })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'harness_restart',
      description:
        '重启 DeepSeek Harness（桌面应用整体 relaunch，等价于关掉再打开）。' +
        'action=status 先看当前运行环境；action=restart 真正重启，会在延迟后结束本进程并拉起新的 Harness。' +
        '重启会中断当前会话与进行中的任务：调用 restart 之前**必须先向用户确认一次**' +
        '（用 ask_user_question 问「现在重启吗」，选项给出「现在重启 / 稍后」），' +
        '用户明确同意后再带 confirm:true 调用；没有用户同意就不要传 confirm，工具会直接拒绝执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'restart'], description: 'status 查看环境，restart 执行重启。' },
          confirm: {
            type: 'boolean',
            description: '必须为 true 才真的重启。只有在用户被明确问过并同意之后才可传 true；不传或 false 时本工具不会重启，只返回需要确认。',
          },
          delayMs: { type: 'number', description: '延迟多少毫秒后动手，默认 1200。' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            mode: { type: 'string' },
            text: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok', 'text'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(input) {
        if (input?.action === 'status') {
          // 体检把已知会导致「打不开」的情况都查一遍：BOM、cookie 累积、插件标识不一致、
          // bundles 漏登记、link 失效、asar 并存。只报告，不改任何东西。
          const report = preflight()
          return {
            ok: true,
            mode: 'status',
            text: summarize(status()) + '\n\n【启动前体检】\n' + summarizePreflight(report),
          }
        }
        // 确认门：没有用户同意就不动手。模型忘了问、或者直接硬调，都在这里被拦下。
        if (input?.confirm !== true) {
          return {
            ok: false,
            mode: 'needs_confirmation',
            text:
              '未重启（需要用户确认）。请先用 ask_user_question 问一次「现在重启 DeepSeek Harness 吗」，' +
              '把「现在重启 / 稍后」作为选项；用户选了「现在重启」之后再带 confirm:true 调一次本工具。',
          }
        }
        // 重启前先体检：发现问题先告诉你，但仍然照做（重启本身常常就是为了让修复生效）。
        const report = preflight()
        const advisory = report.ok ? '' : '\n\n⚠ 启动前体检发现问题（仍会重启）：\n' + summarizePreflight(report)
        const result = await restart({ reason: 'tool', delayMs: input?.delayMs })
        if (!result.ok) return { ok: false, mode: String(result.mode), error: String(result.error), text: String(result.error) + advisory }
        return {
          ok: true,
          mode: String(result.mode),
          text:
            '已安排重启（' + String(result.mode) + '，' + String(result.delayMs ?? 0) + 'ms 后执行）。' +
            '本次会话的回复可能来不及送达，Harness 重新打开后会话历史仍在。' + advisory,
        }
      },
    }),
  )

  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: 'restart',
        description: '重启 DeepSeek Harness（桌面应用整体 relaunch）。必须带 --yes 才会执行',
        input: { hint: '[--yes] [秒数]' },
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput ?? '').trim()
          const tokens = raw.split(/\s+/).filter(Boolean)
          const confirmed = tokens.some((token) => /^(--yes|-y|yes|确认)$/i.test(token))
          const secondsToken = tokens.find((token) => /^\d+$/.test(token))
          const seconds = secondsToken === undefined ? Number.NaN : Number(secondsToken)
          const delayMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
          if (!confirmed) {
            return {
              kind: 'error',
              text: '未重启（需要确认）。确实要重启就再执行一次：/restart --yes（可带秒数，例如 /restart --yes 3）',
            }
          }
          const result = await restart({ reason: 'command', delayMs })
          if (!result.ok) return { kind: 'error', text: String(result.error) }
          setTimeout(() => {}, 0)
          return {
            kind: 'success',
            text: '正在重启 Harness（' + String(result.mode) + '）…稍等几秒，应用会自己回来。',
          }
        },
      }),
    )
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const offStatus = host.webServer.register({
        kind: 'exact',
        path: '/dsh-restart/status',
        handler: async (request, response) => {
          if (!allowRequest(request, response)) return
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          try {
            const environment = status()
            sendJson(response, 200, { ok: true, ...environment, summary: summarize(environment) })
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      })
      const offRestart = host.webServer.register({
        kind: 'exact',
        path: '/dsh-restart/restart',
        handler: async (request, response) => {
          if (!allowRequest(request, response)) return
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          try {
            const body = await readJsonBody(request).catch(() => ({}))
            // 确认门：界面必须显式带 confirm:true（按钮自己弹过确认框），否则不重启。
            if (body?.confirm !== true) {
              sendJson(response, 428, { ok: false, error: 'needs_confirmation', message: 'UI must confirm before restarting.' })
              return
            }
            const result = await restart({ reason: 'ui', delayMs: body?.delayMs })
            sendJson(response, result.ok ? 200 : 503, {
              ok: Boolean(result.ok),
              mode: String(result.mode),
              error: result.error ? String(result.error) : undefined,
              warning: result.warning ? String(result.warning) : undefined,
              logPath: result.logPath ? String(result.logPath) : undefined,
            })
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      })
      // 体检接口：设置面板点「立即体检」时调这里，返回完整 findings。
      const offPreflight = host.webServer.register({
        kind: 'exact',
        path: '/dsh-restart/preflight',
        handler: async (request, response) => {
          if (!allowRequest(request, response)) return
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          try {
            sendJson(response, 200, { ok: true, ...preflight() })
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      })
      // 体检开关的读写：配置文件 $DSH_HOME/dsh-restart.json，改完即时生效。
      const offSettings = host.webServer.register({
        kind: 'exact',
        path: '/dsh-restart/settings',
        handler: async (request, response) => {
          if (!allowRequest(request, response)) return
          if (request.method === 'GET') {
            sendJson(response, 200, { ok: true, preflight: preflightOptions(), file: settingsFile() })
            return
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' })
            response.end()
            return
          }
          try {
            const body = await readJsonBody(request).catch(() => ({}))
            const next = writeSettingsFile({ preflight: body?.preflight || {} })
            sendJson(response, 200, { ok: true, preflight: next.preflight, file: settingsFile() })
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      })
      return () => {
        try { offRestart() } catch {}
        try { offStatus() } catch {}
        try { offPreflight() } catch {}
        try { offSettings() } catch {}
      }
    })
  })
}
