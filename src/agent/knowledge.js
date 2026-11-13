/**
 * ============================================================================
 *  src/agent/knowledge.js —— 游戏数据字典 + 知识查询（query_game_knowledge）
 * ----------------------------------------------------------------------------
 *  为什么独立成文件（原本在 tools.js 里，占 330 行）：
 *    这里的东西有三类，生命周期和 tools.js 完全不同 ——
 *      1) 名称字典（itemNameMap / entityNameMap）：随译名习惯变；
 *      2) 知识查询：随 minecraft-data 版本与前端 Markdown 约定变；
 *      3) 配方渲染：前端 index.html 的表格解析与这里强耦合。
 *    放在 3300 行的 tools.js 里，改一个配方格式要滚很久才能定位。
 *
 *  依赖方向（只许单向，禁止反向 require tools.js，否则成环）：
 *    tools.js / loop.js  →  knowledge.js  →  utils.js
 *
 *  ⚠️ 本文件所有 query_game_knowledge 的输出格式受铁律保护：
 *     「产出：英文ID x数量」 + 3 行 Markdown 表格 + 紧随其后的替换说明，
 *     前端 public/index.html 的 renderCraftBlocks() 依赖这个约定，改格式必须同步改前端。
 * ============================================================================
 */

const { log, describeError } = require('./utils')

// ============================================================================
//  物品 / 实体名称中文映射（解决“中英混杂”）
// ----------------------------------------------------------------------------
//  为什么需要它：工具返回的是英文 ID（cobblestone、stick），大模型会照抄进思考过程，
//  于是输出变成“我需要 cobblestone 做一个 stone_pickaxe”。统一转成
//  “圆石(cobblestone)” 之后：模型读得懂中文，同时仍然看得到英文 ID，
//  后续调用工具（参数必须是英文 ID）不会丢信息。
//
//  ⚠️ 只影响“输出文案”。工具入参依旧是英文 ID，逻辑层始终用英文 ID 去查 registry。
// ============================================================================
const itemNameMap = {
  // ---- 建筑材料 ----
  cobblestone: '圆石',
  stone: '石头',
  dirt: '泥土',
  grass_block: '草方块',
  sand: '沙子',
  gravel: '砂砾',
  andesite: '安山岩',
  diorite: '闪长岩',
  granite: '花岗岩',
  deepslate: '深板岩',
  cobbled_deepslate: '深板岩圆石',
  obsidian: '黑曜石',
  bedrock: '基岩',
  glass: '玻璃',
  sandstone: '砂岩',
  terracotta: '陶瓦',
  tuff: '凝灰岩',
  netherrack: '下界岩',
  ancient_debris: '远古残骸',
  lava: '岩浆',
  fire: '火焰',
  soul_fire: '灵魂火',
  magma_block: '岩浆块',
  cactus: '仙人掌',
  powder_snow: '细雪',
  // ---- 木头与植物 ----
  oak_log: '橡木原木',
  oak_wood: '橡木',
  oak_planks: '橡木木板',
  oak_sapling: '橡树苗',
  oak_leaves: '橡树树叶',
  oak_button: '橡木按钮',
  oak_slab: '橡木台阶',
  oak_stairs: '橡木楼梯',
  oak_door: '橡木门',
  oak_fence: '橡木栅栏',
  birch_log: '白桦原木',
  birch_planks: '白桦木板',
  spruce_log: '云杉原木',
  spruce_planks: '云杉木板',
  stick: '木棍',
  coal: '煤炭',
  charcoal: '木炭',
  // ---- 矿物与材料 ----
  raw_iron: '粗铁',
  iron_ingot: '铁锭',
  iron_ore: '铁矿石',
  deepslate_iron_ore: '深层铁矿石',
  iron_nugget: '铁粒',
  raw_copper: '粗铜',
  copper_ingot: '铜锭',
  raw_gold: '粗金',
  gold_ingot: '金锭',
  gold_nugget: '金粒',
  diamond: '钻石',
  emerald: '绿宝石',
  redstone: '红石',
  lapis_lazuli: '青金石',
  quartz: '下界石英',
  flint: '燧石',
  clay_ball: '黏土球',
  // ---- 工具与武器 ----
  wooden_pickaxe: '木镐',
  stone_pickaxe: '石镐',
  iron_pickaxe: '铁镐',
  golden_pickaxe: '金镐',
  diamond_pickaxe: '钻石镐',
  netherite_pickaxe: '下界合金镐',
  wooden_axe: '木斧',
  stone_axe: '石斧',
  iron_axe: '铁斧',
  diamond_axe: '钻石斧',
  wooden_shovel: '木锹',
  stone_shovel: '石锹',
  iron_shovel: '铁锹',
  diamond_shovel: '钻石锹',
  wooden_sword: '木剑',
  stone_sword: '石剑',
  iron_sword: '铁剑',
  diamond_sword: '钻石剑',
  wooden_hoe: '木锄',
  stone_hoe: '石锄',
  iron_hoe: '铁锄',
  diamond_hoe: '钻石锄',
  shears: '剪刀',
  bucket: '桶',
  water_bucket: '水桶',
  lava_bucket: '岩浆桶',
  milk_bucket: '牛奶桶',
  shield: '盾牌',
  bow: '弓',
  arrow: '箭',
  fishing_rod: '钓鱼竿',
  flint_and_steel: '打火石',
  // ---- 防具 ----
  leather_helmet: '皮革帽子',
  leather_chestplate: '皮革外套',
  leather_leggings: '皮革裤子',
  leather_boots: '皮革靴子',
  iron_helmet: '铁头盔',
  iron_chestplate: '铁胸甲',
  iron_leggings: '铁护腿',
  iron_boots: '铁靴子',
  diamond_helmet: '钻石头盔',
  diamond_chestplate: '钻石胸甲',
  diamond_leggings: '钻石护腿',
  diamond_boots: '钻石靴子',
  elytra: '鞘翅',
  totem_of_undying: '不死图腾',
  // ---- 食物与农业 ----
  apple: '苹果',
  bread: '面包',
  wheat: '小麦',
  wheat_seeds: '小麦种子',
  farmland: '耕地',
  carrot: '胡萝卜',
  potato: '马铃薯',
  beef: '生牛肉',
  cooked_beef: '牛排',
  porkchop: '生猪排',
  cooked_porkchop: '熟猪排',
  chicken: '生鸡肉',
  cooked_chicken: '熟鸡肉',
  mutton: '生羊肉',
  rotten_flesh: '腐肉',
  bone: '骨头',
  bone_meal: '骨粉',
  leather: '皮革',
  feather: '羽毛',
  white_wool: '白色羊毛',
  egg: '鸡蛋',
  // ---- 功能方块与容器 ----
  crafting_table: '工作台',
  furnace: '熔炉',
  blast_furnace: '高炉',
  smoker: '烟熏炉',
  chest: '箱子',
  barrel: '木桶',
  torch: '火把',
  ladder: '梯子',
  lever: '拉杆',
  brewing_stand: '酿造台',
  cauldron: '炼药锅',
  anvil: '铁砧',
  composter: '堆肥桶',
  // ---- 酿造材料 ----
  glass_bottle: '玻璃瓶',
  blaze_powder: '烈焰粉',
  blaze_rod: '烈焰棒',
  nether_wart: '下界疣',
  ghast_tear: '恶魂之泪',
  spider_eye: '蜘蛛眼',
  fermented_spider_eye: '发酵蜘蛛眼',
  sugar: '糖',
  glowstone_dust: '荧石粉',
  redstone_dust: '红石粉',
  // ---- 常见掉落物（entity / loot 查询会用到） ----
  gunpowder: '火药',
  string: '线',
  rabbit: '生兔肉',
  slime_ball: '黏液球',
  ender_pearl: '末影珍珠',
  prismarine_shard: '海晶碎片',
  ink_sac: '墨囊',
  nether_star: '下界之星'
}

