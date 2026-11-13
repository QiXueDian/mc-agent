/**
 * ============================================================================
 *  src/bot/connection.js —— 机器人连接层（单一职责：只负责“连上并保持在线”）
 * ----------------------------------------------------------------------------
 *  这里只做四件事，绝不含业务逻辑：
 *    1) 用 mineflayer 建立离线连接
 *    2) 加载 mineflayer-pathfinder 插件
 *    3) spawn 后初始化 Movements（寻路参数）
 *    4) 断线自动重连 + 提供 waitForSpawn 给上层等待就绪
 *
 *  对外接口：
 *    bot              首次创建的实例（重连后会换成新实例，长期持有请用 getBot()）
 *    getBot()         拿到当前可用的实例（首次调用会触发连接）
 *    waitForSpawn()   等到 spawn 完成（可执行动作）再 resolve
 *    isReady()        是否已进入游戏
 *    disconnect()     优雅退出（服务关闭 / Ctrl+C）
 *
 *  注意：本模块被 require 时会自动开始连接（服务型和 CLI 都需要 bot 常驻）。
 * ============================================================================
 */

require('dotenv').config()

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

// 复用工具层的寻路初始化（Movements 配置只维护一份）
const { setupMovements } = require('../agent/tools')
const { readSurvivalState } = require('../agent/survival')
const { verifyGameData } = require('../agent/knowledge')
const { log, describeError } = require('../agent/utils')
// AI 视角（prismarine-viewer）：独立端口 + 失败只 WARN，绝不影响 Agent 主循环
const { initViewer } = require('./viewer')

// ------------------------------ 连接配置 ------------------------------
const MC_CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'AIAgent',
  version: process.env.MC_VERSION || undefined, // 留空 = 自动探测服务端版本
  reconnectDelay: Number(process.env.MC_RECONNECT_DELAY || 5000)
}

// ------------------------------ 单例状态 ------------------------------
let bot = null // 当前实例（重连时会被替换）
let reconnecting = false // 防止断线事件重复排定重连定时器
let manualQuit = false // 主动退出标记：为 true 时断线不再重连

/** 死亡事件订阅者：loop.js 用它把“我刚死了”喂回对话上下文 */
const deathListeners = new Set()

/**
 * 订阅死亡事件。
 * @param {(info: {position: string, at: number}) => void} callback
 * @returns {() => void} 取消订阅函数（loop 结束时必须调用，否则监听器随轮次累积）
 */
function onDeath(callback) {
  if (typeof callback !== 'function') return () => {}
  deathListeners.add(callback)
  return () => deathListeners.delete(callback)
}

// ------------------------------ 版本自检（Sanity Check） ------------------------------
/**
 * 最近一次版本自检结果。
 * server.js 的 /api/health 会把它带给前端；前端据此提示“合成表可能无法显示”。
 * 放在连接层而不是每次查询时现算：spawn 后版本就固定了，没必要每步都验。
 */
let lastVersionCheck = null

/** 供 /api/health 与测试读取（未 spawn 时返回 null） */
function getVersionCheck() {
  return lastVersionCheck
}

/**
 * 校验 minecraft-data 是否真的适配 bot.version。
 * 失败不阻断运行（知识查询会降级），但必须让玩家看见 —— 否则模型只会以为“世上没有铁矿石”。
 */
function runVersionCheck(bot) {
  try {
    const check = verifyGameData(bot)
    lastVersionCheck = check

    if (check.ok) {
      log('MC', `版本自检通过：v${check.version}，配方 ${check.recipeCount} 条`)
    } else {
      log(
        'WARN',
        `版本自检失败（v${check.version}）：${check.reason}。` +
          'minecraft-data 可能未适配该版本，知识查询会降级、部分合成表可能无法显示！'
      )
    }
  } catch (err) {
    lastVersionCheck = {
      ok: false,
      version: (bot && bot.version) || '未知',
      missing: [],
      recipeCount: 0,
      reason: describeError(err),
      checkedAt: Date.now()
    }
    log('WARN', `版本自检异常（忽略，Agent 继续运行）：${describeError(err)}`)
  }
}

