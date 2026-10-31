/**
 * dsh-restart 的 Web 端：侧栏底部一个「重启」按钮。
 *
 * 交互是两段式，明确问一次：
 *   点「重启 Harness」→ 就地变成确认条「重启会中断当前会话 / 重启 / 取消」
 *   点「重启」才 POST /dsh-restart/restart（带 confirm:true）；点「取消」回到原位。
 * Host 侧还有第二道门：body.confirm !== true 直接 428，不重启。
 *
 * 文案全部走 DSH 的 locale 服务（ctx.locale.register + bind），所以界面语言
 * 切到英文时按钮会跟着变；label 写成函数形式，切换语言后由宿主重新求值。
 */
window.__ModuleLoader__.load({
  // 必须与包名（客户端入口 id）一致：模块系统按入口 id 缓存已执行的 bundle，
  // id 不一致会导致 prefetch 与正式加载各执行一次，触发 duplicate factory registration。
  id: 'dsh-restart-yashua',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** 本插件独占的字典命名空间。 */
    const NS = 'dsh-restart'

    const DICT = {
      zh: {
        idle: '重启 Harness',
        hint: '重启 DeepSeek Harness（点一下会先问你一次）',
        asking: '重启会中断当前会话，确定吗？',
        yes: '重启',
        no: '取消',
        firing: '正在重启…',
        error: '重启失败',
        settingsTitle: '重启与体检',
        settingsHint: '重启前会先体检：把已知会导致「打不开」的情况查一遍。',
        checkCrashLogs: '回看崩溃日志',
        checkCrashLogsHint: '扫描 DSH 自己写下的 crash-*.log，找出历史启动故障',
        crashLogDays: '回看天数',
        checkSessions: '检查会话文件',
        checkSessionsHint: '只查明显异常（0 字节、异常偏小）；深度格式校验做不到',
        runCheck: '立即体检',
        running: '体检中…',
        saveSettings: '保存',
        savedSettings: '已保存',
        allGood: '体检通过，没有发现问题',
      },
      en: {
        idle: 'Restart Harness',
        hint: 'Restart DeepSeek Harness (asks once first)',
        asking: 'This will interrupt the current session. Continue?',
        yes: 'Restart',
        no: 'Cancel',
        firing: 'Restarting…',
        error: 'Restart failed',
        settingsTitle: 'Restart & Preflight',
        settingsHint: 'A preflight runs before every restart, checking known boot blockers.',
        checkCrashLogs: 'Scan crash logs',
        checkCrashLogsHint: 'Read the crash-*.log files DSH wrote, surfacing past boot failures',
        crashLogDays: 'Days to scan',
        checkSessions: 'Check session files',
        checkSessionsHint: 'Only obvious damage (0 bytes / oddly small); deep format validation is not possible',
        runCheck: 'Run preflight',
        running: 'Running…',
        saveSettings: 'Save',
        savedSettings: 'Saved',
        allGood: 'Preflight passed, nothing found',
      },
    }

    /** locale 服务不可用时的兜底（老宿主）：按中文渲染，但不至于报错。 */
    const fallback = (key) => DICT.zh[key] || key

    function RefreshIcon({ color, spinning }) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: spinning
            ? { animation: 'dsh-restart-spin 900ms linear infinite', display: 'block' }
            : { display: 'block' },
        },
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1 -2.49-6.01' }),
        h('path', { d: 'M20.5 3.5v5h-5' }),
      )
    }

    const smallButton = (label, onClick, primary) => h(
      'button',
      {
        type: 'button',
        onClick,
        style: {
          height: 26,
          padding: '0 10px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
          borderRadius: 6,
          background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: primary ? '#fff' : 'inherit',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
      },
      label,
    )

    function RestartAction(props) {
      const wide = Boolean(props && props.wide)
      const t = typeof props?.t === 'function' ? props.t : fallback
      const [phase, setPhase] = useState('idle') // idle | asking | firing | error
      const [hover, setHover] = useState(false)
      const [error, setError] = useState('')
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const fire = useCallback(async () => {
        try {
          const response = await fetch('/dsh-restart/restart', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delayMs: 800, confirm: true }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || data.ok === false) {
            throw new Error((data && data.error) || 'HTTP ' + response.status)
          }
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
          setPhase('error')
        }
      }, [])

      const ask = () => {
        if (phase === 'firing') return
        if (phase === 'asking') {
          setPhase('idle')
          return
        }
        setError('')
        setPhase('asking')
      }

      const confirmNow = () => {
        setPhase('firing')
        fire()
      }

      // 确认态：就地展开一条确认栏，不重启任何东西。
      if (phase === 'asking') {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: wide ? 'row' : 'column',
              alignItems: wide ? 'center' : 'stretch',
              gap: 8,
              padding: 6,
              borderRadius: 8,
              background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.12))',
            },
          },
          h('span', { style: { fontSize: 12, lineHeight: 1.3, flex: 1 } }, t('asking')),
          h(
            'span',
            { style: { display: 'inline-flex', gap: 6 } },
            smallButton(t('yes'), confirmNow, true),
            smallButton(t('no'), () => setPhase('idle'), false),
          ),
        )
      }

      const accent =
        phase === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : phase === 'firing'
            ? 'var(--dsw-alias-brand-primary)'
            : hover
              ? 'var(--dsw-alias-label-primary)'
              : 'var(--dsw-alias-label-secondary)'

      const label = phase === 'firing' ? t('firing') : phase === 'error' ? t('error') : t('idle')
      const title = phase === 'error' ? t('error') + '：' + error : t('hint')

      return h(
        'button',
        {
          type: 'button',
          onClick: ask,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title,
          'aria-label': t('hint'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: 8,
            height: 32,
            minWidth: 32,
            padding: wide ? '0 8px' : 0,
            margin: 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: accent,
            font: 'inherit',
            fontSize: 13,
            lineHeight: 1,
            cursor: phase === 'firing' ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
            transition: 'color 120ms ease',
          },
        },
        h(RefreshIcon, { color: accent, spinning: phase === 'firing' }),
        wide ? h('span', null, label) : null,
        h(
          'style',
          null,
          '@keyframes dsh-restart-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
        ),
      )
    }


    /** 设置 → 重启与体检：三个开关 + 一键体检。 */
    function PreflightPanel(props) {
      const t = typeof props?.t === 'function' ? props.t : fallback
      const [form, setForm] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')

      React.useEffect(() => {
        fetch('/dsh-restart/settings', { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => r.json())
          .then((data) => {
            if (data?.preflight) setForm({ ...data.preflight })
          })
          .catch(() => undefined)
      }, [])

      const toggle = (key) => () => setForm((prev) => (prev ? { ...prev, [key]: !prev[key] } : prev))

      const save = async () => {
        if (!form) return
        setBusy('save')
        setNote('')
        try {
          const r = await fetch('/dsh-restart/settings', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflight: form }),
          })
          const data = await r.json().catch(() => ({}))
          if (!r.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + r.status)
          setNote(t('savedSettings'))
        } catch (error) {
          setNote(String((error && error.message) || error))
        } finally {
          setBusy('')
        }
      }

      const run = async () => {
        setBusy('check')
        setNote('')
        try {
          const r = await fetch('/dsh-restart/preflight', { credentials: 'same-origin', cache: 'no-store' })
          const data = await r.json().catch(() => ({}))
          if (!r.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + r.status)
          setReport(data)
        } catch (error) {
          setNote(String((error && error.message) || error))
        } finally {
          setBusy('')
        }
      }

      if (!form) {
        return h('div', { style: { padding: 16, fontSize: 13, opacity: 0.7 } }, t('running'))
      }

      const row = (label, hint, control) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 } },
          h(
            'div',
            { style: { flex: 1 } },
            h('div', { style: { fontSize: 13 } }, label),
            h('div', { style: { fontSize: 11, opacity: 0.6, lineHeight: 1.4 } }, hint),
          ),
          control,
        )

      const box = { width: 16, height: 16, marginTop: 2, cursor: 'pointer' }

      const findings = Array.isArray(report?.findings) ? report.findings : []
      return h(
        'div',
        { style: { padding: '4px 2px 20px', fontSize: 13 } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, t('settingsTitle')),
        h('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 16, lineHeight: 1.5 } }, t('settingsHint')),

        row(t('checkCrashLogs'), t('checkCrashLogsHint'), h('input', { type: 'checkbox', style: box, checked: form.crashLogs !== false, onChange: toggle('crashLogs') })),
        form.crashLogs !== false
          ? row(
              t('crashLogDays'),
              '',
              h('input', {
                type: 'number',
                min: 1,
                max: 90,
                value: String(form.crashLogDays ?? 7),
                onChange: (e) => setForm((prev) => (prev ? { ...prev, crashLogDays: Number(e.target.value) || 7 } : prev)),
                style: { width: 80, height: 26, padding: '0 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', font: 'inherit' },
              }),
            )
          : null,
        row(t('checkSessions'), t('checkSessionsHint'), h('input', { type: 'checkbox', style: box, checked: form.sessions !== false, onChange: toggle('sessions') })),

        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 6, marginBottom: 12 } },
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              disabled: busy !== '',
              style: { height: 30, padding: '0 14px', border: 'none', borderRadius: 8, background: 'var(--dsw-alias-brand-primary, #4d6bfe)', color: '#fff', font: 'inherit', fontSize: 13, cursor: 'pointer', opacity: busy ? 0.6 : 1 },
            },
            t('saveSettings'),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: run,
              disabled: busy !== '',
              style: { height: 30, padding: '0 14px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer', opacity: busy ? 0.6 : 1 },
            },
            busy === 'check' ? t('running') : t('runCheck'),
          ),
        ),

        note ? h('div', { style: { fontSize: 12, marginBottom: 10, opacity: 0.75 } }, note) : null,

        report
          ? h(
              'div',
              { style: { marginTop: 8, padding: '10px 12px', borderRadius: 8, background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.08))', fontSize: 12, lineHeight: 1.7 } },
              findings.length === 0
                ? h('div', null, t('allGood'))
                : findings.map((f, i) =>
                    h(
                      'div',
                      { key: i, style: { marginBottom: 8 } },
                      h('div', { style: { fontWeight: 600, color: f.level === 'error' ? 'var(--dsw-alias-state-error-primary, #d4380d)' : 'var(--dsw-alias-state-warning-primary, #ad6800)' } }, (f.level === 'error' ? '✗ ' : '! ') + f.title),
                      h('div', { style: { opacity: 0.8 } }, f.detail),
                      h('div', { style: { opacity: 0.6 } }, '→ ' + f.fix),
                    ),
                  ),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 字典注册：语言切换由宿主统一管理，这里只提供两种语言的内容。
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-restart: dictionaries')
        }
        const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallback

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-restart', order: 70, label: () => t('settingsTitle'), inject: () => ({ t }) },
            PreflightPanel,
          ),
        )

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-restart',
              order: 20,
              // 函数形式：切换界面语言后宿主会重新求值，按钮文字才会跟着变。
              label: () => t('idle'),
              inject: () => ({ t }),
            },
            RestartAction,
          ),
        )
      },
    }
  },
})