/** 常见实体中文名（战斗/感知工具的返回文案用） */
const entityNameMap = {
  zombie: '僵尸',
  skeleton: '骷髅',
  creeper: '苦力怕',
  spider: '蜘蛛',
  cave_spider: '洞穴蜘蛛',
  enderman: '末影人',
  witch: '女巫',
  slime: '史莱姆',
  drowned: '溺尸',
  husk: '尸壳',
  zombie_villager: '僵尸村民',
  pillager: '掠夺者',
  vindicator: '卫道士',
  ravager: '劫掠兽',
  blaze: '烈焰人',
  ghast: '恶魂',
  magma_cube: '岩浆怪',
  cow: '牛',
  pig: '猪',
  sheep: '羊',
  chicken: '鸡',
  rabbit: '兔子',
  horse: '马',
  donkey: '驴',
  wolf: '狼',
  cat: '猫',
  fox: '狐狸',
  bat: '蝙蝠',
  squid: '鱿鱼',
  cod: '鳕鱼',
  salmon: '鲑鱼',
  villager: '村民',
  wandering_trader: '流浪商人',
  iron_golem: '铁傀儡',
  snow_golem: '雪傀儡',
  player: '玩家',
  item: '掉落物',
  armor_stand: '盔甲架',
  boat: '船',
  minecart: '矿车'
}

// ============================================================================
//  Wiki 实时检索（query_type = wiki）—— 本项目唯一会联网的地方
// ----------------------------------------------------------------------------
//  为什么需要它：minecraft-data 只有“物体数据”，没有“机制知识”。
//  “怎么附魔 / 怎么驯服猫 / 下界怎么去”这类问题查表永远查不到，
//  只能靠模型记忆 —— 于是就有幻觉。这里直接把 wiki 的搜索摘要喂给模型。
//
//  设计约束（刻意保持轻量）：
//    · 只调 MediaWiki 的 list=search，不抓正文、不做切片、不算向量；
//    · 只取前 3 条摘要，拼成 500 字以内，避免把上下文撑爆；
//    · 失败绝不抛异常：超时/断网都返回一句人话，让模型降级回答并标注“经验判断”；
//    · 10 分钟内存缓存，同一关键词连问 5 次只发 1 个请求。
// ============================================================================
const WIKI_API = 'https://minecraft.wiki/api.php'
const WIKI_LIMIT = 3
const WIKI_TIMEOUT_MS = Number(process.env.WIKI_TIMEOUT || 8000)
const WIKI_MAX_CHARS = 500
const WIKI_CACHE_TTL = 10 * 60 * 1000
const WIKI_CACHE = new Map()

