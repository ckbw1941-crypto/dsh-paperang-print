// 喵喵机 P2 HD 打印插件的 Host 侧。
// 把面板发来的请求转成对本地 Python 桥（py/mmj_bridge.py）的调用，
// 并把结果包成 { ok, value } / { ok, error } 的信封回给浏览器面板。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-paperang-print'
// 面板请求经由 connection.rpc 或（回落）webServer 前缀路由送达，两者都要求 webServer 已注入。
export const inject = ['webServer']

// 插件配置（写在 profile 的插件行 config 里，全部可选）：
//   dataDir    放待打印队列、日志和设置文件的目录，留空用 %LOCALAPPDATA%\\dsh-paperang
//   pythonPath Python 解释器，留空依次尝试数据目录下的 venv、PATH 里的 python
//   address    打印机蓝牙地址，留空自动扫描名字里带 Paperang 的设备
// 这里手写解析、不依赖 schemastery：本地目录安装时插件包在 profile 之外，额外依赖解析不到。
function readSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  return {
    dataDir: text(raw.dataDir),
    pythonPath: text(raw.pythonPath),
    address: text(raw.address),
  }
}

const RPC_CHANNEL = '/paperang'
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const PY_DIR = join(PACKAGE_DIR, 'py')
const IS_WINDOWS = process.platform === 'win32'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function defaultDataDir() {
  const local = process.env.LOCALAPPDATA
  if (local) return join(local, 'dsh-paperang')
  return join(homedir(), '.dsh-paperang')
}

function pythonName(base) {
  return IS_WINDOWS ? join(base, 'Scripts', 'python.exe') : join(base, 'bin', 'python')
}

export function apply(ctx, config) {
  try {
    activate(ctx, config)
  } catch (error) {
    if (ctx.logger && typeof ctx.logger.error === 'function') {
      ctx.logger.error('[paperang] 插件启动失败：' + ((error && error.stack) || String(error)))
    }
    throw error
  }
}

