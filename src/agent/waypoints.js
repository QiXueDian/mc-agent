/**
 * ============================================================================
 *  src/agent/waypoints.js —— 空间记忆（waypoints.json）
 * ----------------------------------------------------------------------------
 *  解决什么问题：Agent 只有 20 条对话记忆，重启就忘了“家在哪、村庄在哪个方向”，
 *  第二天只能重新侦察。这里把地标坐标持久化成一个本地 JSON，跨会话不丢。
 *
 *  为什么不做成向量库：
 *    地标是**精确命名的坐标**（“家”“铁矿洞”“村庄”），需要的是键值查找，
 *    不是语义相似度。一个 5KB 的 JSON 文件 + 精确匹配就够，零依赖、可手工编辑。
 *
 *  为什么放在 agent/ 而不是 server.js：
 *    工具在 loop.js 里执行，而 loop 已经被 server.js 依赖。
 *    如果把读写放进 server.js，就变成 tools → server → loop → tools 的循环依赖。
 *    这里只依赖 fs / path，谁都能安全 require。
 *
 *  文件格式（手工改也安全）：
 *    {
 *      "家": { "name": "家", "x": 102, "y": 68, "z": -35,
 *              "dimension": "overworld", "createdAt": 1730000000000, "updatedAt": 1730000000000 }
 *    }
 *  键是 name.toLowerCase()（大小写不敏感查找），name 保留玩家写的原始大小写。
 * ============================================================================
 */

const fs = require('fs')
const path = require('path')

const { log, describeError } = require('./utils')

/** 文件放在项目根目录，方便用户直接打开查看 / 备份 */
const WAYPOINT_FILE = path.join(__dirname, '..', '..', 'waypoints.json')

/** 上限：防止模型无限存地标把文件撑爆（超出时淘汰最久没更新的） */
const MAX_WAYPOINTS = 50
const NAME_MAX_LENGTH = 24

/** 名字规范化：去首尾空格、压缩连续空格、限长（空名返回空串，由调用方报错） */
function normalizeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, NAME_MAX_LENGTH)
}

const keyOf = (name) => normalizeName(name).toLowerCase()

/**
 * 读取全部地标。
 * 文件不存在 / 内容损坏 / 不是对象 → 一律按“空”处理，绝不让 Agent 起不来。
 * @returns {Record<string, object>}
 */
function loadAll() {
  try {
    if (!fs.existsSync(WAYPOINT_FILE)) return {}

    const raw = fs.readFileSync(WAYPOINT_FILE, 'utf8').trim()
    if (!raw) return {}

    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      log('WARN', 'waypoints.json 格式不是对象，已按空处理（不会覆盖原文件，除非再次保存）')
      return {}
    }
    return data
  } catch (err) {
    log('WARN', `读取 waypoints.json 失败（按空处理）：${describeError(err)}`)
    return {}
  }
}

/**
 * 原子写：先写临时文件再 rename。
 * 直接 writeFileSync 覆盖时如果进程被杀，会留下半个 JSON，下次启动就全丢。
 */
function persist(all) {
  const tmp = `${WAYPOINT_FILE}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, WAYPOINT_FILE)
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch (_) {
      /* 清临时文件失败不影响主流程 */
    }
    throw err
  }
}

/** 按名字精确查（大小写不敏感） */
function getWaypoint(name) {
  const key = keyOf(name)
  if (!key) return null
  return loadAll()[key] || null
}

/** 列出全部地标，最近更新的在前 */
function listWaypoints() {
  return Object.values(loadAll())
    .filter((wp) => wp && wp.name)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/**
 * 保存/更新一个地标。
 *
 * @param {{name: string, x: number, y: number, z: number, dimension?: string}} input
 * @returns {{ok: boolean, updated?: boolean, waypoint?: object, evicted?: string, error?: string}}
 */
function saveWaypoint(input = {}) {
  const name = normalizeName(input.name)
  if (!name) return { ok: false, error: '地标名不能为空' }

  const coords = ['x', 'y', 'z'].map((axis) => Number(input[axis]))
  if (coords.some((value) => !Number.isFinite(value))) {
    return { ok: false, error: '坐标必须是数字（x / y / z）' }
  }

  const [x, y, z] = coords.map((value) => Math.round(value * 10) / 10)
  const all = loadAll()
  const key = keyOf(name)
  const now = Date.now()
  const existing = all[key]

  all[key] = {
    name,
    x,
    y,
    z,
    dimension: String(input.dimension || (existing && existing.dimension) || 'unknown'),
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    updatedAt: now
  }

  // 超限时淘汰最久没更新的（保留刚存的这个）
  let evicted = ''
  const keys = Object.keys(all)
  if (keys.length > MAX_WAYPOINTS) {
    const sorted = keys
      .filter((k) => k !== key)
      .sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0))
    while (Object.keys(all).length > MAX_WAYPOINTS && sorted.length > 0) {
      const victim = sorted.shift()
      evicted = all[victim] && all[victim].name ? all[victim].name : victim
      delete all[victim]
    }
  }

  try {
    persist(all)
  } catch (err) {
    return { ok: false, error: `写入 waypoints.json 失败：${describeError(err)}` }
  }

  return { ok: true, updated: Boolean(existing), waypoint: all[key], evicted }
}

module.exports = {
  WAYPOINT_FILE,
  MAX_WAYPOINTS,
  normalizeName,
  loadAll,
  getWaypoint,
  listWaypoints,
  saveWaypoint
}