/** HTML 实体 → 普通字符（Wiki 摘要里出现频率最高的是 &quot; 和 &amp;） */
function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** Wiki 的 snippet 带 <span class="searchmatch"> 高亮，必须去标签再压缩空白 */
function stripHtml(text) {
  return decodeHtmlEntities(String(text).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 检索 minecraft.wiki，返回一段可直接塞进 role:tool 的纯文本。
 * 永不抛异常：任何失败都降级成“检索失败 + 建议”。
 *
 * @param {string} keyword 检索词（中文/英文都行，英文命中率更高）
 * @returns {Promise<string>}
 */
async function searchMinecraftWiki(keyword) {
  const key = String(keyword || '').trim()
  if (!key) return '缺少检索关键词：请传具体机制名，例如 附魔、驯服猫、下界。'

  const cached = WIKI_CACHE.get(key)
  if (cached && Date.now() - cached.at < WIKI_CACHE_TTL) return cached.text

  const url =
    `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(key)}` +
    `&srlimit=${WIKI_LIMIT}&format=json&utf8=1`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // MediaWiki 对没有 UA 的请求不友好，显式带一个
        'User-Agent': 'mc-agent-bot/1.0 (local Minecraft agent)',
        Accept: 'application/json'
      }
    })

    if (!res.ok) {
      log('WARN', `[tools] Wiki 检索返回 HTTP ${res.status}`)
      return `Wiki 检索失败：HTTP ${res.status}。可以先按已有知识给出经验性回答，但必须说明“这是经验判断，不是查到的资料”。`
    }

    const data = await res.json()
    const hits = data && data.query && Array.isArray(data.query.search) ? data.query.search : []

    if (hits.length === 0) {
      const text = `minecraft.wiki 上没有找到与 "${key}" 相关的条目。建议换更标准的关键词（英文条目更全，例如 enchanting、cat、nether）。`
      WIKI_CACHE.set(key, { at: Date.now(), text })
      return text
    }

    const blocks = hits.map((hit, index) => {
      const title = stripHtml(hit.title) || '(无标题)'
      const snippet = stripHtml(hit.snippet) || '(无摘要)'
      return `${index + 1}. ${title}：${snippet}`
    })

    let text = `【Wiki 检索：${key}】（来源 minecraft.wiki，实时抓取，共 ${hits.length} 条）\n${blocks.join('\n')}`
    if (text.length > WIKI_MAX_CHARS) text = text.slice(0, WIKI_MAX_CHARS) + '…'

    WIKI_CACHE.set(key, { at: Date.now(), text })
    log('TOOL', `[tools] Wiki 检索命中 ${hits.length} 条：${key}`)
    return text
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `超时（${WIKI_TIMEOUT_MS}ms）` : describeError(err)
    log('WARN', `[tools] Wiki 检索失败：${reason}`)
    return `Wiki 检索失败（${reason}）。可以先按已有知识给出经验性回答，但必须说明“这是经验判断，不是查到的资料”。`
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
//  游戏知识查询（query_game_knowledge）—— minecraft-data 深度集成
// ----------------------------------------------------------------------------
//  数据来源：require('minecraft-data')(bot.version)
//    · 物品属性：itemsByName / blocksByName（stackSize、maxDurability）
//    · 配方：recipes[itemId] —— 注意是**按数字 id 索引，不是按名字**
//        shaped    → inShape 是 3x3 的数字 id 矩阵，null 表示空位
//        shapeless → ingredients 是数字 id 数组（重复出现即表示数量）
//    · 熔炼：minecraft-data 1.21.x 的 recipes.json 只有工作台配方，没有熔炉配方，
//            所以用内置 SMELTING_RECIPES 兜底（常见产物）。
//
//  ⚠️ 本工具返回的是**严格 Markdown**：表格格子必须是英文 ID（前端据此拼贴图 URL），
//     所以返回 { __raw: true, text }，让 executeTool 跳过 localizeText 汉化。
// ============================================================================
const minecraftData = require('minecraft-data')

/** 单个配方最多展示几个方案（石镐有 3 种材料方案，全列会把上下文撑爆） */
const MAX_RECIPE_VARIANTS = 3

/**
 * 熔炼表（产物 → 原料候选）：minecraft-data 不提供熔炉配方，内置兜底。
 *
 * ⚠️ 每条给的是**候选数组**而不是单一答案，因为版本差异非常大：
 *    · 1.12.2 没有 raw_iron，铁矿石直接烧成铁锭，也没有 raw_gold；
 *    · 1.16.5 有 raw_iron 但没有 raw_gold；
 *    · 1.20+ 才有 raw_gold。
 * 使用前必须用 resolveSmeltSources(mcData, name) 按**当前版本**做存在性过滤，
 * 不存在的原料直接跳过（不是报错），过滤后为空就当作“该版本没有熔炼路径”。
 */
const SMELTING_RECIPES = {
  iron_ingot: ['raw_iron', 'iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore'],
  glass: ['sand'],
  stone: ['cobblestone'],
  smooth_stone: ['stone'],
  charcoal: ['oak_log', 'log'],
  brick: ['clay_ball'],
  deepslate: ['cobbled_deepslate'],
  netherite_scrap: ['ancient_debris'],
  cooked_beef: ['beef'],
  cooked_porkchop: ['porkchop'],
  cooked_chicken: ['chicken'],
  cooked_mutton: ['mutton'],
  cooked_rabbit: ['rabbit'],
  cooked_cod: ['cod'],
  cooked_salmon: ['salmon'],
  baked_potato: ['potato'],
  dried_kelp: ['kelp']
}

/** 当前版本是否存在该物品/方块（所有跨版本查询的唯一判据） */
function itemExists(mcData, name) {
  if (!name) return false
  const inItems = Boolean(mcData.itemsByName && mcData.itemsByName[name])
  const inBlocks = Boolean(mcData.blocksByName && mcData.blocksByName[name])
  return inItems || inBlocks
}

/** 熔炼原料候选 → 只保留当前版本真实存在的那些 */
function resolveSmeltSources(mcData, itemName) {
  const list = SMELTING_RECIPES[itemName]
  if (!list) return []
  const candidates = Array.isArray(list) ? list : [list]
  return candidates.filter((name) => itemExists(mcData, name))
}

/** 版本展示文本：1.12.2 / 1.20.4 …（数据缺失时返回“未知”） */
function versionLabelOf(mcData) {
  if (!mcData || mcData.error) return '未知'
  const version = mcData.version || {}
  return String(version.minecraftVersion || version.version || '未知')
}