function activate(ctx, config) {
  const settings = readSettings(config)
  const dataDir = String(settings.dataDir || '').trim() || defaultDataDir()
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    /* 交给后续调用报错 */
  }

  const venvDir = join(dataDir, 'venv')
  const venvPython = pythonName(venvDir)
  const bridge = join(PY_DIR, 'mmj_bridge.py')
  const watcher = join(PY_DIR, 'mmj_watch.py')
  const pidFile = join(dataDir, 'watch.pid')
  const watchDir = join(dataDir, '待打印')
  const logger = ctx.logger

  function pythonForWatch() {
    const picked = pickPython()
    if (!picked.path) return picked.path
    const dir = dirname(picked.path)
    const candidate = join(dir, IS_WINDOWS ? 'pythonw.exe' : 'python')
    return existsSync(candidate) ? candidate : picked.path
  }

  function pickPython() {
    const explicit = String(settings.pythonPath || '').trim()
    if (explicit && existsSync(explicit)) return { path: explicit, source: 'config' }
    if (existsSync(venvPython)) return { path: venvPython, source: 'venv' }
    return { path: IS_WINDOWS ? 'python.exe' : 'python3', source: 'PATH' }
  }

  const childEnv = {
    ...process.env,
    MMJ_DATA: dataDir,
    MMJ_ADDR: String(settings.address || '').trim(),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }

  function rawBridge(payload, timeoutMs) {
    return new Promise((resolve) => {
      let child
      let body = ''
      try {
        body = JSON.stringify(payload)
      } catch (error) {
        resolve({ ok: false, error: { code: 'bad-request', message: '参数无法序列化' } })
        return
      }
      try {
        // 走 stdin：base64 图片动辄几百 KB，塞进命令行会 spawn ENAMETOOLONG（Windows 上限 32767 字符）
        child = spawn(pickPython().path, [bridge], {
          cwd: PY_DIR,
          env: childEnv,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({ ok: false, error: { code: 'spawn-failed', message: String(error && error.message ? error.message : error) } })
        return
      }
      try {
        child.stdin.on('error', () => {
          /* 子进程提前退出时忽略 EPIPE */
        })
        child.stdin.end(body, 'utf8')
      } catch (error) {
        /* ignore */
      }
      let out = ''
      let err = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: { code: 'timeout', message: '打印超时了，检查打印机是否还连着' } })
      }, timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        err += chunk
      })
      child.on('error', (error) => {
        finish({ ok: false, error: { code: 'spawn-failed', message: String(error && error.message ? error.message : error) } })
      })
      child.on('close', () => {
        const line = out.trim().split(/\r?\n/).filter(Boolean).pop()
        if (!line) {
          const tail = (err || '打印服务没有返回结果').trim().slice(-600)
          finish({ ok: false, error: { code: 'no-output', message: tail } })
          return
        }
        try {
          const parsed = JSON.parse(line)
          finish(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: { code: 'bad-output', message: '返回格式不对' } })
        } catch {
          finish({ ok: false, error: { code: 'bad-output', message: line.slice(-600) } })
        }
      })
    })
  }

  async function bridgeCall(payload, timeoutMs) {
    const result = await rawBridge(payload, timeoutMs || 180000)
    if (!result || result.ok !== true) {
      const error = new Error((result && result.error && result.error.message) || '打印服务没有返回结果')
      error.code = (result && result.error && result.error.code) || 'failed'
      throw error
    }
    return result.value
  }

  function readPid() {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      return Number.isFinite(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  function alive(pid) {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function watchStart() {
    const running = readPid()
    if (running && alive(running)) return { running: true, pid: running }
    const child = spawn(pythonForWatch(), [watcher], {
      cwd: PY_DIR,
      env: childEnv,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    for (let i = 0; i < 24; i += 1) {
      await sleep(500)
      const pid = readPid()
      if (pid && alive(pid)) return { running: true, pid }
    }
    return { running: false, pid: null }
  }

  function watchStop() {
    const pid = readPid()
    if (!pid) return { running: false, pid: null }
    try {
      process.kill(pid)
    } catch {
      /* 可能已经退出 */
    }
    return { running: false, pid: null }
  }

  function runCapture(command, args, timeoutMs) {
    return new Promise((resolve) => {
      let out = ''
      let err = ''
      let child
      try {
        child = spawn(command, args, { cwd: PY_DIR, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ code: -1, out: '', err: String(error) })
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }, timeoutMs)
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        err += String(chunk)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: -1, out, err: String(error) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: typeof code === 'number' ? code : -1, out, err })
      })
    })
  }

  async function setupRuntime() {
    const steps = []
    const basePython = String(settings.pythonPath || '').trim() || (IS_WINDOWS ? 'python.exe' : 'python3')
    if (!existsSync(venvPython)) {
      steps.push('创建虚拟环境 ' + venvDir)
      const venv = await runCapture(basePython, ['-m', 'venv', venvDir], 600000)
      if (venv.code !== 0) {
        throw Object.assign(new Error('创建虚拟环境失败，请确认已安装 Python 3.10 以上：' + (venv.err || venv.out).slice(-800)), {
          code: 'setup-failed',
        })
      }
    }
    steps.push('安装依赖（bleak / Pillow / numpy）')
    const pip = await runCapture(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(PY_DIR, 'requirements.txt')], 900000)
    if (pip.code !== 0) {
      throw Object.assign(new Error('安装依赖失败：' + (pip.err || pip.out).slice(-1200)), { code: 'setup-failed' })
    }
    steps.push('完成')
    return { ok: true, steps, dataDir, python: venvPython }
  }

  function resolvePaths() {
    const picked = pickPython()
    return {
      dataDir,
      watchDir,
      python: picked.path,
      pythonSource: picked.source,
      ready: picked.source !== 'PATH' || existsSync(venvPython),
    }
  }

  function openFolder() {
    try {
      const child = spawn('explorer.exe', [watchDir], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return { opened: true, dir: watchDir }
    } catch (error) {
      return { opened: false, dir: watchDir, message: String(error) }
    }
  }

  const handlers = {
    paths: () => resolvePaths(),
    setup: () => setupRuntime(),
    status: () => bridgeCall({ op: 'status' }, 90000),
    print: (payload) => bridgeCall({ op: 'print', ...payload }, 240000),
    preview: (payload) => bridgeCall({ op: 'preview', ...payload }, 60000),
    grab: () => bridgeCall({ op: 'grab' }, 30000),
    test: (payload) => bridgeCall({ op: 'test', ...payload }, 240000),
    settings: () => bridgeCall({ op: 'settings' }, 30000),
    save: (payload) => bridgeCall({ op: 'save', ...payload }, 30000),
    queue: () => bridgeCall({ op: 'queue' }, 30000),
    log: () => bridgeCall({ op: 'log' }, 30000),
    watch: () => bridgeCall({ op: 'watch' }, 30000),
    watchStart,
    watchStop,
    openFolder,
  }

  const invoke = async (endpoint, payload) => {
    const handler = handlers[endpoint]
    if (!handler) {
      return { ok: false, error: { code: 'bad-request', message: '未知操作：' + String(endpoint) } }
    }
    try {
      const value = await handler(payload && typeof payload === 'object' ? payload : {})
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: (error && error.code) || 'failed',
          message: String(error && error.message ? error.message : error),
        },
      }
    }
  }

  let dispose = null
  let via = 'none'

  try {
    const connection = ctx.get('connection')
    if (connection && connection.rpc && typeof connection.rpc.handle === 'function') {
      dispose = connection.rpc.handle(RPC_CHANNEL, invoke)
      via = 'connection'
    }
  } catch (error) {
    logger?.warn?.('[paperang] connection RPC 不可用，改用本地 HTTP 路由：' + describe(error))
  }

  if (!dispose) {
    dispose = installWebRoute(ctx, invoke, logger)
    if (dispose) via = 'webServer'
  }

  if (!dispose) {
    logger?.warn?.('[paperang] 没有可用的 Host 通道，打印面板点不动')
    return
  }

  logger?.info?.('[paperang] 打印通道已就绪（' + via + '）')

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }, 'paperang.rpc()')
  }
}