// ------------------------------ 危急事件（痛觉神经） ------------------------------
/**
 * 危急事件订阅者：server.js 用它把“我快死了”立刻变成“中断任务 + 推送警告”。
 *
 * 为什么要独立于 ReAct 循环：
 *   循环只在两次模型请求之间检查状态，而一次工具调用（寻路 30 秒、挖矿 10 秒）
 *   期间机器人是“聋的”。溺水、着火、被砍都是**秒级**事件，必须在底层直接感知。
 */
const criticalListeners = new Set()

/**
 * 订阅危急事件。
 * @param {(info: {reason: string, source: string, state: object, at: number}) => void} callback
 * @returns {() => void} 取消订阅函数（调用方用完必须注销，否则监听器会累积）
 */
function onCritical(callback) {
  if (typeof callback !== 'function') return () => {}
  criticalListeners.add(callback)
  return () => criticalListeners.delete(callback)
}

/** 巡检周期：physicsTick 不是每个版本都有，用定时器最稳（500ms 足够快，也不吃 CPU） */
const CRITICAL_PULSE_MS = Number(process.env.CRITICAL_PULSE_MS || 500)
let criticalPulseTimer = null

/**
 * 上升沿判定：只在「安全 → 危急」这一刻广播一次。
 * 如果按“每次巡检都广播”，溺水 10 秒就会推 20 条警告、abort 20 次；
 * 危险持续期间由 ReAct 循环的状态行与硬指令继续施压，不靠重复广播。
 */
let lastCriticalReason = ''

/** 广播给所有订阅者（单个订阅者抛错不能影响其它人） */
function broadcastCritical(info) {
  log('WARN', `[CRITICAL] 危急事件（${info.source}）：${info.reason}`)
  for (const listener of criticalListeners) {
    try {
      listener(info)
    } catch (err) {
      log('ERROR', `危急事件回调执行异常：${err && err.message ? err.message : err}`)
    }
  }
}

/** 读一次真实状态并判断是否需要报警（health 事件 / 定时巡检都调它） */
function checkCritical(source = 'pulse') {
  if (!bot || !bot.entity) {
    lastCriticalReason = '' // 没进游戏不算危险，避免上线瞬间误报
    return
  }

  const state = readSurvivalState(bot)
  if (!state.critical) {
    lastCriticalReason = ''
    return
  }

  if (state.reason === lastCriticalReason) return // 同一段危险，已经报过了

  lastCriticalReason = state.reason
  broadcastCritical({ reason: state.reason, source, state, at: Date.now() })
}

function startCriticalPulse() {
  stopCriticalPulse()
  criticalPulseTimer = setInterval(() => checkCritical('pulse'), CRITICAL_PULSE_MS)
  // 别让心跳定时器把进程钉住（CLI 模式 / 测试里尤其明显）
  if (typeof criticalPulseTimer.unref === 'function') criticalPulseTimer.unref()
}

function stopCriticalPulse() {
  if (criticalPulseTimer) {
    clearInterval(criticalPulseTimer)
    criticalPulseTimer = null
  }
}

/**
 * 立刻打断机器人当前动作（寻路 / 挖掘 / 按键）。
 *
 * 为什么必须有它：AbortController 只能让 Agent 循环在**下一次检查**时停下，
 * 而 pathfinder.goto() 可能要跑 30 秒 —— 用户点了“停止”却还要看机器人走完，
 * 体感就是“停不下来”。这里直接把底层动作掐掉。
 *
 * 【逃生豁免】
 *   escape_danger 执行期间会挂 bot.isEscaping = true（见 tools.js）。
 *   那时候机器人正在自救：上浮靠 setControlState('jump') 持续按住跳跃键，
 *   挖头顶靠 bot.dig。此时若照常 stopDigging() / clearControlStates()，
 *   等于把自救动作掐掉 —— 溺水/着火时“越危险越动不了”。
 *   所以逃生期间这里直接返回，只让上层 abort 打断大模型循环；
 *   逃生自然结束后旗标复位，强制中断能力立即恢复。
 */
