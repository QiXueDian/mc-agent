/**
 * ============================================================================
 *  src/bot/viewer.js —— AI 视角（prismarine-viewer）生命周期封装
 * ----------------------------------------------------------------------------
 *  职责边界（与 connection.js 一致，只做一件事）：
 *    在本机上把一个“浏览器能看的 3D 画面”跑起来，并保持它和当前 bot 实例同步。
 *    不管推理、不管工具、不管 SSE —— 所以它放在 bot/ 而不是 agent/。
 *
 *  三条铁律（违反任何一条都会把主进程拖死）：
 *    1) 任何失败只 WARN，不 throw、不 exit、不影响 ReAct 循环；
 *    2) 端口独立（默认 3001），绝不复用 Agent 端口 3000 或 MC_PORT；
 *    3) 端口被占 / 库加载失败时，Agent 必须继续能跑 —— 画面是增强，不是依赖。
 *
 *  关于 prismarine-viewer 1.33 的两个实测事实（别凭印象写代码）：
 *    · mineflayerViewer(bot, opts) 的返回值是 undefined，关闭能力挂在 bot.viewer.close 上
 *      → 所以这里不假设返回 server 实例，而是“存在 close 才调用”。
 *    · 内部是 http.listen(port)（无 host 参数），实际固定监听 0.0.0.0
 *      → VIEWER_HOST 只用于生成访问地址（publicUrl），不能控制监听地址，启动时 WARN 说明。
 *
 *  配置全部来自环境变量，别处不得再硬编码 3001 / firstPerson：
 *    VIEWER_ENABLED        1|0   是否启用（默认 1）
 *    VIEWER_HOST           string 生成访问地址用（默认 localhost）
 *    VIEWER_PORT           number 独立端口（默认 3001）
 *    VIEWER_FIRST_PERSON   1|0   第一人称（默认 1）
 *    VIEWER_VIEW_DISTANCE  number 渲染距离（默认 8 格）
 *    VIEWER_PUBLIC_URL     string 显式覆盖访问地址（留空则按 host+port 拼）
 * ============================================================================
 */

const http = require('http')
const net = require('net')

const { log, describeError, sleep } = require('../agent/utils')

// ------------------------------ 配置（唯一来源） ------------------------------
const VIEWER_CONFIG = {
  enabled: process.env.VIEWER_ENABLED !== '0',
  host: String(process.env.VIEWER_HOST || 'localhost').trim(),
  port: Number(process.env.VIEWER_PORT || 3001),
  firstPerson: process.env.VIEWER_FIRST_PERSON !== '0',
  viewDistance: Number(process.env.VIEWER_VIEW_DISTANCE || 8),
  publicUrl: String(process.env.VIEWER_PUBLIC_URL || '').trim()
}

// ------------------------------ 运行时状态 ------------------------------
let started = false // 是否成功启动过（用于幂等）
let running = false // 服务是否被认为可用
let currentBot = null // viewer 绑定的 bot 实例（断线重连会变）
let lastError = '' // 最近一次失败原因，给 /api/health 用
let closeWarned = false // “关不掉旧实例”只提醒一次，避免重连时刷屏
let hostNoticeShown = false // 0.0.0.0 提示只打一次
let firstPersonActive = VIEWER_CONFIG.firstPerson // 当前生效的视角模式（可运行时切换）

/**
 * 把“不可访问”的监听地址规范成浏览器能用的地址。
 * 0.0.0.0 / :: 是“监听所有网卡”的写法，浏览器把它当无效目标，必须换成 localhost。
 */
function normalizeHost(host) {
  const raw = String(host || '').trim()
  if (!raw || raw === '0.0.0.0' || raw === '::' || raw === '[::]') return 'localhost'
  return raw
}

/** iframe 应该指向的地址：显式配置优先，否则 host + port 拼装 */
function getViewerUrl() {
  if (VIEWER_CONFIG.publicUrl) return VIEWER_CONFIG.publicUrl
  return `http://${normalizeHost(VIEWER_CONFIG.host)}:${VIEWER_CONFIG.port}`
}

/** 只读状态快照，供 /api/health 与前端使用 */
function getViewerInfo() {
  return {
    enabled: VIEWER_CONFIG.enabled,
    running,
    url: getViewerUrl(),
    port: VIEWER_CONFIG.port,
    host: VIEWER_CONFIG.host,
    firstPerson: firstPersonActive,
    viewDistance: VIEWER_CONFIG.viewDistance,
    lastError
  }
}