/** 版本 → mcData 缓存：同一版本只解析一次（数据文件不小，反复加载会明显卡顿） */
const MC_DATA_CACHE = new Map()

/** 解析当前世界版本：优先 bot.version，其次 .env 的 MC_VERSION，最后取支持的最新版 */
function resolveGameVersion(bot) {
  const fromBot = bot && bot.version ? String(bot.version) : ''
  const fromEnv = process.env.MC_VERSION ? String(process.env.MC_VERSION) : ''
  if (fromBot) return fromBot
  if (fromEnv) return fromEnv
  const list = (minecraftData.supportedVersions && minecraftData.supportedVersions.pc) || []
  return list[list.length - 1] || '1.21.1'
}

/** 取指定版本的 mcData；失败返回 { error }，绝不抛异常进循环 */
function getGameData(bot) {
  const version = resolveGameVersion(bot)
  if (MC_DATA_CACHE.has(version)) return MC_DATA_CACHE.get(version)

  try {
    const data = minecraftData(version)
    // minecraft-data 对不认识的版本会返回 **null** 而不是抛错（例如模组服乱报版本号），
    // 不判空的话后面 mcData.itemsByName 会直接把 Agent 打挂。
    if (!data) {
      const error =
        `当前版本（v${version}）不在 minecraft-data 的支持列表里，知识查询不可用。` +
        '可以在 .env 里用 MC_VERSION 指定一个相近的原版版本（例如 1.20.4）。'
      log('ERROR', `[tools] getGameData ${error}`)
      return { error }
    }
    MC_DATA_CACHE.set(version, data)
    return data
  } catch (err) {
    const error = `加载 Minecraft ${version} 的数据失败：${describeError(err)}`
    log('ERROR', `[tools] query_game_knowledge ${error}`)
    return { error }
  }
}

/**
 * 在 mcData 里找物品/方块。
 * 容忍：大小写、连字符/空格（stone-pickaxe）、中文名反查（“石镐”）。
 */
function lookupGameItem(mcData, keyword) {
  const raw = String(keyword || '').trim()
  if (!raw) return null

  const id = raw.toLowerCase().replace(/[\s-]+/g, '_')
  let name = id

  if (!mcData.itemsByName[name] && !mcData.blocksByName[name]) {
    // 中文名反查：玩家直接用“石镐怎么做”提问时也能命中
    const zhHit = Object.entries(itemNameMap).find(([, zh]) => zh === raw)
    if (!zhHit) return null
    name = zhHit[0]
  }

  const item = mcData.itemsByName[name]
  const block = mcData.blocksByName[name]
  if (!item && !block) return null

  // 配方按**物品 id** 索引；方块名通常也有同名物品（如 crafting_table），取不到就退回 block.id
  const itemEntry = item || mcData.itemsByName[name] || null

  return {
    name: (item || block).name,
    displayName: (item || block).displayName || (item || block).name,
    itemId: itemEntry ? itemEntry.id : null,
    stackSize: itemEntry && itemEntry.stackSize ? itemEntry.stackSize : 64,
    maxDurability: itemEntry ? itemEntry.maxDurability : undefined
  }
}

// ============================================================================
//  实体与掉落（query_type = entity / loot）
// ----------------------------------------------------------------------------
//  数据来源：
//    · mcData.entitiesByName —— 实体 ID、分类、体型（**没有血量字段**）
//    · mcData.entityLoot[name].drops —— 掉落物 / 概率 / 数量区间 / 是否仅玩家击杀
//    · mcData.blockLoot[name].drops  —— 方块掉落，带 silkTouch / noSilkTouch 标记
//  两个坑：
//    1) minecraft-data 不提供生物血量，只能靠 MOB_HEALTH 兜底（标注为“攻略常识”），
//       没收录的物种如实说“未收录”，绝不编一个数字。
//    2) blockLoot 里的 dropChance 0.5 + silkTouch/noSilkTouch 并不代表 50% 概率，
//       它表示“精准采集掉 A / 普通挖掘掉 B”这一对分支，不能按百分比展示。
// ============================================================================

/** 常见生物基础血量（minecraft-data 无此字段，攻略常识表；不在表里就说未收录） */
const MOB_HEALTH = {
  allay: 20,
  axolotl: 14,
  bat: 6,
  bee: 10,
  blaze: 20,
  camel: 32,
  cat: 10,
  cave_spider: 12,
  chicken: 4,
  cod: 3,
  cow: 10,
  creeper: 20,
  dolphin: 10,
  donkey: 15,
  drowned: 20,
  elder_guardian: 80,
  ender_dragon: 200,
  enderman: 40,
  endermite: 8,
  evoker: 24,
  fox: 10,
  frog: 10,
  ghast: 10,
  glow_squid: 10,
  goat: 10,
  guardian: 30,
  hoglin: 40,
  husk: 20,
  illusioner: 32,
  iron_golem: 100,
  llama: 30,
  magma_cube: 16,
  mooshroom: 10,
  mule: 15,
  ocelot: 10,
  panda: 20,
  parrot: 6,
  phantom: 20,
  pig: 10,
  piglin: 16,
  piglin_brute: 50,
  pillager: 24,
  polar_bear: 30,
  pufferfish: 3,
  rabbit: 3,
  ravager: 100,
  salmon: 3,
  sheep: 8,
  shulker: 30,
  silverfish: 8,
  skeleton: 20,
  skeleton_horse: 15,
  slime: 16,
  snow_golem: 4,
  spider: 16,
  squid: 10,
  stray: 20,
  strider: 20,
  trader_llama: 30,
  tropical_fish: 3,
  turtle: 30,
  vex: 14,
  villager: 20,
  vindicator: 24,
  wandering_trader: 20,
  warden: 500,
  witch: 26,
  wither: 300,
  wither_skeleton: 20,
  wolf: 8,
  zoglin: 40,
  zombie: 20,
  zombie_villager: 20,
  zombified_piglin: 20
}

