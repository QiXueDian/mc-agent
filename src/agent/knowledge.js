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
  redstone_dust: '红石粉'
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

/** 熔炼表（产物 → 原料）：minecraft-data 不提供，内置常用项兜底 */
const SMELTING_RECIPES = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  charcoal: 'oak_log',
  brick: 'clay_ball',
  deepslate: 'cobbled_deepslate',
  cooked_beef: 'beef',
  cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken',
  cooked_mutton: 'mutton',
  cooked_rabbit: 'rabbit',
  cooked_cod: 'cod',
  cooked_salmon: 'salmon',
  baked_potato: 'potato',
  dried_kelp: 'kelp'
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

/** 分支 A：物品属性文本 */
function formatItemInfo(info) {
  const zh = itemNameMap[info.name]
  const label = zh ? `${zh}（${info.name}）` : `${info.displayName}（${info.name}）`
  const durability = info.maxDurability
    ? `最大耐久：${info.maxDurability}`
    : '最大耐久：无（该物品没有耐久度）'
  return `物品：${label}\n最大堆叠：${info.stackSize}\n${durability}`
}

/** 3x3 有序合成表：**严格 Markdown**，第一行当表头，紧跟分隔行，空位填“空” */
function renderShapeTable(mcData, inShape) {
  const rows = []
  for (let r = 0; r < 3; r++) {
    const cells = []
    for (let c = 0; c < 3; c++) {
      const id = Array.isArray(inShape[r]) ? inShape[r][c] : null
      cells.push(id == null ? '空' : (mcData.items[id] && mcData.items[id].name) || `unknown_${id}`)
    }
    rows.push(`| ${cells.join(' | ')} |`)
  }
  return [rows[0], '| --- | --- | --- |', rows[1], rows[2]].join('\n')
}

/** 无序合成材料：把重复 id 聚合成 “oak_planks x4” */
function formatIngredients(mcData, ingredients) {
  const counts = new Map()
  for (const id of ingredients) {
    const name = (mcData.items[id] && mcData.items[id].name) || `unknown_${id}`
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
  const smeltInput = SMELTING_RECIPES[info.name]

  if (shaped.length === 0 && shapeless.length === 0 && !smeltInput) {
    return (
      `没有找到 ${info.name} 的合成配方：它可能需要熔炼、交易、怪物掉落，` +
      '或在特定结构（村庄/要塞/沉船）里获取。'
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

  if (smeltInput) blocks.push(`熔炉烧炼：放入 ${smeltInput}，产出 ${info.name}`)

  return [`合成配方：${title}`, blocks.join('\n\n')].join('\n')
}

/**
 * query_game_knowledge 主实现（同步，纯查表，不产生任何副作用）。
 *
 * 输入：`{ query_type: 'item' | 'recipe', keyword: 英文ID或中文名 }`
 * 输出：`{ __raw: true, text }`
 *   · item   → 三行文本（物品名 / 最大堆叠 / 最大耐久）
 *   · recipe → 严格 Markdown（`产出：<id> x<n>` + 3x3 表格 + 可选替换说明）
 *
 * 为什么返回对象而不是裸字符串：`executeTool` 会对所有工具输出跑 localizeText，
 * 那会把表格里的 `cobblestone` 包成「圆石(cobblestone)」，前端就拼不出贴图 URL 了。
 * `__raw: true` 是“跳过汉化”的显式标记，改这个协议前先看 public/index.html 的解析逻辑。
 */
function queryGameKnowledge(bot, args) {
  const queryType = String(args.query_type || '').trim().toLowerCase()
  const keyword = String(args.keyword || '').trim()

  const mcData = getGameData(bot)
  if (mcData.error) return { __raw: true, text: mcData.error }

  if (!keyword) {
    return { __raw: true, text: '缺少 keyword：请传物品的英文 ID（例如 stone_pickaxe）。' }
  }

  const info = lookupGameItem(mcData, keyword)
  if (!info) {
    return {
      __raw: true,
      text:
        `找不到物品 "${keyword}"。keyword 必须是英文 ID（例如 stone_pickaxe、oak_planks），` +
        '不能填中文名，也不要用方块的中文译名。'
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
    text: `query_type 只能是 item 或 recipe，收到的是 "${args.query_type}"。`
  }
}

module.exports = {
  // 名称字典：tools.js 的汉化与 labelName() 要用
  itemNameMap,
  entityNameMap,
  // 知识查询
  queryGameKnowledge,
  // 以下仅诊断/单测用
  formatItemInfo,
  formatRecipeMarkdown,
  lookupGameItem,
  getGameData,
  resolveGameVersion
}
