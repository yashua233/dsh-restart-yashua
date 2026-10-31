# dsh-restart-yashua

[中文](./README.md) | **English**

One-click restart for DeepSeek Harness: a sidebar button, a `/restart` command, and a `harness_restart` tool — all backed by the same implementation. A restart kills the running session, so every entry point insists on asking first.

## Install

```bash
# from GitHub
dsh plugin --profile desktop add github:yashua233/dsh-restart-yashua

# from npm (if published)
dsh plugin --profile desktop add dsh-restart-yashua

# from a local directory (development, or your own fork)
dsh plugin --profile desktop add link:/path/to/dsh-restart-yashua
```

`desktop` is the default profile name on the desktop app; the web build usually uses `web` or something you picked yourself — use whichever directory you actually see under `~/.dsh/profiles/`. Restart DeepSeek Harness once after installing and it takes effect.

## Three entry points

| Entry | How to use | Confirmation |
| --- | --- | --- |
| Sidebar button | Click "Restart Harness" | Expands an inline confirmation; only "Restart" proceeds |
| Command | `/restart --yes` | `--yes` is mandatory; without it you only get a hint |
| Tool | `harness_restart action=restart confirm=true` | `confirm: true` is mandatory; otherwise it just answers "needs confirmation" |

The sidebar button is two-stage: the first click restarts nothing, it turns into "This will interrupt the current session. Continue?" with [Restart] [Cancel]. It is the easiest control to hit by accident, so it sits in the most visible spot *and* carries the thickest door.

## Related plugin

If you also want "mail me when the work is done", pair it with [dsh-qq-mail-notify](https://github.com/yashua233/dsh-qq-mail-notify) from the same author: it mails a session digest once a turn really stops, and sends an early progress note when a single turn runs unusually long. After changing its settings, the button here is the natural way to make them take effect.

Neither plugin depends on the other — installing just one works fine.

## How the restart actually works

Three layers, ordered from cleanest to crudest:

1. **Desktop runtime service** — if the host exposes `requestRestart` on `desktopRuntime` / `desktopActions`, hand it over and let Electron relaunch itself. Cleanest, always preferred.
2. **Escape the process tree** — without a runtime service, write a `wscript` script and start it `detached + unref`, then let the script do three things: `taskkill` every process whose **`ExecutablePath` matches exactly** (`DeepSeek Harness.exe` / `DSH Desktop.exe`), waiting until they are really gone; if `resources\app` has been unpacked while `app.asar` is still present, move the asar aside first (otherwise Electron keeps preferring the asar); then launch a fresh GUI.
3. **Neither applies** — return an explicit failure and let you restart by hand. It never pretends to have succeeded.

One detail in layer 2 is easy to miss: the Host process itself is a `DeepSeek Harness.exe` running in `ELECTRON_RUN_AS_NODE` mode, sharing both **name and path** with the GUI process. So a restart cannot kill by process name — it must match the executable path exactly, or it would take out other instances of the same exe.

## Why write a file before killing anything

Killing your own parent process kills you along with it. So layer 2 has to write the actions into a standalone script and hand it to `wscript.exe` as `detached` — that process is not in the host's tree and survives the host being killed. The script also clears `ELECTRON_RUN_AS_NODE` and `DSH_PERMISSION_MODE` from the environment, so the new GUI does not inherit host mode and come up as a headless mute process.

## Two gates on the HTTP entry

The sidebar button talks to `POST /dsh-restart/restart`, and that route can interrupt the whole application, so it has two guard rails:

- **Same-origin check**: `sec-fetch-site: cross-site` always gets 403; a mismatched `Origin` and `Host` also gets 403 (`dsh-app://app` is the desktop page's own origin, which is legitimate and allowed). No other web page can trick your browser into restarting the app for it.
- **Forced confirmation**: a request body without `confirm: true` gets `428 needs_confirmation` immediately. The UI already shows its own dialog; this gate stops anyone from bypassing it and hitting the route directly.

## Logs and troubleshooting

Every restart appends to `$DSH_HOME/logs/restart.log`. The lines that matter:

```
begin exe=...
pids=1234,5678
left=0
asar swap: ok
started
```

- `left=0` means the old processes are fully gone. Anything else means some process could not be killed (usually a permission issue, or an instance in another user session) — in that case the script aborts instead of starting a second instance.
- `asar swap: skipped (no unpacked app or no asar)` is normal: nothing was unpacked, so nothing needs to step aside.
- To inspect the host's restart capability, run `harness_restart action=status`; it reports the current environment, the available restart path, and the delay.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when off, no entry point is registered |
| `delayMs` | `1200` | Buffer in milliseconds between triggering and acting, so tool results and HTTP responses can reach the client |

Set it in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-restart-yashua
      name: 'dsh-restart-yashua'
      config:
        delayMs: 2000
```

## Compatibility

- Target host: DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0` (declared in `dshTarget` / `dsh.compatibility`).
- The desktop path relies on `wscript.exe` (bundled with Windows). On the web build, if the host provides a `desktopRuntime` service it takes layer 1 and `wscript` is never needed.
- Only desktop processes on the **same path** are restarted. Layer 2 does not apply on Linux / macOS; those fall through to layer 3 and report "restart manually".

## Troubleshooting

Start with the plugin's own preflight — it names the known boot blockers directly:

```
harness_restart action=status
```

If the plugin shows up as "not installed", or you renamed the package, run the identity check too:

```powershell
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  scripts\check-identity.mjs
```

The restart log lives at `$DSH_HOME/logs/restart.log`; its last few lines are usually enough — `left=0` means every old process was cleared, anything else means one survived (usually permissions, or another user session still holds an instance) and the plugin refuses to start rather than leave two hosts running.

Still stuck? Open an issue: <https://github.com/yashua233/dsh-restart-yashua/issues>. Please use issues rather than direct messages — it helps the next person with the same problem.

Include DSH version, plugin version, the full `harness_restart action=status` output, the last dozen lines of `restart.log`, and your environment (desktop or web, Windows version, default install path or unpacked directory).

**Mask anything containing your username before pasting.**

## Privacy

No network calls, no telemetry. The only side effect is writing `$DSH_HOME/logs/restart.log`, which contains process ids, whether the asar was moved aside, and whether the launch succeeded — never any session content.

## License

MIT, see [LICENSE](./LICENSE).
