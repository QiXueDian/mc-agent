/**
 * Minecraft 离线模式机器人
 * 流程：连接 -> spawn -> 寻路到 (100, 65, 100) -> 找 3 个 oak_log 并挖掉
 *
 * 用法：
 *   npm install
 *   node bot.js
 *   MC_HOST=127.0.0.1 MC_PORT=25565 MC_USERNAME=WoodBot node bot.js
 *
 * 支持的额外环境变量：MC_VERSION(如 1.20.4)、TARGET_X/TARGET_Y/TARGET_Z、LOG_COUNT、SEARCH_RADIUS、EXIT_WHEN_DONE=1
 */

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals

// ------------------------------ 配置 ------------------------------
const CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 58034),
  username: process.env.MC_USERNAME || 'WoodBot',
  // 留空则让 mineflayer 自动探测服务端版本
  version: process.env.MC_VERSION || undefined,
  target: {
    x: Number(process.env.TARGET_X || 100),
    y: Number(process.env.TARGET_Y || 65),
    z: Number(process.env.TARGET_Z || 100)
  },
  logBlockName: 'oak_log',
  logCount: Number(process.env.LOG_COUNT || 3),
  searchRadius: Number(process.env.SEARCH_RADIUS || 64),
  exitWhenDone: process.env.EXIT_WHEN_DONE === '1',
  // 单个动作的超时（毫秒）
  timeouts: { goto: 60000, dig: 20000, chunk: 8000 }
}

// ------------------------------ 日志 ------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let shuttingDown = false // 主动退出时不再提示“连接断开”错误

function log(tag, msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`[${t}] [${tag}] ${msg}`)
}

function fmtPos(pos) {
  return `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`
}

/** 给 Promise 加超时，避免寻路/挖掘卡死 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

// ------------------------------ 建立连接 ------------------------------
log('INIT', `正在连接 ${CONFIG.host}:${CONFIG.port} (离线模式, 用户名: ${CONFIG.username})`)

const bot = mineflayer.createBot({
  host: CONFIG.host,
  port: CONFIG.port,
  username: CONFIG.username,
  auth: 'offline', // 离线模式（盗版/局域网服务器）
  version: CONFIG.version
})

// 必须在创建 bot 后立即加载插件
bot.loadPlugin(pathfinder)

bot.once('login', () => log('INIT', `登录成功，机器人名称：${bot.username}`))
bot.once('spawn', () => log('INIT', `已进入游戏，当前所在维度：${bot.game.dimension}`))
bot.on('death', () => log('BREAK', '机器人死亡了，等待重生后继续任务'))
bot.on('kicked', (reason) => log('ERROR', `被服务器踢出：${JSON.stringify(reason)}`))
bot.on('error', (err) => log('ERROR', `连接错误：${err.message}`))
bot.on('end', (reason) => {
  if (shuttingDown) return
  log('ERROR', `与服务器断开连接（${reason}），进程退出`)
  process.exit(1)
})

bot.on('messagestr', (msg) => {
  // 只打印聊天/系统消息，方便观察服务器反馈
  if (msg && msg.trim()) log('CHAT', msg.trim())
})

// ------------------------------ 寻路配置 ------------------------------
function setupMovements() {
  const movements = new Movements(bot)

  movements.canDig = true            // 允许挖穿阻挡的方块
  movements.allow1by1towers = true   // 允许垫脚上塔
  movements.canOpenDoors = true
  movements.allowParkour = true
  movements.maxDropDown = 4

  // 垫脚方块（pathfinder 里属性名就是 scafoldingBlocks）
  const scaffoldNames = ['dirt', 'cobblestone', 'oak_planks']
  movements.scafoldingBlocks = scaffoldNames
    .map((name) => bot.registry.itemsByName[name]?.id)
    .filter((id) => id !== undefined)

  bot.pathfinder.setMovements(movements)
  bot.pathfinder.thinkTimeout = 15000  // 单次计算路径的最长思考时间
  bot.pathfinder.tickTimeout = 40
  log('MOVE', '已加载 mineflayer-pathfinder 并设置默认 Movements')
}

/** 移动期间定时打印进度，满足“正在移动”的日志要求 */
function startMoveLogger(goalPos, radius) {
  const timer = setInterval(() => {
    if (!bot.entity) return
    const p = bot.entity.position
    const dist = Math.hypot(p.x - goalPos.x, p.y - goalPos.y, p.z - goalPos.z) - radius
    log('MOVE', `正在移动… 当前 ${fmtPos(p)}，距目标还有 ${Math.max(dist, 0).toFixed(1)} 格`)
  }, 2000)
  return () => clearInterval(timer)
}

// ------------------------------ 任务步骤 ------------------------------
/** 步骤 1：寻路到目标坐标附近 */
async function goToTarget() {
  const { x, y, z } = CONFIG.target
  log('MOVE', `开始寻路到目标点 (${x}, ${y}, ${z}) 附近`)

  const stopLogger = startMoveLogger(CONFIG.target, 2)
  try {
    await withTimeout(bot.pathfinder.goto(new GoalNear(x, y, z, 2)), CONFIG.timeouts.goto, '寻路到目标点')
    log('MOVE', `已到达目标点附近，当前 ${fmtPos(bot.entity.position)}`)
  } finally {
    stopLogger()
  }
}