function describe(error) {
  return String((error && error.message) || error)
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
}

function stripPort(raw) {
  const text = String(raw || '').trim()
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end === -1 ? text : text.slice(1, end)
  }
  const colon = text.indexOf(':')
  return colon === -1 ? text : text.slice(0, colon)
}

function isLoopbackName(host) {
  const value = normalizeHost(host)
  if (LOOPBACK_NAMES.has(value)) return true
  return /^127\./.test(value)
}

function isTrustedLocalRequest(request, webServer) {
  const headers = request.headers || {}
  const rawHost = String(headers.host || '')
  if (!rawHost) return false
  const hostname = stripPort(rawHost)
  if (!isLoopbackName(hostname)) {
    let bindHost
    try {
      bindHost = webServer.host
    } catch {
      bindHost = undefined
    }
    if (typeof bindHost !== 'string' || normalizeHost(bindHost) !== normalizeHost(hostname)) return false
  }
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const origin = String(headers.origin || '')
  if (origin) {
    try {
      if (normalizeHost(new URL(origin).host) !== normalizeHost(rawHost)) return false
    } catch {
      return false
    }
  }
  return true
}

async function readJsonBody(request, limitBytes = 32 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > limitBytes) return null
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function installWebRoute(ctx, invoke, logger) {
  let webServer = null
  try {
    webServer = ctx.get('webServer')
  } catch (error) {
    logger?.warn?.('[paperang] webServer 服务取不到：' + describe(error))
    return null
  }
  if (!webServer || typeof webServer.register !== 'function') return null

  const route = {
    kind: 'prefix',
    path: RPC_CHANNEL,
    async handler(request, response) {
      try {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'text/plain' })
          response.end('method not allowed')
          return
        }
        if (!isTrustedLocalRequest(request, webServer)) {
          response.writeHead(403, { 'content-type': 'text/plain' })
          response.end('forbidden')
          return
        }
        if (String(request.headers && request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          response.writeHead(415, { 'content-type': 'text/plain' })
          response.end('content type must be application/json')
          return
        }
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object' || body.type !== 'client-request' || typeof body.method !== 'string') {
          response.writeHead(400, { 'content-type': 'text/plain' })
          response.end('invalid envelope')
          return
        }
        const prefix = RPC_CHANNEL + '/'
        const pathname = String(request.url || '').split('?', 1)[0]
        if (!pathname.startsWith(prefix)) {
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('not found')
          return
        }
        const result = await invoke(pathname.slice(prefix.length), body.payload)
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
      } catch (error) {
        logger?.warn?.('[paperang] 本地 HTTP 路由出错：' + describe(error))
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('internal error')
      }
    },
  }

  try {
    return webServer.register(route)
  } catch (error) {
    logger?.warn?.('[paperang] 本地 HTTP 路由注册失败：' + describe(error))
    return null
  }
}