/** 血量会随体型/状态变化的生物，补一句说明 */
const MOB_HEALTH_NOTE = {
  slime: '（大型 16，随体型变化）',
  magma_cube: '（大型 16，随体型变化）',
  wolf: '（野生 8，驯服后 20）',
  llama: '（普通 15，商队羊驼 30）',
  horse: '（15 ~ 30，按个体）'
}

/** 统一展示名：“中文(english_id)”，没有中文映射就只给 ID */
function labelOf(name) {
  const zh = itemNameMap[name] || entityNameMap[name]
  return zh ? `${zh}(${name})` : String(name)
}

/**
 * 在 mcData 里找实体。容忍：大小写、连字符/空格、中文名反查。
 * @returns {{name:string, displayName:string, category:string, type:string, width:number, height:number}|null}
 */
function lookupGameEntity(mcData, keyword) {
  const raw = String(keyword || '').trim()
  if (!raw) return null

  const id = raw.toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_')
  let name = id

  if (!mcData.entitiesByName || !mcData.entitiesByName[name]) {
    const zhHit = Object.entries(entityNameMap).find(([, zh]) => zh === raw)
    if (!zhHit) return null
    name = zhHit[0]
  }

  const entity = mcData.entitiesByName && mcData.entitiesByName[name]
  if (!entity) return null

  return {
    name: entity.name,
    displayName: entity.displayName || entity.name,
    category: entity.category || '未知分类',
    type: entity.type || 'unknown',
    width: entity.width,
    height: entity.height
  }
}

/** 掉落概率 → 人话（0.00833 显示成 0.8%，而不是 0.8333333333%） */
function describeChance(chance) {
  if (!Number.isFinite(chance) || chance >= 0.999) return '必掉'
  const percent = chance * 100
  return percent >= 1 ? `约 ${Math.round(percent)}%` : `约 ${percent.toFixed(1)}%`
}

/** 数量区间 → x1 / x1~2 */
function describeAmount(range) {
  const min = Array.isArray(range) ? range[0] : 1
  const max = Array.isArray(range) ? range[1] : min
  const lo = Number.isFinite(min) ? min : 1
  const hi = Number.isFinite(max) ? max : lo
  return lo === hi ? `x${lo}` : `x${lo}~${hi}`
}

/** 实体掉落文本 */
function formatEntityLoot(mcData, entityName) {
  const entry = mcData.entityLoot && mcData.entityLoot[entityName]
  if (!entry) return '（minecraft-data 没有收录这个生物的掉落表）'

  const drops = Array.isArray(entry.drops) ? entry.drops : []
  if (drops.length === 0) {
    return '（掉落表为空：这个生物通常不掉落物品，或掉落由特殊机制处理）'
  }

  return drops
    .map((drop) => {
      const extra = drop.playerKill ? '，仅玩家击杀' : ''
      return `${labelOf(drop.item)} ${describeChance(drop.dropChance)}（${describeAmount(drop.stackSizeRange)}${extra}）`
    })
    .join('\n')
}

/** 方块掉落文本：把“精准采集 / 普通挖掘”两条分支分开展示 */
function formatBlockLoot(mcData, blockInfo) {
  const entry = mcData.blockLoot && mcData.blockLoot[blockInfo.name]

  if (!entry || !Array.isArray(entry.drops) || entry.drops.length === 0) {
    // 兜底：老版本只有 block.drops（物品 id 列表，没有概率信息）
    const block = mcData.blocksByName[blockInfo.name]
    const ids = block && Array.isArray(block.drops) ? block.drops : []
    if (ids.length === 0) return '（minecraft-data 没有收录这个方块的掉落表）'
    const names = ids.map((id) => (mcData.items[id] && mcData.items[id].name) || `unknown_${id}`)
    return `掉落：${names.map(labelOf).join('、')}（旧版数据，无概率信息）`
  }

  const normal = []
  const silk = []
  const random = []

  for (const drop of entry.drops) {
    if (drop.silkTouch) silk.push(drop)
    else if (drop.noSilkTouch) normal.push(drop)
    else random.push(drop)
  }

  const lines = []
  const fmt = (drop) => `${labelOf(drop.item)} ${describeAmount(drop.stackSizeRange)}`

  if (normal.length > 0) lines.push(`普通挖掘：${normal.map(fmt).join('、')}`)
  if (silk.length > 0) lines.push(`精准采集：${silk.map(fmt).join('、')}`)
  if (random.length > 0) {
    lines.push(
      `概率掉落：${random
        .map((drop) => `${labelOf(drop.item)} ${describeChance(drop.dropChance)}（${describeAmount(drop.stackSizeRange)}）`)
        .join('、')}`
    )
  }

  return lines.join('\n')
}

/** 分支 B：实体信息文本（血量 + 分类 + 体型 + 掉落） */
function formatEntityInfo(mcData, entity) {
  const health = MOB_HEALTH[entity.name]
  const note = MOB_HEALTH_NOTE[entity.name] || ''
  const healthText = health ? `${health}/20${note}` : '未收录（minecraft-data 不提供血量字段）'
  const size =
    Number.isFinite(entity.width) && Number.isFinite(entity.height)
      ? `${entity.width} × ${entity.height} 格`
      : '未知'

  return (
    `生物：${labelOf(entity.name)}\n` +
    `类别：${entity.category}\n` +
    `基础血量：${healthText}\n` +
    `体型：${size}\n` +
    `掉落：\n${formatEntityLoot(mcData, entity.name)}`
  )
}