/** 等待区块加载后扫描附近的橡木，按距离由近到远返回 */
async function scanForLogs() {
  const logBlock = bot.registry.blocksByName[CONFIG.logBlockName]
  if (!logBlock) throw new Error(`当前版本的注册表中找不到方块 ${CONFIG.logBlockName}`)

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await withTimeout(bot.waitForChunksToLoad(), CONFIG.timeouts.chunk, '等待区块加载')
    } catch (err) {
      log('WARN', `${err.message}，继续尝试扫描`)
    }

    const positions = bot.findBlocks({
      matching: logBlock.id,
      maxDistance: CONFIG.searchRadius,
      count: CONFIG.logCount * 8
    })
    const blocks = positions
      .map((pos) => bot.blockAt(pos))
      .filter((b) => b && b.name === CONFIG.logBlockName)

    if (blocks.length > 0) {
      log('SCAN', `扫描完成，周围 ${CONFIG.searchRadius} 格内发现 ${blocks.length} 个候选 ${CONFIG.logBlockName}`)
      return blocks
    }

    log('SCAN', `第 ${attempt} 次扫描没有发现 ${CONFIG.logBlockName}，1 秒后重试…`)
    await sleep(1000)
  }
  return []
}

/** 挖一个方块（必要时先寻路靠近） */
async function mineOneBlock(block) {
  const p = block.position
  log('SCAN', `找到木头了！${CONFIG.logBlockName} 位于 (${p.x}, ${p.y}, ${p.z})`)

  try {
    await withTimeout(bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2)), CONFIG.timeouts.goto, '靠近木头')
  } catch (err) {
    log('WARN', `靠近木头失败：${err.message}，尝试直接在原地挖`)
  }

  // 寻路过程中方块可能已变化（被破坏 / 方块更新），重新取一次
  const target = bot.blockAt(p)
  if (!target || target.name !== CONFIG.logBlockName) {
    log('WARN', `(${p.x}, ${p.y}, ${p.z}) 的木头已不存在，跳过`)
    return false
  }
  if (bot.canDigBlock(target) === false) {
    log('WARN', `(${p.x}, ${p.y}, ${p.z}) 无法挖掘：超出拾取范围或不可破坏，跳过`)
    return false
  }

  await equipBestTool()

  log('DIG', `开始挖掘 (${p.x}, ${p.y}, ${p.z}) …`)
  try {
    await withTimeout(bot.dig(target), CONFIG.timeouts.dig, '挖掘方块')
  } catch (err) {
    log('WARN', `挖掘失败：${err.message}`)
    return false
  }

  await sleep(300)
  return true
}

/** 优先手持斧头，加快砍树速度（没有斧头则用空手） */
async function equipBestTool() {
  const axe = bot.inventory.items().find((item) => item.name.endsWith('_axe'))
  if (!axe) return
  if (bot.heldItem && bot.heldItem.name === axe.name) return
  try {
    await bot.equip(axe, 'hand')
    log('DIG', `已装备 ${axe.name}`)
  } catch (err) {
    log('WARN', `装备 ${axe.name} 失败：${err.message}`)
  }
}

/** 步骤 2：砍够指定数量的橡木 */
async function mineLogs() {
  let mined = 0
  const skipped = new Set()

  for (let round = 1; round <= 3 && mined < CONFIG.logCount; round++) {
    const blocks = await scanForLogs()
    if (blocks.length === 0) break

    for (const block of blocks) {
      if (mined >= CONFIG.logCount) break
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      if (skipped.has(key)) continue
      skipped.add(key)

      const ok = await mineOneBlock(block)
      if (ok) {
        mined += 1
        log('DIG', `挖取成功！进度 ${mined}/${CONFIG.logCount}`)
      }
    }
  }

  return mined
}

/** 完整任务：先到目标点，再砍树 */
async function runMission() {
  log('TASK', '========== 任务开始 ==========')
  try {
    await goToTarget()
    const mined = await mineLogs()

    if (mined >= CONFIG.logCount) {
      log('TASK', `任务完成：成功挖到 ${mined} 个 ${CONFIG.logBlockName}`)
    } else {
      log('TASK', `任务结束：只挖到 ${mined}/${CONFIG.logCount} 个 ${CONFIG.logBlockName}，附近可能没有足够的木头`)
    }
  } catch (err) {
    log('ERROR', `任务异常：${err.stack || err.message}`)
  } finally {
    bot.pathfinder.stop()
    if (CONFIG.exitWhenDone) {
      log('TASK', '按配置退出进程')
      shuttingDown = true
      await sleep(500)
      bot.quit('任务结束')
      process.exit(0)
    }
  }
}

// ------------------------------ 任务入口 ------------------------------
let missionRunning = false

bot.on('spawn', async () => {
  if (missionRunning) return // 死亡重生/换维度时避免重复执行
  missionRunning = true
  try {
    setupMovements()
    await runMission()
  } finally {
    missionRunning = false
  }
})

// Ctrl+C 优雅退出
process.on('SIGINT', () => {
  log('EXIT', '收到中断信号，正在断开连接')
  shuttingDown = true
  try { bot.quit('用户中断') } catch (_) { /* ignore */ }
  process.exit(0)
})