/**
 * 端口是否已被占用（用 TCP 连接探测，不是 bind 探测）。
 *
 * 为什么不用“试着 bind 一下”：
 *   Windows 上 SO_REUSEADDR 允许两个进程同时 bind 同一端口，bind 探测会返回
 *   “可用”，于是我们以为端口空闲、viewer 却和别的服务抢同一个端口（实测踩到）。
 *   连接探测没有这个歧义：能连上 = 有人在监听。
 *
 * @returns {Promise<boolean>} true = 已被占用
 */
function isPortBusy(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })

    let settled = false
    const done = (busy) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(busy)
    }

    socket.setTimeout(timeout)
    socket.once('connect', () => done(true)) // 连上了 → 端口有人用
    socket.once('timeout', () => done(false)) // 超时 → 当作空闲（不阻塞启动）
    socket.once('error', () => done(false)) // ECONNREFUSED → 空闲
  })
}

/**
 * 加载 prismarine-viewer 的 mineflayer 入口。
 *
 * 两条路径：
 *   1) require —— 1.33.0 是 CJS，正常走这里；
 *   2) 动态 import —— 仅当上游改成 ESM-only 时兜底（CJS 里 await import() 合法）。
 *
 * 失败时把**原始错误完整打印**（含 stack），不做静默吞掉：
 * 最常见的失败原因是 canvas 兼容性问题（本项目通过 npm alias 用 @napi-rs/canvas 提供）。
 */
async function loadMineflayerViewer() {
  try {
    const mod = require('prismarine-viewer')
    if (typeof mod.mineflayer === 'function') return mod.mineflayer
    throw new Error('prismarine-viewer 加载成功但没有导出 mineflayer 入口')
  } catch (err) {
    lastError = describeError(err)
    log('WARN', `[VIEWER] require('prismarine-viewer') 失败：${lastError}`)
    console.error('[VIEWER] 原始错误（完整栈）：', err) // 保留现场，别让 canvas 问题变成谜案

    // ---- ESM-only 兜底 ----
    try {
      const mod = await import('prismarine-viewer')
      const fn = mod.mineflayer || (mod.default && mod.default.mineflayer)
      if (typeof fn === 'function') {
        log('VIEWER', '已通过动态 import() 加载 prismarine-viewer')
        lastError = ''
        return fn
      }
      throw new Error('动态 import 成功但未找到 mineflayer 导出')
    } catch (err2) {
      lastError = describeError(err2)
      log('WARN', `[VIEWER] 动态 import() 兜底同样失败：${lastError}`)
      console.error('[VIEWER] 兜底路径原始错误（完整栈）：', err2)
      return null
    }
  }
}

/**
 * 关闭旧 viewer。
 *
 * 返回值是 undefined（1.33 的实测行为），所以唯一可靠的关闭方式是 bot.viewer.close。
 * 按“存在才调用”处理：不存在就保留旧实例并提醒一次，绝不假装关掉了。
 * @returns {boolean} 是否确认关闭成功
 */
function closeViewer() {
  const closeFn = currentBot && currentBot.viewer && currentBot.viewer.close

  if (typeof closeFn !== 'function') {
    if (!closeWarned) {
      closeWarned = true
      log('WARN', '[VIEWER] 旧 viewer server 未关闭（bot.viewer.close 不存在），可能占用端口')
    }
    return false
  }

  try {
    closeFn.call(currentBot.viewer)
    log('VIEWER', '旧 viewer 已关闭，准备为新连接重建')
    return true
  } catch (err) {
    log('WARN', `[VIEWER] 关闭旧 viewer 失败（忽略）：${describeError(err)}`)
    return false
  }
}

/** 0.0.0.0 提示：viewer 库固定监听所有网卡，这个信息必须让运维知道 */
function warnHostNoticeOnce() {
  if (hostNoticeShown) return
  hostNoticeShown = true
  log(
    'WARN',
    'prismarine-viewer 固定监听 0.0.0.0（库内 http.listen(port) 没有 host 参数），' +
      '如需仅本机访问请用防火墙/反向代理限制；VIEWER_HOST 仅用于生成访问地址'
  )
}

/**
 * 初始化 AI 视角（幂等，必须在 bot 的 spawn 之后调用）。
 *
 * @param {object} bot mineflayer 实例
 * @returns {Promise<void>} 永不 reject
 */
