/**
 * 启动前体检：把已知会导致「DSH 打不开」的情况都查一遍。
 *
 * 这些检查项全部来自真实故障，不是假设：
 *   ① profile 清单带 BOM           → readProfileManifest 的 JSON.parse 直接抛，启动即崩（2026-10-19）
 *   ② 本地登录 cookie 无限累积      → Cookie 头超过 16KB，握手 431，界面报「认证失败」（2026-10-30）
 *   ③ 插件模块 id 与包名不一致      → duplicate factory registration，Web 端卡在启动阶段（2026-10-31）
 *   ④ 装了但没登记进 bundles        → 插件加载不到（改名后的连带故障）
 *   ⑤ node_modules 里的 link 失效   → 包解析不到，同样是「未安装」
 *   ⑥ asar 与解包目录并存           → Electron 优先 asar，改了 app 目录也不生效
 *   ⑦ 磁盘空间不足                  → 更新与解包会半途失败
 *
 * 设计原则：每一项都独立 try/catch，任何检查自身出错都不能拖垮插件；
 * 只报告事实与修法，不自动改任何东西。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const BOM = [0xef, 0xbb, 0xbf];

function hasBom(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(3);
      const read = fs.readSync(fd, buffer, 0, 3, 0);
      return read === 3 && buffer[0] === BOM[0] && buffer[1] === BOM[1] && buffer[2] === BOM[2];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function safeJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // 体检目的下先剥掉 BOM 再解析：BOM 本身由 ① 那一项单独报告，
    // 但如果不剥，JSON.parse 会失败并让后面的 bundles / 插件检查全部跳过——
    // 一个问题掩盖其他问题，体检就失去意义了。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { value: JSON.parse(text), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

function result(id, level, title, detail, fix) {
  return { id, level, title, detail, fix };
}

/** ① profile 清单：BOM / JSON 有效性 / 必要字段 */
function checkProfileManifest(profilesDir) {
  const out = [];
  if (!fs.existsSync(profilesDir)) return out;
  for (const name of fs.readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
      const target = path.join(dir, file);
      if (!fs.existsSync(target)) continue;
      if (hasBom(target)) {
        out.push(
          result(
            `bom:${name}/${file}`,
            'error',
            `配置文件带 UTF-8 BOM：profiles/${name}/${file}`,
            'DSH 启动时直接 JSON.parse 这个文件，BOM 会让它抛 "Unexpected token" 并立即崩溃。',
            `去掉开头的 3 个字节（EF BB BF），或运行 ~/.dsh/scripts/dsh-bom-guard.ps1。`,
          ),
        );
      }
    }
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const { value, error } = safeJson(manifest);
    if (error) {
      out.push(
        result(`json:${name}`, 'error', `profile 清单解析失败：profiles/${name}/package.json`, String(error.message), '按上面的错误定位语法问题；改坏了可从同名 .bak 恢复。'),
      );
      continue;
    }
    out.push(...checkBundles(name, value));
  }
  return out;
}

/** ④ dependencies 与 bundles 是否同步 */
function checkBundles(profileName, manifest) {
  const out = [];
  const deps = Object.keys(manifest?.dependencies ?? {});
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const local = deps.filter((d) => !d.startsWith('@deepseek-ai/'));
  const missing = local.filter((d) => !bundles.includes(d));
  if (missing.length > 0) {
    out.push(
      result(
        `bundles:${profileName}`,
        'error',
        `插件装了但没登记进 bundles：${profileName}`,
        `${missing.join('、')} 在 dependencies 里，但 dsh.profile.bundles 没有它们，DSH 不会加载。`,
        '把缺的名字补进 profiles/<name>/package.json 的 dsh.profile.bundles 数组（或重装该插件）。',
      ),
    );
  }
  const orphan = bundles.filter((b) => !b.startsWith('@deepseek-ai/') && !deps.includes(b));
  if (orphan.length > 0) {
    out.push(
      result(
        `bundles-orphan:${profileName}`,
        'error',
        `bundles 里登记了没装的包：${profileName}`,
        `${orphan.join('、')} 出现在 bundles 里但 dependencies 中没有对应项（常见于插件改名后漏改），启动会报 "cannot resolve profile bundle"。`,
        '把 bundles 里的旧名字改成新包名，或删掉那一项。',
      ),
    );
  }
  return out;
}