function interruptBotActions() {
  if (!bot) return

  if (bot.isEscaping === true) {
    log('WARN', '[CRITICAL] 机器人正在执行逃生动作，跳过强制停手（只中断模型循环）')
    return
  }

  try {
    if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop()
  } catch (_) {
    /* 寻路插件未加载时忽略 */
  }
  try {
    if (typeof bot.stopDigging === 'function') bot.stopDigging()
  } catch (_) {
    /* 没在挖时忽略 */
  }
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
  } catch (_) {
    /* 忽略按键状态异常 */
  }
}

/** 是否已经 spawn 完成（可以执行动作） */
function isReady() {
  return Boolean(bot && bot.entity)
}

/**
 * 创建并连接 bot（内部函数，只在初始化/重连时调用）。
 * @returns {object} mineflayer bot 实例
 */
function createBot() {
  log('MC', `正在连接 ${MC_CONFIG.host}:${MC_CONFIG.port}（离线模式，用户名 ${MC_CONFIG.username}）`)

  bot = mineflayer.createBot({
    host: MC_CONFIG.host,
    port: MC_CONFIG.port,
    username: MC_CONFIG.username,
    auth: 'offline', // 离线模式：不校验正版账号
    version: MC_CONFIG.version
  })

  // 插件必须在 createBot 之后立刻加载，否则 bot.pathfinder 为 undefined
  bot.loadPlugin(pathfinder)

  // ---- 痛觉神经：血量变化立刻判一次 + 每 500ms 轮询溺水/着火 ----
  // health 事件只在血量/饥饿变化时触发，着火与溺水属于“实体状态”，必须靠轮询。
  bot.on('health', () => checkCritical('health'))
  startCriticalPulse()

  bot.once('login', () => log('MC', '登录成功'))

  // 首次 spawn 后启动 AI 视角：viewer 内部自己 try/catch，这里再包一层纯属保险，
  // 保证“画面起不来”永远不会变成“机器人不动了”。
  bot.once('spawn', () => {
    initViewer(bot).catch((err) => {
      log('WARN', `[VIEWER] 初始化异常（忽略，Agent 继续运行）：${err && err.message ? err.message : err}`)
    })
  })

  // 用 on 而不是 once：死亡重生、跨维度传送都会再次 spawn，需要重建 Movements
  bot.on('spawn', () => {
    try {
      setupMovements(bot)
      log('MC', `已进入游戏（${bot.game.dimension}），寻路 Movements 已就绪`)
    } catch (err) {
      log('ERROR', `初始化 Movements 失败：${err.message}`)
    }

    // 版本自检：spawn 时 bot.version 已经由握手包确定，正好用来验证 minecraft-data
    runVersionCheck(bot)
  })

  // 死亡：不只是打日志，还要广播给 Agent 循环（否则模型醒来还以为自己在原地干活）
  bot.on('death', () => {
    const position = bot.entity && bot.entity.position ? `${bot.entity.position.x}, ${bot.entity.position.y}, ${bot.entity.position.z}` : '未知'
    log('WARN', `机器人死亡（位置 ${position}），等待重生`)

    const info = { position, at: Date.now() }
    for (const listener of deathListeners) {
      try {
        listener(info)
      } catch (err) {
        log('ERROR', `死亡回调执行异常：${err && err.message ? err.message : err}`)
      }
    }
  })
  bot.on('kicked', (reason) => log('ERROR', `被服务器踢出：${JSON.stringify(reason)}`))
  bot.on('error', (err) => log('ERROR', `Minecraft 连接错误：${err.message}`))
  bot.on('end', (reason) => {
    log('ERROR', `与服务器断开连接（${reason}）`)
    // 连接已断：巡检定时器必须停掉，否则会对着一个死实例空转
    stopCriticalPulse()
    lastCriticalReason = ''
    lastVersionCheck = null // 下次连到哪个版本还不知道，旧的检查结果不能留着误导前端
    if (!manualQuit) scheduleReconnect() // 主动退出时不再重连
  })

  return bot
}