async function initViewer(bot, options = {}) {
  if (!VIEWER_CONFIG.enabled) return
  if (!bot) return

  // 同一个 bot 重复 spawn（死亡重生）→ 已经在跑，直接返回
  if (started && currentBot === bot) return

  // 换了 bot 实例（断线重连）→ 先关旧的；关不掉就别再开第二个，避免端口冲突刷屏
  if (started && currentBot !== bot) {
    if (!closeViewer()) return
    started = false
    running = false
    currentBot = null
  }

  const mineflayerViewer = await loadMineflayerViewer()
  if (!mineflayerViewer) return

  // 视角模式：优先用本次传入的，否则沿用当前生效值
  const wantFirstPerson =
    typeof options.firstPerson === 'boolean' ? options.firstPerson : firstPersonActive

  // 端口预检：viewer 内部的 listen 错误是异步 'error' 事件，try/catch 抓不到。
  // 提前探一次能把“端口被占”变成一条清晰 WARN，而不是进程崩溃或双进程抢端口。
  const portBusy = await isPortBusy(VIEWER_CONFIG.port)
  if (portBusy) {
    lastError = `端口 ${VIEWER_CONFIG.port} 已被占用`
    log('WARN', `[VIEWER] ${lastError}，AI 视角不可用（Agent 继续运行）`)
    return
  }

  // 捕获 viewer 内部创建的 http server：即使预检通过后仍发生 EADDRINUSE，
  // 也能靠我们自己挂的 'error' 监听把异常吃掉，绝不让未捕获错误杀掉主进程。
  const originalCreateServer = http.createServer
  let capturedServer = null

  http.createServer = function patchedCreateServer(...args) {
    const server = originalCreateServer.apply(this, args)
    capturedServer = server
    server.on('error', (err) => {
      running = false
      lastError = describeError(err)
      log('WARN', `[VIEWER] viewer 服务异常（Agent 继续运行）：${lastError}`)
    })
    return server
  }

  try {
    mineflayerViewer(bot, {
      port: VIEWER_CONFIG.port,
      firstPerson: wantFirstPerson,
      viewDistance: VIEWER_CONFIG.viewDistance
    })

    // server 已经创建、'error' 监听已挂好，立刻还原全局，不让补丁活过这一行
    http.createServer = originalCreateServer

    currentBot = bot

    // 库内部的 listen 是异步的，等一拍再确认它真的起来了
    // （多进程抢端口时，listen 可能“成功”但实际没拿到，不能只信日志）
    await sleep(250)

    if (capturedServer && capturedServer.listening !== true) {
      running = false
      started = false
      lastError = `端口 ${VIEWER_CONFIG.port} 监听失败（可能已被占用）`
      log('WARN', `[VIEWER] ${lastError}，AI 视角不可用（Agent 继续运行）`)
      return
    }

    started = true
    running = true
    firstPersonActive = wantFirstPerson
    lastError = ''

    log(
      'VIEWER',
      `AI 视角已启动：${getViewerUrl()}（第一人称=${firstPersonActive ? '开' : '关'}，` +
        `渲染距离=${VIEWER_CONFIG.viewDistance} 格）`
    )
    warnHostNoticeOnce()
  } catch (err) {
    running = false
    started = false
    lastError = describeError(err)
    log('WARN', `[VIEWER] 初始化失败，AI 视角不可用（Agent 继续运行）：${lastError}`)
    console.error('[VIEWER] 初始化原始错误（完整栈）：', err)
  } finally {
    http.createServer = originalCreateServer // 一定要还原，别污染全局
  }
}

/**
 * 等端口真正释放（≤ timeoutMs）。
 *
 * 为什么必须真探测：http.close() 只是“停止接受新连接”，已建立的 socket 没断开时
 * 端口依然被占用；直接 sleep(2000) 就去重启，EADDRINUSE 概率很高。
 * 判据：连不上（ECONNREFUSED）才算释放。
 * @returns {Promise<boolean>}
 */
function waitPortReleased(port, timeoutMs = 2000, interval = 100) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs

    const probe = () => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      let settled = false

      const finish = (released) => {
        if (settled) return
        settled = true
        socket.removeAllListeners()
        socket.destroy()

        if (released) return resolve(true)
        if (Date.now() >= deadline) return resolve(false)
        setTimeout(probe, interval)
      }

      socket.setTimeout(300)
      socket.once('connect', () => finish(false)) // 还连得上 → 没释放
      socket.once('timeout', () => finish(false)) // 说不清 → 当作没释放，继续等
      socket.once('error', () => finish(true)) // 拒绝连接 → 已释放
    }

    probe()
  })
}

