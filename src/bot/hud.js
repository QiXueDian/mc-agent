/**
 * ============================================================================
 *  src/bot/hud.js —— 机器人状态快照（给前端 HUD 用）
 * ----------------------------------------------------------------------------
 *  为什么单独一个文件：
 *    「算护甲点数」这件事有一堆游戏规则（材质 × 部位查表），塞进 server.js 会让
 *    路由层变胖；而它又是纯读取、无副作用，最适合放在 bot/ 下当一个纯函数。
 *
 *  两个真实的坑（都是实测踩出来的，别按直觉写）：
 *    1) mineflayer 4.x **没有 bot.armor**，minecraft-data 的 item 也没有 armorPoints
 *       → 护甲值只能从 inventory.slots[5..8] 按“材质 × 部位”手工查表，上限 20。
 *    2) 未 spawn / 背包未同步时 slots[i] 可能是 **undefined 而不是 null**
 *       → 归一化必须在这里做完，不能把防御推给前端（否则 slot.name 直接 TypeError）。
 * ============================================================================
 */

/** 快捷栏在 inventory.slots 里的起始下标（36..44 共 9 格） */
const HOTBAR_START = 36
const HOTBAR_SIZE = 9

/** 护甲槽：5=头盔 6=胸甲 7=护腿 8=靴子 */
const ARMOR_SLOT_INDEXES = [5, 6, 7, 8]

/** 部位顺序与护甲点数表（1.20 数值；海龟壳单独处理） */
const ARMOR_PARTS = ['helmet', 'chestplate', 'leggings', 'boots']
const ARMOR_POINTS = {
  leather: [1, 3, 2, 1],
  golden: [2, 5, 3, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3]
}
const ARMOR_MAX = 20

/** 物品 → 前端能直接用的精简结构（统一 null，绝不给 undefined） */
function normalizeItem(item) {
  if (!item || !item.name) return null
  return {
    name: item.name,
    count: typeof item.count === 'number' ? item.count : 1,
    displayName: item.displayName || item.name
  }
}

/** 单件护甲的点数；不认识的物品记 0（宁可少算，不谎报） */
function armorPointsOfItem(item) {
  if (!item || !item.name) return 0

  if (item.name === 'turtle_helmet') return 2

  const part = ARMOR_PARTS.find((p) => item.name.endsWith(`_${p}`))
  if (!part) return 0

  const material = item.name.slice(0, -(part.length + 1))
  const table = ARMOR_POINTS[material]
  if (!table) return 0

  return table[ARMOR_PARTS.indexOf(part)] || 0
}

/** 当前装备的四件护甲合计点数（上限 20） */
function armorPoints(bot) {
  const slots = bot.inventory && bot.inventory.slots
  if (!Array.isArray(slots)) return 0

  const total = ARMOR_SLOT_INDEXES.reduce((sum, index) => sum + armorPointsOfItem(slots[index]), 0)
  return Math.min(total, ARMOR_MAX)
}

function positionOf(bot) {
  const pos = bot.entity && bot.entity.position
  if (!pos) return null

  return {
    x: Number(pos.x.toFixed(1)),
    y: Number(pos.y.toFixed(1)),
    z: Number(pos.z.toFixed(1)),
    dimension: (bot.game && bot.game.dimension) || 'unknown'
  }
}

/**
 * 取一次状态快照。
 * 未就绪时只返回 { ok, ready:false }，让前端保留上次数值并置灰（不抛错、不 500）。
 *
 * @param {object} bot mineflayer 实例（可能还没 spawn）
 * @returns {object}
 */
function getHudSnapshot(bot) {
  const at = Date.now()

  if (!bot || !bot.entity || !bot.inventory || !Array.isArray(bot.inventory.slots)) {
    return { ok: true, ready: false, at }
  }

  const slots = bot.inventory.slots
  const hotbar = []
  for (let i = 0; i < HOTBAR_SIZE; i++) {
    // 关键归一化：undefined / 空槽 / 非法值统统变 null
    hotbar.push(normalizeItem(slots[HOTBAR_START + i]))
  }

  const quickBarSlot = Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : 0
  const held = hotbar[quickBarSlot] || normalizeItem(bot.heldItem)

  return {
    ok: true,
    ready: true,
    at,
    health: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : 0,
    healthMax: 20,
    food: typeof bot.food === 'number' ? Math.round(bot.food) : 0,
    foodMax: 20,
    armor: armorPoints(bot),
    armorMax: ARMOR_MAX,
    heldItem: held,
    quickBarSlot,
    hotbar,
    position: positionOf(bot)
  }
}

module.exports = { getHudSnapshot, armorPoints, normalizeItem, HOTBAR_START, ARMOR_MAX }
