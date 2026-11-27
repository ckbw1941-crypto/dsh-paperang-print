// 喵喵机 P2 HD 打印面板（浏览器侧）。
// 左侧菜单项 + 主区域面板：打印文字/图片/剪贴板、浓度与走纸、打印机状态、
// 自动打印守护进程开关、最近记录。所有动作都通过 connection RPC 交给 Host。
window.__ModuleLoader__.load({
  id: 'dsh-paperang-print',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ID = 'dsh-paperang-print'
    const RPC = '/paperang'
    const { useState, useEffect, useCallback, useRef } = React

    let conn = null
    let transport = 'probe'

    const CSS = `
.mmj-panel{padding:22px 26px 44px;max-width:780px;font-size:13px;line-height:1.65;box-sizing:border-box;height:100%;max-height:100vh;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin}
.mmj-head{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.mmj-head .mmj-ico{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;border:1px solid color-mix(in srgb,currentColor 18%,transparent);flex-shrink:0}
.mmj-head h1{font-size:16px;font-weight:600;margin:0}
.mmj-head p{margin:2px 0 0;opacity:.6;font-size:12px}
.mmj-card{border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:12px;padding:14px 16px;margin-bottom:12px}
.mmj-card>h2{font-size:12px;font-weight:600;margin:0 0 10px;opacity:.72}
.mmj-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mmj-btn{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;cursor:pointer}
.mmj-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}
.mmj-btn:disabled{opacity:.45;cursor:default}
.mmj-btn.primary{border-color:color-mix(in srgb,currentColor 40%,transparent);font-weight:600;background:color-mix(in srgb,currentColor 9%,transparent)}
.mmj-in,.mmj-ta{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);color:inherit;resize:vertical}
.mmj-ta{min-height:74px}
.mmj-kv{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:3px 0;border-bottom:1px dashed color-mix(in srgb,currentColor 10%,transparent)}
.mmj-kv b{font-weight:600}
.mmj-kv span:first-child{opacity:.6}
.mmj-note{font-size:12.5px;padding:8px 12px;border-radius:8px;margin-bottom:10px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);background:color-mix(in srgb,currentColor 5%,transparent)}
.mmj-note.err{border-color:color-mix(in srgb,#e5534b 45%,transparent)}
.mmj-badge{display:inline-flex;align-items:center;gap:6px;font-size:12.5px}
.mmj-dot{width:7px;height:7px;border-radius:50%;background:color-mix(in srgb,currentColor 28%,transparent)}
.mmj-dot.on{background:#3fb950}
.mmj-list{margin:0;padding:0;list-style:none;font-size:12.5px}
.mmj-list li{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dashed color-mix(in srgb,currentColor 10%,transparent)}
.mmj-list li span:last-child{opacity:.5;flex-shrink:0}
.mmj-log{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;opacity:.8;margin:0}
.mmj-hint{font-size:11.5px;opacity:.55;margin-top:10px}
.mmj-slider{display:flex;align-items:center;gap:10px}
.mmj-slider input[type=range]{flex:1;accent-color:currentColor}
.mmj-num{width:62px}
.mmj-label{display:flex;align-items:center;gap:8px;font-size:12.5px;opacity:.85}
.mmj-drop{border:1px dashed color-mix(in srgb,currentColor 24%,transparent);border-radius:10px;padding:14px;text-align:center;cursor:pointer;outline:none}
.mmj-drop:hover,.mmj-drop.over{border-color:color-mix(in srgb,currentColor 45%,transparent);background:color-mix(in srgb,currentColor 4%,transparent)}
.mmj-drop-t{font-size:12.5px;opacity:.85}
.mmj-file{font-size:12px;opacity:.7;margin-bottom:8px}
.mmj-thumb{max-width:100%;max-height:150px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);display:block;margin:0 auto 10px}
.mmj-preview{margin-top:12px;border-top:1px dashed color-mix(in srgb,currentColor 14%,transparent);padding-top:10px}
.mmj-prev-img{width:100%;max-height:420px;object-fit:contain;image-rendering:pixelated;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);margin:8px 0;display:block}
`

    function installStyles(css) {
      const node = document.createElement('style')
      node.setAttribute('data-dsh-paperang', '1')
      node.textContent = css
      document.head.appendChild(node)
      return () => {
        try {
          node.remove()
        } catch {
          /* ignore */
        }
      }
    }

    function connOf(ctx) {
      try {
        const found = ctx.get('connection')
        if (found && found.rpc && typeof found.rpc.call === 'function') return found
      } catch {
        /* ignore */
      }
      return null
    }

    // 只读操作可以在 RPC 传输出问题时改走 HTTP 兜底；
    // 打印/保存/开关这类有副作用的操作绝不重试，否则可能重复出纸。
    const READONLY_CALLS = { preview: 1, grab: 1, status: 1, settings: 1, queue: 1, log: 1, watch: 1 }

    async function call(method, payload) {
      const body = payload && typeof payload === 'object' ? payload : {}
      const transport = await resolveTransport()
      if (transport === 'connection') {
        try {
          return unwrap(await conn.rpc.call(RPC, method, body))
        } catch (error) {
          const business = error && error.code
          if (!business && READONLY_CALLS[method]) {
            try {
              const fallback = await fetchRpc(method, body)
              return unwrap(fallback && fallback.result)
            } catch {
              /* 兜底也失败就报原始错误 */
            }
          }
          throw error instanceof Error ? error : new Error(String(error))
        }
      }
      if (transport === 'fetch') {
        const res = await fetchRpc(method, body)
        return unwrap(res && res.result)
      }
      const error = new Error('没有连上 DSH 的本地服务，重启一次 DSH 试试')
      error.code = 'no-connection'
      throw error
    }

    function unwrap(res) {
      if (!res || res.ok !== true) {
        const error = new Error((res && res.error && res.error.message) || '操作失败')
        error.code = res && res.error && res.error.code
        throw error
      }
      return res.value
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = () => reject(new Error('这张图读不出来'))
          reader.readAsDataURL(file)
        } catch (error) {
          reject(new Error('浏览器读不了这张图：' + ((error && error.message) || error)))
        }
      })
    }

    function newRpcId() {
      return 'paperang-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 10)
    }

    async function fetchRpc(method, body) {
      const response = await fetch(RPC.slice(1) + '/' + method, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: newRpcId(), method, payload: body }),
      })
      if (!response.ok) throw new Error('本地服务返回 ' + response.status)
      return response.json()
    }

    // 先探一次轻量的 settings，确定唯一可用的通道；后续动作只走那一条，避免重复打印。
    async function resolveTransport() {
      if (transport !== 'probe') return transport
      if (conn) {
        try {
          const res = await conn.rpc.call(RPC, 'settings', {})
          if (res && typeof res === 'object') transport = 'connection'
        } catch {
          /* 试下一条 */
        }
      }
      if (transport === 'probe') {
        try {
          const envelope = await fetchRpc('settings', {})
          if (envelope && envelope.result) transport = 'fetch'
        } catch {
          /* 两条都不通 */
        }
      }
      return transport
    }

    const fmtSize = (bytes) => {
      if (!bytes) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }

    function SidebarIcon(props) {
      const size = (props && props.size) || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3.6 5.6V2.4h8.8v3.2' }),
        h('rect', { x: 1.8, y: 5.6, width: 12.4, height: 5.6, rx: 1.3 }),
        h('path', { d: 'M4.4 9.6h7.2v4H4.4z' }),
        h('path', { d: 'M11.6 7.3h.01' })
      )
    }

    function Panel() {
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      const [status, setStatus] = useState(null)
      const [density, setDensity] = useState(80)
      const [feed, setFeed] = useState(30)
      const [text, setText] = useState('')
      const [fontSize, setFontSize] = useState(30)
      const [path, setPath] = useState('')
      const [doc, setDoc] = useState(false)
      const [dither, setDither] = useState(true)
      const [scale, setScale] = useState(100)
      const [rotate, setRotate] = useState(0)
      const [image, setImage] = useState(null)
      const [preview, setPreview] = useState(null)
      const [shortcut, setShortcut] = useState({ set: false, name: '' })
      const [dragOver, setDragOver] = useState(false)
      const [queue, setQueue] = useState({ pending: [], done: [], dir: '' })
      const [watching, setWatching] = useState({ running: false, pid: null })
      const [logs, setLogs] = useState([])
      const [env, setEnv] = useState(null)
      // 彩蛋：双击左上角图标，或连点标题 5 下
      const eggRef = useRef({ icon: { n: 0, last: 0 }, title: { n: 0, last: 0 }, lastEmit: 0 })

      const run = useCallback(async (label, fn) => {
        setBusy(label)
        setNote(null)
        try {
          return await fn()
        } catch (error) {
          setNote({ kind: 'err', text: (error && error.message) || String(error) })
          return null
        } finally {
          setBusy('')
        }
      }, [])

      // 彩蛋：双击图标 或 连点标题 5 下 → 随机打一张 <数据目录>/彩蛋 里的图
      // 快捷：连点图标 3 下 → 打「设为连按 3 下」的那张图（2 下要等 420ms 才认，免得和 3 下打架）
      const fireEgg = () => {
        const now = Date.now()
        if (now - eggRef.current.lastEmit < 3000) return
        eggRef.current.lastEmit = now
        run('彩蛋正在打印…', async () => {
          const value = await call('egg')
          const name = (value && value.name) || '彩蛋'
          const count = (value && value.count) || 1
          setNote({ kind: 'ok', text: '🎉 你点到了隐藏彩蛋：' + name + '（这个文件夹里现在有 ' + count + ' 张）' })
        })
      }

      const fireShortcut = () => {
        const now = Date.now()
        if (now - eggRef.current.lastEmit < 3000) return
        eggRef.current.lastEmit = now
        run('正在打印连按 3 下的那张图…', async () => {
          const value = await call('shortcutPrint')
          const name = (value && value.name) || '快捷图'
          const rows = (value && value.rows) || 0
          setNote({ kind: 'ok', text: '🖨️ 已打印「' + name + '」（' + rows + ' 行）' })
        })
      }

      const bumpEgg = (key, need, windowMs) => {
        const now = Date.now()
        const state = eggRef.current[key]
        if (now - state.last > windowMs) state.n = 0
        state.last = now
        state.n += 1
        if (state.n >= need) {
          state.n = 0
          fireEgg()
        }
      }

      const eggIcon = () => {
        const now = Date.now()
        const state = eggRef.current.icon
        if (now - state.last > 900) state.n = 0
        state.last = now
        state.n += 1
        if (state.timer) clearTimeout(state.timer)
        if (state.n >= 3) {
          state.n = 0
          fireShortcut()
          return
        }
        state.timer = setTimeout(() => {
          const times = eggRef.current.icon
          if (times.n >= 2) {
            times.n = 0
            fireEgg()
          }
        }, 420)
      }
      const eggTitle = () => bumpEgg('title', 5, 1500)

      const loadQueue = useCallback(async () => {
        try {
          const value = await call('queue')
          if (value) setQueue(value)
        } catch {
          /* 静默：队列读不到不影响打印 */
        }
      }, [])

      const loadLogs = useCallback(async () => {
        try {
          const value = await call('log')
          if (value && Array.isArray(value.lines)) setLogs(value.lines)
        } catch {
          /* 静默 */
        }
      }, [])

      const loadWatch = useCallback(async () => {
        try {
          const value = await call('watch')
          if (value) setWatching(value)
        } catch {
          /* 静默 */
        }
      }, [])

      const loadEnv = useCallback(async () => {
        try {
          const value = await call('paths')
          if (value) setEnv(value)
        } catch {
          /* 静默 */
        }
      }, [])

      const loadShortcut = useCallback(async () => {
        try {
          const value = await call('shortcutInfo')
          if (value) setShortcut({ set: Boolean(value.set), name: value.name || '' })
        } catch {
          /* 静默：读不到不影响打印 */
        }
      }, [])

      const setupEnv = () =>
        run('正在准备打印环境（首次约 1–2 分钟，需要能访问 PyPI）…', async () => {
          const value = await call('setup')
          await loadEnv()
          const steps = (value && value.steps) || []
          setNote({ kind: 'ok', text: '环境已就绪：' + steps.join(' → ') })
        })

      useEffect(() => {
        let cancelled = false
        const boot = async () => {
          await loadEnv()
          try {
            const settings = await call('settings')
            if (!cancelled && settings) {
              setDensity(settings.density)
              setFeed(settings.feed)
              if (typeof settings.dither === 'boolean') setDither(settings.dither)
            }
          } catch (error) {
            if (!cancelled) setNote({ kind: 'err', text: (error && error.message) || String(error) })
          }
          await loadWatch()
          await loadQueue()
          await loadLogs()
          await loadShortcut()
        }
        void boot()
        return () => {
          cancelled = true
        }
      }, [loadWatch, loadQueue, loadLogs, loadEnv, loadShortcut])

      // 面板里任意位置按 Ctrl+V 都能贴图（只要剪贴板里有图片），不用先点输入框
      useEffect(() => {
        const onWindowPaste = (event) => {
          const data = event.clipboardData
          if (!data) return
          const items = data.items || []
          for (let index = 0; index < items.length; index += 1) {
            const item = items[index]
            if (item && typeof item.type === 'string' && item.type.indexOf('image/') === 0) {
              event.preventDefault()
              const file = item.getAsFile()
              if (file) {
                readFileAsDataUrl(file)
                  .then((url) => {
                    setImage({ name: '粘贴的图片', b64: url })
                    setPreview(null)
                    setNote({ kind: 'ok', text: '图片已经贴进来了，点「生成预览」看看打印效果。' })
                  })
                  .catch((error) => setNote({ kind: 'err', text: (error && error.message) || String(error) }))
              }
              return
            }
          }
        }
        window.addEventListener('paste', onWindowPaste)
        return () => window.removeEventListener('paste', onWindowPaste)
      }, [])

      const saveShortcut = async () => {
        if (!image) {
          setNote({ kind: 'err', text: '先粘贴或选一张图片，再点这里' })
          return
        }
        try {
          await call('shortcutSet', { image_b64: image.b64, name: image.name })
          await loadShortcut()
          setNote({ kind: 'ok', text: '记住了：连按左上角小图标 3 下就会打印这张图。' })
        } catch (error) {
          setNote({ kind: 'err', text: (error && error.message) || String(error) })
        }
      }

      const refreshStatus = () =>
        run('正在连打印机…', async () => {
          const value = await call('status')
          setStatus(value)
          if (value && value.connected) setNote({ kind: 'ok', text: '已经连上打印机。' })
          else setNote({ kind: 'err', text: '打印机没有回应。' })
        })

      const printText = () =>
        run('正在打印文字…', async () => {
          if (!text.trim()) throw new Error('先写点要打印的文字')
          const value = await call('print', { text, font_size: Number(fontSize) || 30 })
          setNote({ kind: 'ok', text: `已打印「${value.name}」，${value.rows} 行，用时 ${value.seconds}s。` })
          await loadQueue()
          await loadLogs()
        })

      const printImage = () =>
        run('正在打印图片…', async () => {
          if (!path.trim()) throw new Error('先填一张图片的完整路径，或者直接把文件拖到桌面「喵喵机待打印」')
          const value = await call('print', { path, doc, dither, rotate: Number(rotate) || 0 })
          setNote({ kind: 'ok', text: `已打印「${value.name}」，${value.rows} 行，用时 ${value.seconds}s。` })
          await loadQueue()
          await loadLogs()
        })

      const printClip = () =>
        run('正在打印剪贴板…', async () => {
          const value = await call('print', { clip: true, doc, dither, rotate: Number(rotate) || 0 })
          setNote({ kind: 'ok', text: `已打印「${value.name}」，${value.rows} 行，用时 ${value.seconds}s。` })
          await loadQueue()
          await loadLogs()
        })

      const payloadOf = () => {
        if (image && image.b64) return { image_b64: image.b64, name: image.name || '粘贴的图片', doc, dither, scale: Number(scale) || 1, rotate: Number(rotate) || 0 }
        if (text.trim()) return { text, font_size: Number(fontSize) || 30, dither }
        return null
      }

      const takeImage = (name, dataUrl) => {
        setImage({ name, b64: dataUrl })
        setPreview(null)
        setNote(null)
      }

      const onPasteImage = (event) => {
        const data = event.clipboardData
        if (!data) return
        const items = data.items || []
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]
          if (item && typeof item.type === 'string' && item.type.indexOf('image/') === 0) {
            event.preventDefault()
            const file = item.getAsFile()
            if (file) {
              readFileAsDataUrl(file)
                .then((url) => takeImage('粘贴的图片', url))
                .catch((error) => setNote({ kind: 'err', text: (error && error.message) || String(error) }))
            }
            return
          }
        }
      }

      const onDropImage = (event) => {
        const data = event.dataTransfer
        setDragOver(false)
        if (!data || !data.files || !data.files.length) return
        event.preventDefault()
        const file = data.files[0]
        if (!file.type || file.type.indexOf('image/') !== 0) {
          setNote({ kind: 'err', text: '拖进来的不是图片文件' })
          return
        }
        readFileAsDataUrl(file)
          .then((url) => takeImage(file.name || '拖进来的图片', url))
          .catch((error) => setNote({ kind: 'err', text: (error && error.message) || String(error) }))
      }

      const grabClipboard = () =>
        run('正在读系统剪贴板…', async () => {
          const value = await call('grab')
          takeImage(value.name, value.image_b64)
          setNote({ kind: 'ok', text: `已读取「${value.name}」（${value.width}×${value.height}），可以预览或直接打印。` })
        })

      const buildPreview = () =>
        run('正在生成预览…', async () => {
          const payload = payloadOf()
          if (!payload) throw new Error('先粘贴一张图，或者在文字框里写点内容')
          const value = await call('preview', payload)
          setPreview(value)
          setNote({ kind: 'ok', text: `预览好了：${value.rows} 行，约 ${value.mm} mm 长。` })
        })

      const printPreview = () =>
        run('正在打印…', async () => {
          const payload = payloadOf()
          if (!payload) throw new Error('先粘贴一张图，或者在文字框里写点内容')
          const value = await call('print', payload)
          setNote({ kind: 'ok', text: `已打印「${value.name}」，${value.rows} 行，用时 ${value.seconds}s。` })
          setPreview(null)
          await loadQueue()
          await loadLogs()
        })

      const printTest = () =>
        run('正在打印测试条…', async () => {
          const value = await call('test', { density })
          setNote({ kind: 'ok', text: `测试条已发出（浓度 ${value.density}），看纸上哪块最清楚。` })
        })

      const saveSettings = () =>
        run('正在保存…', async () => {
          const value = await call('save', { density: Number(density), feed: Number(feed), dither })
          setDensity(value.density)
          setFeed(value.feed)
          if (typeof value.dither === 'boolean') setDither(value.dither)
          setNote({ kind: 'ok', text: `已保存：浓度 ${value.density}，尾部走纸 ${value.feed} 行，灰阶${value.dither ? '开' : '关'}。` })
        })

      const onDitherChange = (checked) => {
        setDither(checked)
        setPreview(null)
        call('save', { density: Number(density), feed: Number(feed), dither: checked })
          .then(() => setNote({ kind: 'ok', text: checked ? '灰阶开：照片用抖动模拟深浅。' : '灰阶关：只打纯黑白。自动打印也跟着改。' }))
          .catch(() => {
            /* 存不上就只影响这次 */
          })
      }

      const startWatch = () =>
        run('正在启动自动打印…', async () => {
          const value = await call('watchStart')
          setWatching(value)
          await loadLogs()
          if (value && value.running) setNote({ kind: 'ok', text: `自动打印已开启（进程 ${value.pid}）。` })
          else setNote({ kind: 'err', text: '自动打印没起来，看看日志。' })
        })

      const stopWatch = () =>
        run('正在停止自动打印…', async () => {
          const value = await call('watchStop')
          setWatching(value)
          await loadLogs()
          setNote({ kind: 'ok', text: '自动打印已停止。' })
        })

      const openFolder = () =>
        run('', async () => {
          await call('openFolder')
        })

      useEffect(() => {
        if (!image || !image.b64) return undefined
        let cancelled = false
        const timer = setTimeout(() => {
          const payload = payloadOf()
          if (!payload) return
          call('preview', payload)
            .then((value) => {
              if (!cancelled) setPreview(value)
            })
            .catch(() => {
              /* 自动预览失败就让用户手点 */
            })
        }, 450)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [image, scale, rotate, dither, doc])

      const disabled = Boolean(busy)

      const statusRows = []
      if (status) {
        statusRows.push(['打印机', status.connected ? '已连接' : '未连接'])
        if (status.version) statusRows.push(['固件', status.version])
        if (status.sn) statusRows.push(['序列号', status.sn])
        if (status.battery != null) statusRows.push(['电量', status.battery + '%'])
        if (status.dpi) statusRows.push(['分辨率', status.dpi + ' dpi'])
        if (status.paper != null) statusRows.push(['纸张', status.paper ? '有纸' : '没有纸'])
        if (status.lid != null) statusRows.push(['上盖', status.lid ? '已合上' : '没合上'])
      }

      return h(
        'div',
        { className: 'mmj-panel' },
        h(
          'div',
          { className: 'mmj-head' },
          h('div', { className: 'mmj-ico', onClick: eggIcon }, h(SidebarIcon, { size: 20 })),
          h(
            'div',
            null,
            h('h1', { onClick: eggTitle }, '喵喵机打印'),
            h('p', null, 'P2 HD · 蓝牙直连 · 57mm 热敏')
          )
        ),
        busy ? h('div', { className: 'mmj-note' }, busy) : null,
        note ? h('div', { className: note.kind === 'err' ? 'mmj-note err' : 'mmj-note' }, note.text) : null,

        env && !env.ready
          ? h(
              'div',
              { className: 'mmj-card' },
              h('h2', null, '先准备打印环境'),
              h(
                'p',
                { className: 'mmj-hint', style: { margin: '0 0 10px' } },
                '这个插件靠本地 Python 连蓝牙打印机。第一次使用要建一个独立的虚拟环境并装上 bleak / Pillow / numpy，需要能访问 PyPI，大约 1–2 分钟。装好一次就行。'
              ),
              h(
                'div',
                { className: 'mmj-row' },
                h('button', { className: 'mmj-btn primary', disabled, onClick: setupEnv }, '准备打印环境'),
                h('button', { className: 'mmj-btn', disabled, onClick: () => run('', loadEnv) }, '重新检测')
              ),
              env.dataDir
                ? h(
                    'p',
                    { className: 'mmj-hint' },
                    '数据目录：' + env.dataDir + (env.python ? '　当前解释器：' + env.python : '')
                  )
                : null
            )
          : null,

        h(
          'div',
          { className: 'mmj-card' },
          h('h2', null, '打印文字'),
          h('textarea', {
            className: 'mmj-ta',
            value: text,
            placeholder: '写要打印的内容，支持多行。例如：明天的待办 / 收货地址 / 一道错题',
            onChange: (event) => setText(event.target.value),
          }),
          h(
            'div',
            { className: 'mmj-row', style: { marginTop: '10px' } },
            h(
              'label',
              { className: 'mmj-label' },
              '字号',
              h('input', {
                className: 'mmj-in mmj-num',
                type: 'number',
                min: 16,
                max: 64,
                value: fontSize,
                onChange: (event) => setFontSize(event.target.value),
              })
            ),
            h('button', { className: 'mmj-btn primary', disabled, onClick: printText }, '打印文字'),
            h('button', { className: 'mmj-btn', disabled, onClick: printTest }, '打印浓度测试条')
          )
        ),

        h(
          'div',
          { className: 'mmj-card' },
          h('h2', null, '图片：粘贴 / 拖入'),
          h(
            'div',
            {
              className: dragOver ? 'mmj-drop over' : 'mmj-drop',
              tabIndex: 0,
              onPaste: onPasteImage,
              onDragOver: (event) => {
                event.preventDefault()
                setDragOver(true)
              },
              onDragLeave: () => setDragOver(false),
              onDrop: onDropImage,
            },
            image
              ? h(
                  'div',
                  null,
                  h('div', { className: 'mmj-file' }, '已就绪：' + image.name),
                  h('img', { className: 'mmj-thumb', src: image.b64, alt: image.name }),
                  h(
                    'button',
                    {
                      className: 'mmj-btn',
                      onClick: () => {
                        setImage(null)
                        setPreview(null)
                      },
                    },
                    '清除这张'
                  )
                )
              : h(
                  'div',
                  null,
                  h('div', { className: 'mmj-drop-t' }, '点一下这里，再按 Ctrl+V 粘贴截图'),
                  h('div', { className: 'mmj-hint', style: { marginTop: '6px' } }, '也可以把图片文件直接拖进来，不用先存到电脑上。')
                )
          ),
          h(
            'div',
            { className: 'mmj-row', style: { marginTop: '12px' } },
            h('button', { className: 'mmj-btn', disabled, onClick: grabClipboard }, '从剪贴板读取'),
            h(
              'label',
              { className: 'mmj-label' },
              h('input', {
                type: 'checkbox',
                checked: dither,
                onChange: (event) => onDitherChange(event.target.checked),
              }),
              '灰阶打印'
            ),
            h(
              'label',
              { className: 'mmj-label' },
              h('input', {
                type: 'checkbox',
                checked: doc,
                onChange: (event) => {
                  setDoc(event.target.checked)
                  setPreview(null)
                },
              }),
              '截图/文档模式'
            )
          ),
          h(
            'div',
            { className: 'mmj-row', style: { marginTop: '12px' } },
            h('span', { className: 'mmj-label' }, '旋转'),
            h(
              'button',
              {
                className: 'mmj-btn',
                disabled,
                title: '逆时针转 90°',
                onClick: () => setRotate((value) => (value + 270) % 360),
              },
              '↺ 左转'
            ),
            h(
              'button',
              {
                className: 'mmj-btn',
                disabled,
                title: '顺时针转 90°',
                onClick: () => setRotate((value) => (value + 90) % 360),
              },
              '↻ 右转'
            ),
            h('span', { className: 'mmj-hint', style: { margin: 0 } }, rotate === 0 ? '未旋转' : '已转 ' + rotate + '°'),
            h('button', { className: 'mmj-btn', disabled, onClick: () => setRotate(0) }, '复位'),
            h('span', { className: 'mmj-label' }, '缩放'),
            h('input', {
              type: 'range',
              min: 20,
              max: 100,
              step: 5,
              value: scale,
              disabled,
              onChange: (event) => setScale(Number(event.target.value)),
              style: { flex: '1', accentColor: 'currentColor', minWidth: '120px' },
            }),
            h('span', { className: 'mmj-label', style: { width: '42px', justifyContent: 'flex-end' } }, scale + '%')
          ),
          h('div', { className: 'mmj-hint' }, '照片太长就往下拖：内容按比例缩小、左右留白，纸上的长度跟着变短。'),
          h('div', { className: 'mmj-hint' }, '灰阶开着用抖动模拟深浅，适合照片；关掉只打纯黑白，颗粒更粗但字更硬。'),
          h(
            'div',
            { className: 'mmj-row', style: { marginTop: '12px' } },
            h('button', { className: 'mmj-btn', disabled, onClick: printClip }, '直接用剪贴板打印')
          ),
          h('div', { className: 'mmj-hint' }, '连按左上角小图标 3 下 → 打印你指定的那张图（下面这张按钮设的）。'),
          h(
            'div',
            { className: 'mmj-row', style: { marginTop: '8px' } },
            h('button', { className: 'mmj-btn', disabled: busy || !image, onClick: saveShortcut }, '设为连按 3 下要打印的图'),
            h(
              'span',
              { className: 'mmj-hint', style: { margin: 0 } },
              shortcut.set ? '当前：' + shortcut.name : '还没设置'
            )
          ),
          h('div', { className: 'mmj-hint' }, '也可以按路径打印：'),
          h('input', {
            className: 'mmj-in',
            value: path,
            placeholder: '图片完整路径，例如 C:\\Users\\ckbw\\Pictures\\a.png',
            onChange: (event) => setPath(event.target.value),
            style: { marginTop: '6px' },
          }),
          h(
            'div',
            { className: 'mmj-row', style: { marginTop: '8px' } },
            h('button', { className: 'mmj-btn', disabled, onClick: printImage }, '按路径打印')
          )
        ),

        h(
          'div',
          { className: 'mmj-card' },
          h('h2', null, '打印预览'),
          h(
            'div',
            { className: 'mmj-row' },
            h('button', { className: 'mmj-btn primary', disabled, onClick: buildPreview }, '生成预览'),
            h(
              'span',
              { className: 'mmj-hint', style: { margin: 0 } },
              image ? '预览这张图片：' + image.name : text.trim() ? '预览文字框里的内容' : '先粘贴图片或写点文字'
            )
          ),
          preview
            ? h(
                'div',
                { className: 'mmj-preview' },
                h(
                  'div',
                  { className: 'mmj-kv' },
                  h('span', null, '打印效果'),
                  h('b', null, `${preview.rows} 行 · ${preview.mm} mm · 浓度 ${preview.density} · ${preview.dither ? '灰阶' : '纯黑白'} · 宽 ${preview.scale}%`)
                ),
                h('img', { className: 'mmj-prev-img', src: preview.preview, alt: '打印预览' }),
                preview.shown_rows < preview.rows
                  ? h('div', { className: 'mmj-hint' }, '预览只截了上半截，实际会打完整。')
                  : null,
                h(
                  'div',
                  { className: 'mmj-row' },
                  h('button', { className: 'mmj-btn primary', disabled, onClick: printPreview }, '就按这个打印'),
                  h('button', { className: 'mmj-btn', disabled, onClick: () => setPreview(null) }, '关掉预览')
                )
              )
            : null
        ),

        h(
          'div',
          { className: 'mmj-card' },
          h('h2', null, '浓度与走纸'),
          h(
            'div',
            { className: 'mmj-slider' },
            h('span', { className: 'mmj-label' }, '浓度'),
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              value: density,
              onChange: (event) => setDensity(event.target.value),
            }),
            h('b', null, String(density))
          ),
          h(
            'div',
            { className: 'mmj-slider', style: { marginTop: '6px' } },
            h('span', { className: 'mmj-label' }, '走纸'),
            h('input', {
              type: 'range',
              min: 0,
              max: 120,
              value: feed,
              onChange: (event) => setFeed(event.target.value),
            }),
            h('b', null, String(feed))
          ),
          h(
            'div',
            { className: 'mmj-row', style: { marginTop: '10px' } },
            h('button', { className: 'mmj-btn', disabled, onClick: saveSettings }, '保存并应用'),
            h('span', { className: 'mmj-hint', style: { margin: 0 } }, '浓度高了字会发糊，低了偏淡；改完对自动打印也生效。')
          )
        ),

        h(
          'div',
          { className: 'mmj-card' },
          h('h2', null, '打印机状态'),
          h(
            'div',
            { className: 'mmj-row', style: { marginBottom: statusRows.length ? '10px' : 0 } },
            h('button', { className: 'mmj-btn', disabled, onClick: refreshStatus }, '连接并刷新'),
            h(
              'span',
              { className: 'mmj-badge' },
              h('i', { className: status && status.connected ? 'mmj-dot on' : 'mmj-dot' }),
              status && status.connected ? '已连接' : '未连接'
            )
          ),
          statusRows.length
            ? h(
                'div',
                null,
                statusRows.map(([key, value]) =>
                  h('div', { className: 'mmj-kv', key }, h('span', null, key), h('b', null, String(value)))
                )
              )
            : null
        ),

        h(
          'div',
          { className: 'mmj-card' },
          h('h2', null, '自动打印文件夹'),
          h(
            'div',
            { className: 'mmj-row', style: { marginBottom: '10px' } },
            h(
              'span',
              { className: 'mmj-badge' },
              h('i', { className: watching && watching.running ? 'mmj-dot on' : 'mmj-dot' }),
              watching && watching.running ? '运行中（' + watching.pid + '）' : '已停止'
            ),
            h('button', { className: 'mmj-btn', disabled, onClick: startWatch }, '开启'),
            h('button', { className: 'mmj-btn', disabled, onClick: stopWatch }, '停止'),
            h('button', { className: 'mmj-btn', disabled, onClick: openFolder }, '打开待打印文件夹'),
            h('button', { className: 'mmj-btn', disabled, onClick: () => run('正在刷新…', async () => { await loadQueue(); await loadLogs(); await loadWatch() }) }, '刷新')
          ),
          queue.pending && queue.pending.length
            ? h(
                'ul',
                { className: 'mmj-list' },
                queue.pending.map((item) =>
                  h('li', { key: item.name }, h('span', null, item.name), h('span', null, fmtSize(item.size)))
                )
              )
            : h('div', { className: 'mmj-hint', style: { margin: 0 } }, '待打印文件夹是空的。把图片丢进桌面「喵喵机待打印」当自动打印开着时就会打出来。')
        ),

        h(
          'div',
          { className: 'mmj-card' },
          h('h2', null, '最近记录'),
          logs.length
            ? h('pre', { className: 'mmj-log' }, logs.join('\n'))
            : h('div', { className: 'mmj-hint', style: { margin: 0 } }, '还没有记录。')
        )
      )
    }

    function registerAll(ctx) {
      const stops = []
      stops.push(
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: ID, order: 40, label: () => '喵喵机打印' },
            SidebarIcon
          )
        )
      )
      stops.push(
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID }, Panel))
      )
      return () => {
        for (const stop of stops) {
          try {
            if (typeof stop === 'function') stop()
          } catch {
            /* ignore */
          }
        }
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        conn = connOf(ctx)
        const styleStop = installStyles(CSS)
        let slotsStop = null
        ctx.effect(() => () => {
          styleStop()
          if (slotsStop) slotsStop()
        }, 'paperang.styles()')
        if (typeof ctx.inject === 'function') {
          ctx.inject(['layout'], (pageCtx) => {
            slotsStop = registerAll(pageCtx)
            return () => {
              if (slotsStop) slotsStop()
            }
          })
        } else {
          slotsStop = registerAll(ctx)
        }
      },
    }
  },
})