/** 分支 C：方块/生物掉落文本（先按方块查，查不到再当成生物） */
function formatLootInfo(mcData, keyword) {
  const blockInfo = lookupGameItem(mcData, keyword)

  if (blockInfo && mcData.blocksByName[blockInfo.name]) {
    return (
      `方块：${labelOf(blockInfo.name)}\n` +
      `硬度：${mcData.blocksByName[blockInfo.name].hardness ?? '未知'}\n` +
      `掉落：\n${formatBlockLoot(mcData, blockInfo)}`
    )
  }

  const entity = lookupGameEntity(mcData, keyword)
  if (entity) {
    return `生物：${labelOf(entity.name)}\n掉落：\n${formatEntityLoot(mcData, entity.name)}`
  }

  return null
}

/** 分支 A：物品属性文本 */
function formatItemInfo(info) {
  const zh = itemNameMap[info.name]
  const label = zh ? `${zh}（${info.name}）` : `${info.displayName}（${info.name}）`
  const durability = info.maxDurability
    ? `最大耐久：${info.maxDurability}`
    : '最大耐久：无（该物品没有耐久度）'
  return `物品：${label}\n最大堆叠：${info.stackSize}\n${durability}`
}

/** 格子里的“未知物品”占位：前端会直接显示文字，不去拼贴图 URL */
const UNKNOWN_ITEM = '未知物品'

/** 数字 id → 名字；当前版本数据里没有就返回空串（由调用方决定怎么兜底） */
function nameById(mcData, id) {
  if (id == null) return ''
  const item = mcData.items && mcData.items[id]
  if (item && item.name) return item.name
  const block = mcData.blocks && mcData.blocks[id]
  return block && block.name ? block.name : ''
}

/** 3x3 有序合成表：**严格 Markdown**，第一行当表头，紧跟分隔行，空位填“空” */
function renderShapeTable(mcData, inShape) {
  const rows = []
  for (let r = 0; r < 3; r++) {
    const cells = []
    for (let c = 0; c < 3; c++) {
      const id = Array.isArray(inShape[r]) ? inShape[r][c] : null
      // 版本不匹配 / 模组配方会出现“id 对不上名字”的情况：
      // 这里绝不把 unknown_123 这种假 ID 丢给前端（拼不出图标还会误导模型），统一写“未知物品”
      cells.push(id == null ? '空' : nameById(mcData, id) || UNKNOWN_ITEM)
    }
    rows.push(`| ${cells.join(' | ')} |`)
  }
  return [rows[0], '| --- | --- | --- |', rows[1], rows[2]].join('\n')
}

/** 无序合成材料：把重复 id 聚合成 “oak_planks x4” */
function formatIngredients(mcData, ingredients) {
  const counts = new Map()
  for (const id of ingredients) {
    const name = nameById(mcData, id) || UNKNOWN_ITEM
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => `${name} x${count}`).join(', ')
}

/** 把 inShape 摊平成 3x3（不足 3 行/列的配方补 null），长度恒为 9 */
function flattenShape(inShape) {
  const cells = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      cells.push(Array.isArray(inShape[r]) && inShape[r][c] != null ? inShape[r][c] : null)
    }
  }
  return cells
}

/** 形状指纹：只看“哪几格有料”，不看具体是什么料。形状相同 = 可聚合 */
function shapeSignature(inShape) {
  return flattenShape(inShape)
    .map((id) => (id == null ? '0' : '1'))
    .join('')
}

/**
 * 生成“可替换材料”说明（只对同一形状指纹的兄弟配方计算）。
 *
 * 例：木镐 12 种木板 → 表里画的是 oak_planks，说明里列出 spruce_planks 等 11 种；
 * 石镐 3 种石料 → 表里画 cobblestone，说明里列出 cobbled_deepslate、blackstone。
 */
function describeSubstitutions(mcData, baseRecipe, siblings) {
  const base = flattenShape(baseRecipe.inShape)
  const swaps = new Map() // 原材料名 → Set(可替代材料名)

  for (const recipe of siblings) {
    const current = flattenShape(recipe.inShape)
    for (let i = 0; i < base.length; i++) {
      const from = base[i]
      const to = current[i]
      if (from == null || to == null || from === to) continue

      const fromName = mcData.items[from] && mcData.items[from].name
      const toName = mcData.items[to] && mcData.items[to].name
      if (!fromName || !toName) continue

      if (!swaps.has(fromName)) swaps.set(fromName, new Set())
      swaps.get(fromName).add(toName)
    }
  }

  const lines = []
  for (const [fromName, altSet] of swaps) {
    const alternatives = [...altSet]
    const preview = alternatives.slice(0, 5).join('、')
    const tail = alternatives.length > 5 ? ` 等 ${alternatives.length} 种` : ''
    const kind = alternatives.every((name) => name.endsWith('_planks')) ? '任意木板' : '其他同类材料'
    lines.push(
      `注：图中的 ${fromName} 可以替换为${kind}（如 ${preview}${tail}，效果完全相同）。`
    )
  }
  return lines
}

/**
 * 分支 B：合成配方文本（严格 Markdown）。
 *
 * 输出约定（前端会正则解析，改动请同步 public/index.html）：
 *   · 每种有序配方：先一行 `产出：<英文ID> x<数量>`，紧跟 3 行 Markdown 表格；
 *   · 聚合说明：形状指纹相同的配方只画第一张表，**说明行紧跟在表格下一行**
 *     （说明行不含 `|`，前端会把它当普通文本渲染，不会误判成新表格）；
 *   · 无序配方：`所需材料：a xN, b xM（无序...）`；
 *   · 熔炼：`熔炉烧炼：放入 <原料>，产出 <产物>`。
 */
