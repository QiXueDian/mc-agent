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
const { log } = require('../agent/utils')
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

/**
 * 立刻打断机器人当前动作（寻路 / 挖掘 / 按键）。
 *
 * 为什么必须有它：AbortController 只能让 Agent 循环在**下一次检查**时停下，
 * 而 pathfinder.goto() 可能要跑 30 秒 —— 用户点了“停止”却还要看机器人走完，
 * 体感就是“停不下来”。这里直接把底层动作掐掉。
 */
function interruptBotActions() {
  if (!bot) return
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

/**
 * 等待机器人 spawn 完成。
 * @param {number} timeout 超时毫秒数
 */
function waitForSpawn(timeout = 60000) {
  if (isReady()) return Promise.resolve(bot)

  return new Promise((resolve, reject) => {
    const currentBot = getBot()

    const timer = setTimeout(() => {
      currentBot.off('spawn', onSpawn)
      reject(new Error(`等待机器人进入游戏超时（${timeout}ms），请检查服务器是否已启动`))
    }, timeout)

    function onSpawn() {
      clearTimeout(timer)
      currentBot.off('spawn', onSpawn)
      resolve(currentBot)
    }

    currentBot.once('spawn', onSpawn)
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
  MC_CONFIG
}