/** 断线后延迟重连（Web 服务常驻，不能因为一次掉线就废掉） */
function scheduleReconnect() {
  if (reconnecting) return
  reconnecting = true

  setTimeout(() => {
    reconnecting = false
    log('MC', '尝试重新连接…')
    createBot()
  }, MC_CONFIG.reconnectDelay)
}

/**
 * 拿到当前可用实例；首次调用时创建连接。
 * @returns {object} mineflayer bot
 */
function getBot() {
  if (bot) return bot
  return createBot()
}

/** 等待 spawn 期间，多久对齐一次“当前实例是谁”（毫秒） */
const SPAWN_POLL_MS = 200

/**
 * 等待机器人 spawn 完成。
 *
 * 为什么不能只 `getBot().once('spawn', ...)`：
 *   断线后 connection.js 会走 scheduleReconnect → createBot()，**把实例整个换掉**。
 *   如果等待开始时拿的是旧实例的快照，那个实例永远不会再 spawn，
 *   于是明明新连接已经进来了，调用方还要干等到 60s 超时（表现为“偶发 60 秒无响应”）。
 *   所以这里持续对齐当前实例：实例一换，监听器就跟着搬过去；
 *   同时用 isReady() 兜底，任何时刻只要机器人已经可用就立刻 resolve。
 *
 * @param {number} timeout 超时毫秒数（覆盖整个等待窗口，不因重连而重置）
 * @returns {Promise<object>} 已就绪的 bot 实例
 */
function waitForSpawn(timeout = 60000) {
  if (isReady()) return Promise.resolve(bot)

  return new Promise((resolve, reject) => {
    let attached = null // 当前挂监听的那个实例
    let settled = false
    let poll = null
    let timer = null

    /** 只解绑我们自己挂的那个监听，绝不动其它模块的监听器 */
    const detach = () => {
      if (!attached) return
      attached.off('spawn', onSpawn)
      attached = null
    }

    const settle = (ok, value) => {
      if (settled) return
      settled = true
      detach()
      clearInterval(poll)
      clearTimeout(timer)
      if (ok) resolve(value)
      else reject(value)
    }

    function onSpawn() {
      // 旧实例理论上也可能残留 spawn 事件，一律以“当前实例是否真的可用”为准
      if (isReady()) settle(true, bot)
    }

    /** 把监听器搬到“当前实例”上；实例没变就什么都不做 */
    const attachCurrent = () => {
      // 主动退出（disconnect）时不要顺手重连，安静等到超时即可
      const current = bot || (manualQuit ? null : getBot())
      if (current === attached) return
      detach()
      if (!current) return
      attached = current
      current.once('spawn', onSpawn)
    }

    attachCurrent() // 先同步挂一次，避免创建 Promise 后白等一个轮询周期

    poll = setInterval(() => {
      if (settled) return
      if (isReady()) {
        settle(true, bot)
        return
      }
      attachCurrent() // 重连换了实例 → 监听器跟着搬
    }, SPAWN_POLL_MS)

    timer = setTimeout(() => {
      settle(false, new Error(`等待机器人进入游戏超时（${timeout}ms），请检查服务器是否已启动`))
    }, timeout)
  })
}

/** 优雅断开（服务关闭时调用），并阻止触发重连 */
function disconnect(reason = '服务关闭') {
  manualQuit = true
  try {
    if (bot) bot.quit(reason)
  } catch (_) {
    /* 忽略退出异常 */
  }
  bot = null
}

module.exports = {
  bot: getBot(), // 首次实例（模块加载即连接）
  getBot,
  waitForSpawn,
  isReady,
  disconnect,
  interruptBotActions,
  onDeath,
  onCritical,
  checkCritical, // 单测 / 立即巡检用
  getVersionCheck,
  runVersionCheck, // 允许测试/诊断手动触发
  MC_CONFIG
}