function formatRecipeMarkdown(mcData, info) {
  const recipes = (info.itemId != null && mcData.recipes[info.itemId]) || []

  // 同一种物品常有多个材料方案（工作台有 12 种木板，石镐有圆石/深板岩/黑石三种）。
  // 排序目标：让“最常见”的方案排第一 —— 深板岩/黑石/异种木板这类冷门材料往后压，
  // 同等冷门程度再按材料 id 升序（结果稳定，不随数据文件顺序漂移）。
  const UNCOMMON_MATERIAL_RE = /deepslate|blackstone|cherry|bamboo|mangrove|crimson|warped|polished/
  const variantKey = (recipe) => {
    const ids = (recipe.inShape || []).flat().filter((id) => id != null)
    if (ids.length === 0) return Number.MAX_SAFE_INTEGER
    const names = ids.map((id) => (mcData.items[id] && mcData.items[id].name) || '')
    const uncommon = names.some((name) => UNCOMMON_MATERIAL_RE.test(name)) ? 1 : 0
    return uncommon * 1e9 + Math.min(...ids)
  }

  const shaped = recipes
    .filter((recipe) => Array.isArray(recipe.inShape))
    .sort((a, b) => variantKey(a) - variantKey(b))
  const shapeless = recipes.filter(
    (recipe) => Array.isArray(recipe.ingredients) && !Array.isArray(recipe.inShape)
  )
  // 熔炼原料必须按当前版本过滤：1.12.2 没有 raw_iron，直接跳过而不是报错
  const smeltSources = resolveSmeltSources(mcData, info.name)
  const version = versionLabelOf(mcData)

  if (shaped.length === 0 && shapeless.length === 0 && smeltSources.length === 0) {
    return (
      `当前版本（v${version}）里 ${info.name} 没有合成/熔炼配方：` +
      '它可能需要交易、怪物掉落，或在特定结构（村庄/要塞/沉船）里获取。'
    )
  }

  const zh = itemNameMap[info.name]
  const title = zh ? `${info.name}（${zh}）` : info.name
  const blocks = []

  // 特征聚合：形状指纹相同的配方合成一组，只画一张表 + 一行“可替换材料”说明。
  // 木镐 12 种木板、石镐 3 种石料都属同一组，不必刷 12 张一模一样的表。
  const groups = []
  const groupIndexOf = new Map()
  for (const recipe of shaped) {
    const signature = shapeSignature(recipe.inShape)
    if (!groupIndexOf.has(signature)) {
      groupIndexOf.set(signature, groups.length)
      groups.push([])
    }
    groups[groupIndexOf.get(signature)].push(recipe)
  }

  const shownGroups = groups.slice(0, MAX_RECIPE_VARIANTS)

  shownGroups.forEach((group, index) => {
    const recipe = group[0]
    const count = (recipe.result && recipe.result.count) || 1
    const suffix = groups.length > 1 ? `（配方 ${index + 1}/${groups.length}）` : ''
    const lines = [
      `产出：${info.name} x${count}${suffix}`,
      renderShapeTable(mcData, recipe.inShape)
    ]
    if (group.length > 1) lines.push(...describeSubstitutions(mcData, recipe, group.slice(1)))
    blocks.push(lines.join('\n'))
  })

  if (groups.length > shownGroups.length) {
    blocks.push(`（还有 ${groups.length - shownGroups.length} 种形状不同的配方未展开）`)
  }

  shapeless.slice(0, MAX_RECIPE_VARIANTS).forEach((recipe) => {
    const count = (recipe.result && recipe.result.count) || 1
    blocks.push(
      `所需材料：${formatIngredients(mcData, recipe.ingredients)}（无序，产出 ${info.name} x${count}）`
    )
  })

  if (smeltSources.length > 0) {
    // 原料候选可能不止一个（1.20 的粗铁和铁矿石都能烧），按版本过滤后全部列出
    blocks.push(`熔炉烧炼：放入 ${smeltSources.join(' 或 ')}，产出 ${info.name}`)
  }

  return [`合成配方：${title}`, blocks.join('\n\n')].join('\n')
}

/**
 * query_game_knowledge 主实现（同步，纯查表，不产生任何副作用）。
 *
 * 输入：`{ query_type: 'item' | 'recipe' | 'entity' | 'loot' | 'wiki', keyword: 英文ID或中文名 }`
 * 输出：`{ __raw: true, text }`
 *   · item   → 三行文本（物品名 / 最大堆叠 / 最大耐久）
 *   · recipe → 严格 Markdown（`产出：<id> x<n>` + 3x3 表格 + 可选替换说明）
 *   · entity → 生物分类 / 基础血量 / 体型 / 掉落表
 *   · loot   → 方块掉落（区分精准采集与普通挖掘）或生物掉落
 *   · wiki   → 实时检索 minecraft.wiki，返回 3 条摘要（唯一会联网的分支）
 *
 * 为什么返回对象而不是裸字符串：`executeTool` 会对所有工具输出跑 localizeText，
 * 那会把表格里的 `cobblestone` 包成「圆石(cobblestone)」，前端就拼不出贴图 URL 了。
 * `__raw: true` 是“跳过汉化”的显式标记，改这个协议前先看 public/index.html 的解析逻辑。
 */