/**
 * 等端口可连接（≤ timeoutMs）：连上 = 新 viewer 已经在监听。
 * @returns {Promise<boolean>}
 */
function waitPortReady(port, timeoutMs = 3000, interval = 100) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs

    const probe = () => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      let settled = false

      const finish = (ready) => {
        if (settled) return
        settled = true
        socket.removeAllListeners()
        socket.destroy()

        if (ready) return resolve(true)
        if (Date.now() >= deadline) return resolve(false)
        setTimeout(probe, interval)
      }

      socket.setTimeout(300)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    }

    probe()
  })
}

/**
 * 运行时切换视角（第一人称 / 第三人称）。
 *
 * prismarine-viewer 的 firstPerson 是启动参数、被闭包捕获，运行期改不了 → 只能重启。
 * 重启步骤严格按顺序，缺一步就会踩 EADDRINUSE：
 *   1) 校验 close 可用（不存在就放弃，别硬来）
 *   2) close 旧实例（抛错则放弃，画面保持原状）
 *   3) 轮询探测端口是否真的释放（≤2s）
 *   4) 用新参数重新 initViewer
 *   5) 轮询探测端口是否可连接（≤3s）
 *   6) 失败则尝试按原视角恢复，绝不给用户留白屏
 *
 * @param {object} bot  mineflayer 实例（不传则用当前绑定的实例）
 * @param {boolean} nextFirstPerson 目标模式
 * @returns {Promise<{ok: boolean, code?: string, message?: string, firstPerson?: boolean, url?: string}>}
 */
async function restartViewer(bot, nextFirstPerson) {
  if (!VIEWER_CONFIG.enabled) {
    return { ok: false, code: 'disabled', message: 'AI 视角已禁用（VIEWER_ENABLED=0）' }
  }

  const target = bot || currentBot
  if (!target) {
    return { ok: false, code: 'no-bot', message: '机器人还没进入游戏，无法切换视角' }
  }
  if (!started || !running) {
    return { ok: false, code: 'not-running', message: 'AI 视角当前未运行（可能端口被占用或初始化失败）' }
  }

  const closeFn = target.viewer && target.viewer.close
  if (typeof closeFn !== 'function') {
    log('WARN', '[VIEWER] 切换失败：bot.viewer.close 不存在，无法安全释放端口')
    return { ok: false, code: 'no-close', message: '当前 viewer 不支持安全关闭，无法切换' }
  }

  const previous = firstPersonActive
  const next = typeof nextFirstPerson === 'boolean' ? nextFirstPerson : !previous

  try {
    closeFn.call(target.viewer)
  } catch (err) {
    log('WARN', `[VIEWER] 切换失败：关闭旧 viewer 抛错：${describeError(err)}`)
    return { ok: false, code: 'close-failed', message: '关闭旧 viewer 失败，画面保持原状' }
  }

  // 旧实例已断，标记清零；注意 close 之后 failed 状态也要复位，否则 initViewer 会直接返回
  started = false
  running = false
  currentBot = null
  closeWarned = false

  const released = await waitPortReleased(VIEWER_CONFIG.port)
  if (!released) {
    lastError = `端口 ${VIEWER_CONFIG.port} 未在 2 秒内释放`
    log('WARN', `[VIEWER] 切换失败：${lastError}，已放弃重启（避免 EADDRINUSE）`)
    return { ok: false, code: 'port-busy', message: '端口未释放，已放弃重启（避免端口冲突）' }
  }

  await initViewer(target, { firstPerson: next })

  const ready = running && (await waitPortReady(VIEWER_CONFIG.port))
  if (!ready) {
    log('WARN', `[VIEWER] 新视角启动失败（${lastError || '端口未就绪'}），尝试恢复原视角…`)
    await initViewer(target, { firstPerson: previous })
    return {
      ok: false,
      code: 'restart-failed',
      message: running ? '切换失败，已恢复原视角' : '切换失败，AI 视角暂时不可用'
    }
  }

  log('VIEWER', `视角已切换为${firstPersonActive ? '第一人称' : '第三人称'}（viewer 已重启）`)
  return { ok: true, firstPerson: firstPersonActive, url: getViewerUrl() }
}

module.exports = {
  VIEWER_CONFIG,
  restartViewer,
  initViewer,
  getViewerInfo,
  getViewerUrl,
  normalizeHost
}
