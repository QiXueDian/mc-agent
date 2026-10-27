/**
 * ============================================================================
 *  src/agent/survival.js —— 生存状态快照（纯函数，零副作用，可单测）
 * ----------------------------------------------------------------------------
 *  为什么单独一个文件：
 *    loop.js 需要“每步注入生存状态”，tools.js 的 escape_danger 也需要同一套判定。
 *    而 tools.js 已经被 loop.js require，两边互相 require 会成环，
 *    所以把这层判定抽成不依赖任何业务模块的纯函数。
 *
 *  两个必须知道的坑（实测，别按直觉改）：
 *    1) bot.oxygenLevel 来自 metadata 包（breath.js:14 / entities.js:499），
 *       **上岸后不会立刻回满**，甚至可能长期停在旧值。
 *       所以只有 bot.entity.isInWater === true 时，氧气才可信；否则一律按 null 处理。
 *    2) bot.health / bot.food 在未 spawn 时是 undefined，
 *       这里统一转成 null，避免下游出现 NaN 比较（NaN < 10 === false 会漏判危急）。
 * ============================================================================
 */

const { formatPos } = require('./utils')

/** 危急阈值：血量低于这个值就必须先保命 */
const CRITICAL_HEALTH = 10
/** 危急阈值：水下氧气低于等于这个值就必须立刻上浮 */
const CRITICAL_OXYGEN = 6

/** 状态不可用时的占位对象：字段类型与正常情况保持一致，下游不用额外判空 */
function unavailableState(reason = '机器人状态不可用（可能未连接或未 spawn）') {
  return {
    available: false,
    inWater: false,
    oxygen: null,
    health: null,
    food: null,
    onFire: false,
    y: null,
    position: null,
    critical: false,
    reason
  }
}

/**
 * 读取当前生存状态。
 *
 * @param {object|null} bot mineflayer 实例（可以为 null，测试/未连接时）
 * @returns {{
 *   available: boolean, inWater: boolean, oxygen: number|null,
 *   health: number|null, food: number|null, onFire: boolean,
 *   y: number|null, position: string|null, critical: boolean, reason: string
 * }}
 *   critical 为 true 时，reason 里是用「；」连接的多个危急原因。
 */
function readSurvivalState(bot) {
  if (!bot || !bot.entity) return unavailableState()

  const entity = bot.entity
  const inWater = entity.isInWater === true
  const onFire = entity.onFire === true || entity.fireTicks > 0

  // 氧气只在水中可信（见文件头第 1 条坑）
  const oxygen = inWater && Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : null
  const health = Number.isFinite(bot.health) ? bot.health : null
  const food = Number.isFinite(bot.food) ? bot.food : null
  const y = entity.position ? entity.position.y : null

  const reasons = []
  if (health !== null && health < CRITICAL_HEALTH) {
    reasons.push(`血量 ${Math.round(health)}/20 低于 ${CRITICAL_HEALTH}`)
  }
  if (oxygen !== null && oxygen <= CRITICAL_OXYGEN) {
    reasons.push(`水下氧气只剩 ${oxygen}/20`)
  }
  if (onFire) reasons.push('身上正在着火')

  return {
    available: true,
    inWater,
    oxygen,
    health,
    food,
    onFire,
    y,
    position: entity.position ? formatPos(entity.position) : null,
    critical: reasons.length > 0,
    reason: reasons.join('；')
  }
}

/**
 * 拼成一行给模型看的中文状态（不带换行，方便直接贴在 tool 消息末尾）。
 * 例：【生存状态】血量 18/20｜饥饿 15/20｜氧气 --（不在水下）｜坐标 (10, 64, -3)
 */
function formatSurvivalLine(state) {
  if (!state || !state.available) return '【生存状态】不可用（机器人可能未连接）'

  const health = state.health === null ? '--' : Math.round(state.health)
  const food = state.food === null ? '--' : Math.round(state.food)
  const oxygen = state.oxygen === null ? '--（不在水下）' : `${state.oxygen}/20（水下）`
  const parts = [`血量 ${health}/20`, `饥饿 ${food}/20`, `氧气 ${oxygen}`]

  if (state.position) parts.push(`坐标 ${state.position}`)
  if (state.onFire) parts.push('着火中')

  const prefix = state.critical ? `【生存状态·危急】${state.reason}｜` : '【生存状态】'
  return prefix + parts.join('｜')
}

/**
 * 危急时给模型的硬指令（由 loop.js 作为 role:user 注入，值变化时才注入，避免刷屏）。
 */
function buildSurvivalAlert(state) {
  if (!state || !state.critical) return ''
  return (
    `【系统告警】${state.reason}。立刻停止当前任务，优先保命：` +
    '水下缺氧就调用 escape_danger；血量过低就远离战斗、吃东西或找掩体。' +
    '确认脱离危险后再继续原来的任务。'
  )
}

module.exports = {
  CRITICAL_HEALTH,
  CRITICAL_OXYGEN,
  readSurvivalState,
  formatSurvivalLine,
  buildSurvivalAlert
}