async function queryGameKnowledge(bot, args) {
  const queryType = String(args.query_type || '').trim().toLowerCase()
  const keyword = String(args.keyword || '').trim()

  if (!keyword) {
    return {
      __raw: true,
      text: '缺少 keyword：请传物品 / 方块 / 生物的英文 ID（例如 stone_pickaxe、iron_ore、zombie）。'
    }
  }

  // ---- Wiki：唯一不依赖 minecraft-data 的分支（机制、攻略、版本内容） ----
  //   放在最前面：即使游戏数据加载失败，机制类问题也应该能查。
  if (queryType === 'wiki') {
    log('TOOL', `[tools] query_game_knowledge：wiki ${keyword}`)
    return { __raw: true, text: await searchMinecraftWiki(keyword) }
  }

  const mcData = getGameData(bot)
  if (mcData.error) return { __raw: true, text: mcData.error }

  // 所有“查不到”的提示都带上真实版本号，玩家一眼能判断是版本问题还是拼写问题
  const version = versionLabelOf(mcData)

  // ---- 实体：分类 / 血量 / 体型 / 掉落 ----
  if (queryType === 'entity') {
    const entity = lookupGameEntity(mcData, keyword)
    if (!entity) {
      return {
        __raw: true,
        text:
          `当前版本（v${version}）未找到生物 "${keyword}"，可能是模组生物或该版本不存在。` +
          'keyword 用英文 ID（zombie、creeper）或中文名（僵尸）；如果问的是方块，请把 query_type 换成 loot。'
      }
    }
    log('TOOL', `[tools] query_game_knowledge：entity ${entity.name}`)
    return { __raw: true, text: formatEntityInfo(mcData, entity) }
  }

  // ---- 掉落：先按方块查，查不到再当成生物查 ----
  if (queryType === 'loot') {
    const text = formatLootInfo(mcData, keyword)
    if (!text) {
      return {
        __raw: true,
        text:
          `当前版本（v${version}）未找到 "${keyword}" 的掉落信息，可能是模组物品或该版本不存在。` +
          'keyword 用英文 ID（iron_ore、zombie）或中文名（铁矿石、僵尸）；' +
          '如果问的是生物信息（血量/分类），请把 query_type 换成 entity。'
      }
    }
    log('TOOL', `[tools] query_game_knowledge：loot ${keyword}`)
    return { __raw: true, text }
  }

  // ---- 物品属性 / 配方：需要先解析到具体物品 ----
  const info = lookupGameItem(mcData, keyword)
  if (!info) {
    return {
      __raw: true,
      text:
        `当前版本（v${version}）未找到该物品或配方 "${keyword}"，可能是模组物品或该版本不存在。` +
        'keyword 必须是英文 ID（stone_pickaxe、oak_planks），不能填方块的中文译名。'
    }
  }

  if (queryType === 'recipe') {
    log('TOOL', `[tools] query_game_knowledge：recipe ${info.name}`)
    return { __raw: true, text: formatRecipeMarkdown(mcData, info) }
  }

  if (queryType === 'item') {
    log('TOOL', `[tools] query_game_knowledge：item ${info.name}`)
    return { __raw: true, text: formatItemInfo(info) }
  }

  return {
    __raw: true,
    text: `query_type 只能是 item、recipe、entity、loot、wiki，收到的是 "${args.query_type}"。`
  }
}

// ============================================================================
//  启动版本自检（Sanity Check）
// ----------------------------------------------------------------------------
//  为什么需要：minecraft-data 的版本号来自握手包，一旦 bot.version 识别错
//  （或服务端是模组服、版本对不上），后续所有查询都会静默返回空结果 ——
//  模型只会以为“世界上没有铁矿石”，然后开始瞎猜。
//
//  做法：用几组带别名的核心物品探针（1.12.2 没有 oak_log，只有 log），
//  只要有一组全体缺失，或该版本连配方表都是空的，就判定数据异常。
// ============================================================================
const CORE_VERSION_PROBES = [
  { label: '橡木原木', names: ['oak_log', 'log'] },
  { label: '石镐', names: ['stone_pickaxe'] },
  { label: '铁矿石', names: ['iron_ore'] },
  { label: '工作台', names: ['crafting_table'] },
  { label: '熔炉', names: ['furnace'] }
]

/**
 * 校验“当前连接版本的游戏数据是否可用”。
 * 纯查询、无副作用，可以在 spawn 时反复调用。
 *
 * @param {object} bot
 * @returns {{ok: boolean, version: string, missing: string[], recipeCount: number, reason: string, checkedAt: number}}
 */
function verifyGameData(bot) {
  const version = resolveGameVersion(bot)
  const checkedAt = Date.now()

  const mcData = getGameData(bot)
  if (mcData.error) {
    return {
      ok: false,
      version,
      missing: CORE_VERSION_PROBES.map((probe) => probe.label),
      recipeCount: 0,
      reason: mcData.error,
      checkedAt
    }
  }

  const missing = CORE_VERSION_PROBES.filter(
    (probe) => !probe.names.some((name) => itemExists(mcData, name))
  ).map((probe) => probe.label)

  const recipeCount = mcData.recipes ? Object.keys(mcData.recipes).length : 0
  const ok = missing.length === 0 && recipeCount > 0

  const reason = ok
    ? ''
    : missing.length > 0
      ? `核心物品缺失：${missing.join('、')}`
      : '该版本没有任何配方数据'

  return { ok, version, missing, recipeCount, reason, checkedAt }
}

module.exports = {
  // 名称字典：tools.js 的汉化与 labelName() 要用
  itemNameMap,
  entityNameMap,
  // 知识查询
  queryGameKnowledge,
  searchMinecraftWiki,
  stripHtml,
  verifyGameData,
  versionLabelOf,
  resolveSmeltSources,
  UNKNOWN_ITEM,
  // 以下仅诊断/单测用
  formatItemInfo,
  formatRecipeMarkdown,
  formatEntityInfo,
  formatLootInfo,
  formatEntityLoot,
  formatBlockLoot,
  lookupGameItem,
  lookupGameEntity,
  getGameData,
  resolveGameVersion
}