/** ③⑤ 逐个本地插件检查包名一致性、入口可解析、client 模块 id */
function checkPlugins(profileName, profileDir, manifest) {
  const out = [];
  const deps = Object.keys(manifest?.dependencies ?? {});
  const local = deps.filter((d) => !d.startsWith('@deepseek-ai/'));
  const modulesDir = path.join(profileDir, 'node_modules');

  for (const dep of local) {
    const installed = path.join(modulesDir, dep);
    if (!fs.existsSync(installed)) {
      out.push(
        result(
          `missing:${profileName}/${dep}`,
          'error',
          `插件未安装：${dep}`,
          `profiles/${profileName}/node_modules 下找不到这个包（依赖声明还在，实际目录缺失）。`,
          `重装该插件，或把 profiles/${profileName}/package.json 里这一条删掉。`,
        ),
      );
      continue;
    }
    const { value: pkg, error } = safeJson(path.join(installed, 'package.json'));
    if (error || !pkg) {
      out.push(
        result(`pkg:${profileName}/${dep}`, 'warn', `插件清单读不出来：${dep}`, String(error?.message ?? '未知'), '检查该插件目录是否完整。'),
      );
      continue;
    }
    // 包名与本目录名不一致（改名只改了一半的典型症状）
    if (pkg.name !== dep) {
      out.push(
        result(
          `name:${profileName}/${dep}`,
          'error',
          `目录名与包名不一致：${dep}`,
          `node_modules/${dep}/package.json 里的 name 是 "${pkg.name}"，两者对不上时 DSH 解析 bundle 会失败。`,
          '重建 node_modules 链接，或恢复成一致的名字。',
        ),
      );
    }
    // 入口文件存在性
    const entry = pkg.main ? path.join(installed, pkg.main) : undefined;
    if (entry !== undefined && !fs.existsSync(entry)) {
      out.push(
        result(`entry:${profileName}/${dep}`, 'error', `插件入口缺失：${dep}`, `package.json 的 main 指向 ${pkg.main}，但文件不存在。`, '重装该插件。'),
      );
    }
    // client 模块 id 必须等于包名（2026-10-31 那次崩溃）
    const clientFile = path.join(installed, 'client.js');
    if (pkg?.dsh?.client && fs.existsSync(clientFile)) {
      try {
        const text = fs.readFileSync(clientFile, 'utf8');
        const m = /__ModuleLoader__\.load\(\s*\{[\s\S]{0,200}?id:\s*['"]([^'"]+)['"]/u.exec(text);
        const id = m ? m[1] : undefined;
        if (id !== undefined && id !== pkg.name) {
          out.push(
            result(
              `clientid:${profileName}/${dep}`,
              'error',
              `client.js 模块 id 与包名不一致：${dep}`,
              `client.js 里 id 是 "${id}"，包名是 "${pkg.name}"。DSH 按 id 缓存已执行的 bundle，不一致会执行两次并触发 duplicate factory registration，整个界面卡在启动阶段。`,
              `把 ${dep}/client.js 里 __ModuleLoader__.load 的 id 改成 "${pkg.name}"。`,
            ),
          );
        }
      } catch {
        /* 读不出就当没问题，避免影响体检 */
      }
    }
    // 插件的 bundle patch 里 name 必须等于包名
    if (pkg?.dsh?.bundle?.patch) {
      const patchFile = path.join(installed, pkg.dsh.bundle.patch);
      if (fs.existsSync(patchFile)) {
        try {
          const text = fs.readFileSync(patchFile, 'utf8');
          const m = /name:\s*['"]([^'"]+)['"]/u.exec(text);
          const patched = m ? m[1] : undefined;
          if (patched !== undefined && patched !== pkg.name) {
            out.push(
              result(
                `patchname:${profileName}/${dep}`,
                'error',
                `bundle patch 里的 name 与包名不一致：${dep}`,
                `patch 里是 "${patched}"，包名是 "${pkg.name}"，加载时会找不到。`,
                `把那个 patch 文件的 name 改成 "${pkg.name}"。`,
              ),
            );
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out;
}

/** ② 本地登录 cookie 累积：库被锁时只能按体积估算 */
function checkCookieStore() {
  const out = [];
  const candidates = [
    path.join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'),
  ];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const size = fs.statSync(file).size;
      // 空库约 40KB，每条 dsh-auth 约 300 字节；超过 120KB 基本就是攒了几十条
      if (size > 120 * 1024) {
        out.push(
          result(
            'cookies',
            'warn',
            '本地登录 cookie 可能已累积过多',
            `Cookie 库已 ${Math.round(size / 1024)} KB（空库约 40 KB）。每次启动都会新增一条 dsh-auth cookie，累积几十条后请求头超过 16KB，握手返回 431，界面报「Web authentication failed」。`,
            '完全退出 DSH 后删掉该 Cookies 与 Cookies-journal；或运行 ~/.dsh/scripts/dsh-cookie-guard.ps1。',
          ),
        );
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** ⑥ asar 与解包目录并存 */
function checkAsar(resourcesDir) {
  const out = [];
  if (!resourcesDir || !fs.existsSync(resourcesDir)) return out;
  const asar = path.join(resourcesDir, 'app.asar');
  const appDir = path.join(resourcesDir, 'app');
  const hasAsar = fs.existsSync(asar);
  const hasApp = fs.existsSync(appDir);
  if (hasAsar && hasApp) {
    out.push(
      result(
        'asar',
        'warn',
        'app.asar 与解包目录 app 同时存在',
        'Electron 会优先加载 app.asar，所以对 resources\\app 的任何修改都不会生效。',
        '若你在用解包目录，把 app.asar 改名让位；本插件重启时会自动处理。',
      ),
    );
  }
  return out;
}

/** ⑦ 磁盘空间 */
function checkDisk(targetDir) {
  const out = [];
  try {
    const root = path.parse(path.resolve(targetDir)).root;
    if (process.platform === 'win32') {
      // Node 没有跨平台磁盘配额 API，用 statfs 的等价物在 Windows 上不可用，这里跳过
      return out;
    }
    const stat = fs.statfsSync?.(root);
    if (stat && Number.isFinite(stat.bavail)) {
      const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3;
      if (freeGb < 3) {
        out.push(
          result('disk', 'warn', '磁盘剩余空间不足', `安装盘剩余约 ${freeGb.toFixed(1)} GB，更新解包可能半途失败。`, '清理空间后重试。'),
        );
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * ⑧ 崩溃日志回看：scan 最近的 crash-*.log，找出已知的启动失败模式。
 *
 * DSH 启动失败会把现场写进 %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log，
 * 里面有 error 段与 renderer console。这几类都能认出来：
 *   duplicate factory registration → client 模块 id 与包名不一致
 *   entry did not activate / import failed → 插件加载失败
 *   SessionFormatError / producer-owned source kind → 会话日志格式损坏
 */
function checkCrashLogs(days) {
  const out = [];
  const dir = path.join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop', 'logs');
  if (!dir || !fs.existsSync(dir)) return out;
  const cutoff = Date.now() - Math.max(1, days) * 86_400_000;
  const patterns = [
    [/duplicate factory registration/iu, 'client.js 的模块 id 与包名不一致（bundle 被执行两次）'],
    [/entry did not activate|import failed/iu, '客户端插件加载失败'],
    [/SessionFormatError|producer-owned source kind/iu, '会话日志格式损坏，对应会话打不开'],
  ];
  for (const file of fs.readdirSync(dir)) {
    if (!file.startsWith('crash-') || !file.endsWith('.log')) continue;
    const full = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoff) continue;
    const matched = [];
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const [re, label] of patterns) {
      if (!re.test(text)) continue;
      matched.push(label);
    }
    if (matched.length === 0) continue;
    // 一份日志只报一条：同一文件里既有 import failed 又有 did not activate 时，
    // 拆成多条只会刷屏，把匹配到的类型并列写出来更有用。
    out.push(
      result(
        `crash:${file}`,
        'warn',
        `历史启动故障记录（${new Date(stat.mtimeMs).toLocaleString()}）`,
        `${file} 里记录了：${matched.join(' / ')}。若现在能正常启动说明已经修好，这条只是提醒。`,
        '同一问题反复出现时，先确认对应插件的标识是否一致、会话文件是否需要修复。',
      ),
    );
  }
  return out;
}

/** zstd 帧魔数 0xFD2FB528 的小端读出。 */
const ZSTD_MAGIC = 0xfd2fb528;
/** 超过这个体积不做深检：启动前体检不该把时间花在读日志上。 */
const PROBE_LIMIT = 4 * 1024 * 1024;

/**
 * 单个日志文件的浅探测：返回 undefined 表示「看不出问题」，否则返回原因。
 *
 * 判据必须是解压后的内容，不能是压缩后的大小——空会话的 zstd 只有几百字节，
 * 解开来却是一个完全合法的 session 头。2026-10-31 就因此误报过一次
 * 「会话文件异常」，实际上那个会话只是建了从没用过。
 */
function inspectLog(full, size) {
  if (size === 0) return '文件为 0 字节';
  if (size > PROBE_LIMIT) return undefined;
  let raw;
  try {
    raw = fs.readFileSync(full);
  } catch (error) {
    return `读不出来：${error?.message ?? error}`;
  }
  let text;
  if (raw.length >= 4 && raw.readUInt32LE(0) === ZSTD_MAGIC) {
    // 旧运行时没有 zstd，宁可什么都不说，也别拿压缩后大小瞎猜。
    if (typeof zlib.zstdDecompressSync !== 'function') return undefined;
    try {
      text = zlib.zstdDecompressSync(raw).toString('utf8');
    } catch (error) {
      return `zstd 解压失败（${error?.message ?? error}）`;
    }
  } else {
    text = raw.toString('utf8');
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return '解压后没有任何内容';
  try {
    const head = JSON.parse(lines[0]);
    if (head?.type !== 'session') return '首行不是 session 头';
  } catch {
    return '首行不是合法 JSON';
  }
  return undefined;
}

/**
 * ⑨ 会话文件浅检。
 *
 * 坦白说这里只能查"明显异常"（0 字节、异常小）。像 2026-10-31 那次
 * 「一条消息缺 source 字段」的损坏，文件能正常解压、头几帧完全正常，
 * 只有 DSH 自己的 verifier worker 全量重放才查得出来——而那个 worker
 * 需要调用方先提供事件数（只有 DSH 内部持有）。所以这里不做深度校验，
 * 也不假装做了。
 */
function checkSessions(dshHome) {
  const out = [];
  const dir = path.join(dshHome, 'sessions');
  if (!fs.existsSync(dir)) return out;
  const bad = [];
  let checked = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.startsWith('session.') || !entry.name.includes('jsonl')) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      checked += 1;
      const why = inspectLog(full, stat.size);
      if (why) bad.push({ full, why });
    }
  };
  walk(dir);
  for (const item of bad) {
    const sessionId = path.basename(path.dirname(item.full));
    out.push(
      result(
        `session:${sessionId}`,
        'warn',
        `会话文件异常：${sessionId}`,
        `${item.why}，这个会话很可能打不开。`,
        '会话级的损坏无法自动修复；有备份就换回，没有只能放弃这一个会话（其他会话不受影响）。',
      ),
    );
  }
  return { findings: out, checked };
}

/**
 * ⑩ 宿主有没有被第三方补丁改过。
 *
 * 这一项来自一次真实事故：插件写得再对，只要宿主把审批瀑布短路成「一律放行」，
 * 用户就永远等不到授权请求——而所有插件都表现正常、日志一片干净，排查时如果先
 * 怀疑自己的代码，会白花几个小时。所以让它自己说出来。
 *
 * 只读探测，不改任何文件。命中审批短路时升到 warn，其余补丁记为 info（不打扰）。
 */
function checkHostPatches(resources) {
  const out = [];
  if (!resources) return out;
  const base = path.join(resources, 'app', 'dsh', 'node_modules', '@deepseek-ai');
  if (!fs.existsSync(base)) return out;

  const TARGETS = [
    ['dsh-user-approval/lib/index.js', '审批服务'],
    ['dsh-sandbox/lib/index.js', '沙箱'],
    ['dsh-fs-sandbox/lib/index.js', '文件围栏'],
    ['dsh-tool-fs/lib/index.js', '文件工具'],
  ];

  const patched = [];
  for (const [rel, label] of TARGETS) {
    const file = path.join(base, rel);
    if (!fs.existsSync(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!/\[dsh-purge\]|dshpurge/iu.test(text)) continue;
    patched.push(label);

    // 审批瀑布被短路是最要命的一种：任何「等用户授权」的功能都会静默失效
    if (rel.startsWith('dsh-user-approval') && /\[dsh-purge\]\s+approval bypass/iu.test(text)) {
      out.push(
        result(
          'host:approval-bypass',
          'warn',
          '宿主审批被补丁改成「一律自动放行」',
          'dsh-user-approval 里的审批瀑布被替换成直接返回 allowed-once，任何审批请求都不会到达应答者。',
          '依赖审批的功能（邮件审批、界面授权）会静默失效且不报错。要恢复：把该文件从同目录的 .dshpurge.bak 还原，并关掉补丁插件启动时的自动重打（autoApplyOnStart: false）。',
        ),
      );
    }
  }

  if (patched.length > 0) {
    out.push(
      result(
        'host:patched',
        'info',
        `宿主有 ${patched.length} 个模块被第三方补丁改过`,
        `涉及：${patched.join('、')}。这是 dsh-purge 这类工具的正常用法，不是故障。`,
        '插件行为与官方文档不一致时，先怀疑这些补丁，再去查插件本身。',
      ),
    );
  }
  return out;
}

/**
 * 跑完整套体检。
 * @param options.dshHome 数据根（默认 $DSH_HOME 或 ~/.dsh）
 * @param options.resources 桌面端 resources 目录（可选）
 * @param options.crashLogDays 回看多少天内的崩溃日志（默认 7）
 */
export function runPreflight(options = {}) {
  const dshHome = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profilesDir = path.join(dshHome, 'profiles');
  const findings = [];

  const guarded = (fn, label) => {
    try {
      findings.push(...fn());
    } catch (error) {
      findings.push(result(`internal:${label}`, 'warn', `体检项自身出错：${label}`, String(error?.message ?? error), '这一项跳过，其余结果仍然有效。'));
    }
  };

  guarded(() => checkProfileManifest(profilesDir), 'profile-manifest');
  guarded(() => checkCookieStore(), 'cookies');
  guarded(() => checkAsar(options.resources), 'asar');
  guarded(() => checkDisk(dshHome), 'disk');
  // 宿主被第三方补丁改过没有：审批类功能静默失效的头号原因
  guarded(() => checkHostPatches(options.resources), 'host-patches');
  // 崩溃日志回看：把 DSH 自己记下的启动故障翻出来（默认 7 天，可在配置里关掉）
  if (options.crashLogScan !== false) {
    guarded(() => checkCrashLogs(Number(options.crashLogDays) || 7), 'crash-logs');
  }
  // 会话文件浅检（做不到深度格式校验，只查明显异常）
  if (options.sessionCheck !== false) {
    guarded(() => checkSessions(dshHome).findings, 'sessions');
  }

  // 逐 profile 检查插件（依赖清单）
  guarded(() => {
    const out = [];
    if (!fs.existsSync(profilesDir)) return out;
    for (const name of fs.readdirSync(profilesDir)) {
      const dir = path.join(profilesDir, name);
      const manifestFile = path.join(dir, 'package.json');
      if (!fs.existsSync(manifestFile)) continue;
      const { value } = safeJson(manifestFile);
      if (value) out.push(...checkPlugins(name, dir, value));
    }
    return out;
  }, 'plugins');

  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');
  return {
    ok: errors.length === 0,
    checkedAt: Date.now(),
    dshHome,
    errors,
    warnings,
    findings,
  };
}

/** 压成一段人能读的文字（用于工具返回与日志）。 */
export function summarizePreflight(report) {
  if (!report) return '未运行体检';
  if (report.findings.length === 0) return '启动前体检通过，没有发现问题';
  const lines = [];
  if (report.errors.length > 0) {
    lines.push(`发现 ${report.errors.length} 个会导致启动失败的问题：`);
    for (const f of report.errors) lines.push(`  ✗ ${f.title}\n     ${f.detail}\n     → ${f.fix}`);
  }
  if (report.warnings.length > 0) {
    lines.push(`另有 ${report.warnings.length} 个警告：`);
    for (const f of report.warnings) lines.push(`  ! ${f.title}\n     ${f.detail}\n     → ${f.fix}`);
  }
  return lines.join('\n');
}
