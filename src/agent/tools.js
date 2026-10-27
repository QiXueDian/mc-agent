/**
 * ============================================================================
 *  src/agent/tools.js —— 工具定义与执行层（v4：全能版）
 * ----------------------------------------------------------------------------
 *  v4 在 v3（采集/合成）之上补齐了“泛用能力”，让 Agent 不再只会挖矿：
 *    · find_entities        环境感知（只读，先侦察再动手）
 *    · attack_entity        战斗狩猎（自动装最强武器 + 追赶 + 持续挥击）
 *    · interact_with_block   万物交互（开箱 / 种地 / 用桶 / 剪羊毛 / 按钮门拉杆）
 *    · equip_item           动态换装（主手 / 副手 / 头盔 / 胸甲 / 护腿 / 靴子）
 *
 *  v2 的两个真实漏洞，本版本针对性修复：
 *
 *   漏洞 1｜“强行寻路捡物品”会卡死
 *     挖完方块后，掉落物通常会被玩家自动吸进背包（服务端在 ~1 格内直接判定拾取），
 *     这时地上根本没有 item 实体。旧代码还去 nearestEntity 里找、找到了再 goto，
 *     结果 pathfinder 拿着一个“马上要消失的实体”坐标反复算路 → 报 No path 或卡死。
 *     修复：先 sleep 1000ms 让引擎完成自动吸附，然后**先比较背包数量**：
 *       数量变了 → 说明已经自动捡到，直接进入下一轮，绝不碰 nearestEntity；
 *       数量没变 → 才用 bot.nearestEntity 找 5 格内的 item，找到了再走过去，找不到就算了。
 *
 *   漏洞 2｜没有工具还一直挖（例如石镐缺失时挖 stone）
 *     大模型不知道“挖 stone 需要镐子”这个前置条件，只会一遍遍调用工具。
 *     修复：挖之前先做能力检查：
 *       1) block.diggable —— 基岩/水/空气这类根本挖不动的，直接说清楚；
 *       2) block.harvestTools —— 这是 prismarine-block 给出的“能收获该方块的物品 ID 表”，
 *          为空表示空手可挖；非空时如果背包里一件匹配的都没有，立刻返回
 *          “我没有合适的工具挖掘 stone，可能需要先去合成一把镐子”，
 *          把决策权交回 ReAct 循环，而不是死磕。
 *
 *  注意：bot.canDigBlock(block) 的内部实现是
 *        block.diggable && 距离 <= 5.1
 *  它**不检查工具**，而且远距离调用必然返回 false（会误判成“挖不动”）。
 *  所以本文件的用法是：
 *        远处 → 用 harvestTools 判断工具是否够（决定要不要白跑一趟）；
 *        到旁边 → 再用 bot.canDigBlock 做最终复核（此时距离判定才有意义）。
 *
 *  依赖：mineflayer-pathfinder（寻路），需在 bot 上已 loadPlugin(pathfinder)
 * ============================================================================
 */

const { Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalBlock } = goals
const { Vec3 } = require('vec3') // 放置工作台时要用到方向向量

// ------------------------------ 常量配置 ------------------------------
const SEARCH_RADIUS = 32 // 搜索方块的最大距离（格）
const DROP_RADIUS = 5 // 挖完后只在这 5 格内找掉落物（题目要求）
const AUTO_PICKUP_WAIT = 1000 // 挖完后等待自动吸附的时间（毫秒，题目要求 1000）
const GOTO_TIMEOUT = 30000 // 寻路到方块的超时（毫秒）
const PICKUP_TIMEOUT = 10000 // 走过去捡掉落物的超时（毫秒）
const DIG_TIMEOUT = 20000 // 单次挖掘的超时（毫秒）
const CHUNK_TIMEOUT = 8000 // 等待区块加载的超时（毫秒）
const CANDIDATES_PER_ROUND = 3 // 每一轮最多尝试靠近几个候选方块
const MAX_COUNT = 64 // 单次调用最多收集数量（防止模型传 99999）
const MAX_DIG_ATTEMPTS = 20 // 循环硬上限，工具自己也不允许无限挖

// ---- drop_item（清理背包）相关常量 ----
const MAX_DROP_COUNT = 2304 // 单次最多丢弃数量（36 格 × 64，防止模型传天文数字）
const DROP_TIMEOUT = 5000 // 单次丢弃动作超时（毫秒）
const DROP_SETTLE = 200 // 丢完等待服务器同步背包的时间（毫秒）

// ---- 自由移动 / 探索 / 环境扫描相关常量 ----
const MOVE_DEFAULT_TIMEOUT = 60000 // 移动基础超时
const MOVE_MAX_TIMEOUT = 180000 // 移动超时上限（长距离探索）
const MOVE_SINGLE_MAX = 256 // 单次 move_to 的最大距离（更远请分段）
const MOVE_TICK = 400 // 移动途中的巡检间隔（毫秒）
const HEALTH_DROP_LIMIT = 4 // 血量掉这么多点就判定“危险”，立刻停下
const DANGER_RADIUS = 2 // 危险方块检测半径（脚下 2 格内有岩浆就停）
const EXPLORE_DEFAULT_DISTANCE = 50 // explore 默认距离
const EXPLORE_MAX_DISTANCE = 200 // explore 单次距离上限
const SCAN_DEFAULT_RADIUS = 32 // scan_environment 默认半径
const SCAN_MAX_RADIUS = 64 // scan_environment 半径上限（再大就会明显卡顿）
const SCAN_MAX_ITEMS = 10 // 扫描结果最多列多少条（按距离排序后截断）

// ---- 泛用交互工具（战斗 / 交互 / 感知 / 换装）相关常量 ----
const ENTITY_RADIUS = 32 // 实体扫描半径（格）
const ATTACK_RADIUS = 32 // 攻击时最多跑多远去找目标（与感知半径保持一致）
const ATTACK_APPROACH_TIMEOUT = 20000 // 每次靠近目标的寻路超时
const ATTACK_DEADLINE = 30000 // 一次攻击任务的总时限（毫秒）
const ATTACK_SWING_INTERVAL = 620 // 两次挥击间隔（近似 Java 版武器冷却）
const MAX_ATTACK_SWINGS = 80 // 挥击次数上限，避免无意义狂点
const INTERACT_SEARCH_RADIUS = 16 // 交互目标方块的搜索半径
const INTERACT_TIMEOUT = 10000 // 交互动作超时
const EQUIP_TIMEOUT = 8000 // 换装动作超时

/**
 * 方块 ID 与掉落物 ID 不一致时的映射。
 * 例：挖 stone 掉 cobblestone，挖 *_ore 掉 raw_* / 煤。
 * 统计背包数量时必须用“掉落物名”，否则永远统计不到。
 */
const ITEM_ALIAS = {
  stone: 'cobblestone',
  grass_block: 'dirt',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli'
}

/** 工具等级从高到低，用于在背包里挑“最好用的那件” */
const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

// 名称字典与知识查询已抽到 knowledge.js（tools → knowledge 单向依赖，禁止反向）
const { itemNameMap, entityNameMap, queryGameKnowledge } = require('./knowledge')


/**
 * 把一段文本里的英文 ID 批量替换成 “中文(ID)” 格式。
 *
 * 三个关键细节：
 *   1) 正则按 key 长度倒序排列 —— 先匹配 stone_pickaxe，再匹配 stone，
 *      否则 "stone_pickaxe" 会被拆成 "石头(pickaxe)" 这种乱码。
 *   2) 用 \b 单词边界 —— cobblestone 里的 stone 不会命中；stone_pickaxe 里的
 *      stone 也不会命中（下划线属于 \w）。
 *   3) 负向后行断言 (?<!\() —— 已经汉化过的 “圆石(cobblestone)” 不会被重复包裹，
 *      所以本函数可以放心地对同一段文本多次调用（幂等）。
 */
const LOCALIZE_KEYS = Object.keys({ ...itemNameMap, ...entityNameMap }).sort(
  (a, b) => b.length - a.length
)
const LOCALIZE_REGEX = new RegExp(`(?<!\\()\\b(${LOCALIZE_KEYS.join('|')})\\b`, 'g')
const LOCALIZE_MAP = { ...itemNameMap, ...entityNameMap }

/** 单个物品/实体：中文名(英文ID)，没有映射则原样返回 */
function labelName(englishId) {
  if (!englishId) return englishId
  const zh = LOCALIZE_MAP[englishId]
  return zh ? `${zh}(${englishId})` : englishId
}

/** 批量汉化一段文本（幂等） */
function localizeText(text) {
  if (typeof text !== 'string' || text === '') return text
  return text.replace(LOCALIZE_REGEX, (matched) => `${LOCALIZE_MAP[matched]}(${matched})`)
}

/**
 * “材料不足”时的冶炼提示：目标物品 → 真正该烧的原料。
 * craft_item 只走配方系统，找不到冶炼路径，模型就会一直纠结“缺 iron_block”，
 * 提前把“该去熔炉”的结论说出来，能省掉好几步无效思考。
 */
const SMELTING_SOURCE = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  glass: 'sand',
  stone: 'cobblestone',
  charcoal: 'oak_log',
  brick: 'clay_ball'
}

// ------------------------------ 公共工具函数（统一从 utils 引入，避免重复实现） ------------------------------
const { sleep, withTimeout, formatPos, describeError, log } = require('./utils')
// 生存判定与 loop.js 共用同一套阈值，避免“循环里说缺氧、工具里说没缺氧”这种自相矛盾
const { readSurvivalState, formatSurvivalLine } = require('./survival')

/** 根据方块名猜一个“该用什么工具”的提示词，用于给大模型看的失败原因 */
function guessToolHint(blockName) {
  if (/ore|stone|cobble|deepslate|obsidian|brick|concrete|terracotta|_block$/.test(blockName)) return '镐子'
  if (/_log$|_wood$|planks|_fence|_door|crafting_table|bookshelf/.test(blockName)) return '斧头'
  if (/dirt|sand|gravel|clay|snow|_grass|farmland|soul_soil/.test(blockName)) return '锹'
  return '合适的工具'
}

// ------------------------------ 工具定义（给大模型看的说明书） ------------------------------
/**
 * 格式必须符合 OpenAI tools 规范：
 *   { type: 'function', function: { name, description, parameters: JSONSchema } }
 *
 * description 里必须写清两件事，否则模型会犯错：
 *   1) 本工具自带寻路与拾取 —— 避免它因为“担心没捡起来”而重复调用；
 *   2) 失败如果是“缺工具”，要去想别的办法 —— 避免它换个参数继续死磕。
 */
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'collect_resource',
      description:
        '【高级采集工具】自动完成“找最近的指定方块 → 检查工具是否够用 → 寻路走过去 → 挖掘 → 等待物品自动吸附/主动去捡”的全过程，' +
        '一次调用即可让背包里该资源的数量达到 count。自带寻路和拾取，不需要额外调用“捡东西”或反复调用挖掘。\n' +
        '注意两点：\n' +
        '1) 如果返回结果提示“没有合适的工具/需要先去合成”，说明当前装备不足：请想别的办法（例如先去合成或寻找镐子、斧头、锹），' +
        '不要用相同参数反复调用本工具。\n' +
        '2) 如果返回结果提示“附近没有该资源”，说明需要先移动到别的区域，同样不要原地重复调用。',
      parameters: {
        type: 'object',
        properties: {
          block_name: {
            type: 'string',
            description: '要收集的资源英文 ID，例如 oak_log、stone、dirt'
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_COUNT,
            description: '希望背包里最终拥有多少个（绝对值，不是增量）'
          }
        },
        required: ['block_name', 'count'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description:
        '获取机器人当前状态：坐标、维度、血量、饥饿值、手上物品、背包占用格数与物品种类数、背包清单。不需要参数。' +
        '背包快满时会附带提醒——看到提醒就先用 drop_item 清理，否则捡不起新掉落物。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'craft_item',
      description:
        '【合成工具】按照 Minecraft 配方合成物品。调用前请确保背包里有足够的原材料（例如合成木板需要木头、合成木棍需要木板），' +
        '材料不足会直接失败并告诉你缺什么。\n' +
        '游戏机制说明：\n' +
        '1) 2x2 的小配方（如木板、木棍、工作台）空手就能合成；\n' +
        '2) 3x3 的配方（如木镐、铁镐、剑）必须先有工作台，本工具会自动检查：周围有工作台就直接用，' +
        '背包里有工作台就自动找地方放下再合成；都没有则返回错误，提示你先合成 crafting_table（4 个木板）。\n' +
        '3) count 是希望得到的目标数量，工具会自动换算需要执行几次配方。',
      parameters: {
        type: 'object',
        properties: {
          item_name: {
            type: 'string',
            description: '要合成的物品英文 ID，例如 oak_planks、stick、crafting_table、wooden_pickaxe'
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 64,
            description: '希望合成的目标数量（例如 4 表示想拿到 4 个）'
          }
        },
        required: ['item_name', 'count'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'attack_entity',
      description:
        '【战斗/狩猎】找到最近的指定实体并持续攻击，直到它死亡或超时。会自动装备背包里攻击力最高的武器，' +
        '并自动寻路追赶（目标会移动）。entity_name 用英文实体 ID：zombie、skeleton、creeper、cow、pig、sheep、chicken、player。' +
        '注意：它不是万能的——血量过低、目标比自己强太多时会失败，请先用 find_entities 判断。',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: '目标实体英文 ID，例如 zombie、cow、sheep'
          }
        },
        required: ['entity_name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'interact_with_block',
      description:
        '【万物交互】走到指定方块旁边并与之交互，这是种地、开箱、交易的核心工具。\n' +
        'action 说明：\n' +
        '1) activate（默认）：右键激活方块——打开 chest / barrel / furnace / crafting_table 容器界面（会汇报箱内物品并自动关闭），' +
        '或按按钮、拉开关、开门、翻耕等；\n' +
        '2) use_on：把手中物品用在方块上——拿锄头锄 dirt 变 farmland、拿种子种到 farmland、拿骨粉催熟作物、' +
        '拿水桶对着水/地面取放水、拿剪刀剪羊毛。使用前请先用 equip_item 拿好对应物品。',
      parameters: {
        type: 'object',
        properties: {
          block_name: {
            type: 'string',
            description: '目标方块英文 ID，例如 chest、crafting_table、farmland、dirt、water'
          },
          action: {
            type: 'string',
            enum: ['activate', 'use_on'],
            description: 'activate = 右键激活方块；use_on = 把手中物品用在该方块上'
          }
        },
        required: ['block_name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_entities',
      description:
        '【环境感知】扫描周围 32 格内的实体，返回数量与最近目标的坐标、距离；没有目标时会汇总附近都有什么。' +
        '在决定“打不打、能不能种、附近有没有敌人”之前先用它侦察，不要盲目调用 attack_entity。',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: '要查找的实体英文 ID（zombie、cow、player…）；留空则汇总附近所有实体类型'
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'equip_item',
      description:
        '【换装】把背包里的物品装备到正确槽位：剑/镐/斧/锹/弓/剪刀 → 主手，盾牌/图腾 → 副手，' +
        '头盔/胸甲/护腿/靴子 → 对应护甲槽。挖矿、战斗、剪羊毛、举盾之前先换好装备能显著提升效率与生存率。',
      parameters: {
        type: 'object',
        properties: {
          item_name: {
            type: 'string',
            description: '要装备的物品英文 ID，例如 stone_pickaxe、iron_helmet、shield'
          }
        },
        required: ['item_name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'drop_item',
      description:
        '【清理背包】从背包里丢掉指定物品，用来腾出空间（背包 36 格塞满后就捡不起任何新掉落物）。\n' +
        '规则：\n' +
        '1) count 大于或等于背包现有数量时，会把该物品整组全部丢光；否则只丢指定数量；\n' +
        '2) 只影响背包，不会去捡或移动地上的物品；\n' +
        '3) 只应该丢价值极低的方块（dirt、gravel、andesite、diorite、granite、tuff、netherrack、多余的 cobblestone），' +
        '绝对不要丢 diamond、iron_ingot、gold_ingot、coal、食物、工具、武器、护甲、原木等有价值物品；\n' +
        '4) 调用前请先在思考（THOUGHT）里说明原因，例如“背包空间不足，我需要丢弃一些泥土”，丢完继续原任务。',
      parameters: {
        type: 'object',
        properties: {
          item_name: {
            type: 'string',
            description: '要丢弃的物品英文 ID，例如 dirt、gravel、andesite'
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_DROP_COUNT,
            description: '想丢弃的数量；大于或等于背包现有数量时表示全部丢光'
          }
        },
        required: ['item_name', 'count'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_to',
      description:
        '【自由移动】让机器人走到指定的绝对坐标（x, y, z），可以用来回家、去指挥官指定的地点、绕开挡路的地形。\n' +
        '内置安全保护：移动途中如果附近出现岩浆/火焰/仙人掌，或血量突然掉了 4 点以上，会立刻停下并返回中断原因。\n' +
        '注意：\n' +
        '1) 不知道自己在哪就先调用 get_status；\n' +
        '2) 返回“移动中断/走不过去”时不要用相同坐标反复重试，先 scan_environment 看地形，或分两段绕行；\n' +
        '3) 只是想扩大搜索范围、并没有明确坐标时，用 explore 更省事。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '目标 X 坐标（整数）' },
          y: { type: 'number', description: '目标 Y 坐标（高度）' },
          z: { type: 'number', description: '目标 Z 坐标（整数）' }
        },
        required: ['x', 'y', 'z'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'explore',
      description:
        '【探索】朝某个方向走一段距离，用来扩大活动范围、寻找当前视野里没有的资源。\n' +
        'direction 支持 north / south / east / west（也可写中文：北 / 南 / 东 / 西）；省略或写 random 则随机选一个方向。\n' +
        'distance 默认 50 格。移动途中遇到岩浆/火焰或血量骤降会立刻中断并告诉你为什么停下。\n' +
        '推荐节奏：explore 走一段 → scan_environment 复查 → 有目标就去采集，没有就换个方向继续。',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            description: '方向：north / south / east / west（或 北/南/东/西、random）'
          },
          distance: {
            type: 'integer',
            minimum: 5,
            maximum: EXPLORE_MAX_DISTANCE,
            description: '要走的距离（格），默认 50'
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scan_environment',
      description:
        '【环境雷达】扫描周围半径内的玩家、怪物、动物，以及有价值的方块（各类矿石、原木、箱子、工作台、熔炉等），' +
        '按距离从近到远返回带方位的简明清单，例如“东边 10 格有僵尸(zombie)；西边 15 格有橡木原木(oak_log)”。\n' +
        '这是只读操作，不会改变世界，可以放心多调。找东西之前先扫一次，不要盲目调用 collect_resource 或 explore。',
      parameters: {
        type: 'object',
        properties: {
          radius: {
            type: 'integer',
            minimum: 8,
            maximum: SCAN_MAX_RADIUS,
            description: '扫描半径（格），默认 32'
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_game_knowledge',
      description:
        '【游戏知识查询】查询 Minecraft 官方数据（minecraft-data）：物品属性与合成/熔炼配方。\n' +
        '当玩家问“怎么做某物品”“某物品有什么用/能干什么”时**必须先调用本工具**，不要凭记忆回答。\n' +
        'query_type=item 查物品属性（堆叠上限、最大耐久）；query_type=recipe 查合成配方。\n' +
        'keyword 必须是物品的英文 ID（例如 stone_pickaxe、torch），不能填中文名。\n' +
        '注意：recipe 返回的 3x3 表格是 Markdown 格式，最终回复里必须**原样保留**，前端会自动渲染成图形。',
      parameters: {
        type: 'object',
        properties: {
          query_type: {
            type: 'string',
            enum: ['item', 'recipe'],
            description: 'item = 查物品属性；recipe = 查合成/熔炼配方'
          },
          keyword: {
            type: 'string',
            description: '物品的英文 ID，例如 stone_pickaxe、oak_planks、torch'
          }
        },
        required: ['query_type', 'keyword'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'escape_danger',
      description:
        '【保命·最高优先级】当你在水下氧气不足、血量过低或身上着火时立刻调用：' +
        '先游泳上浮出水，必要时（仅水下缺氧时）挖开头顶 1 格，再走向最近的岸边。' +
        '不要在安全状态下调用它来代替普通移动（正常赶路请用 move_to / explore）。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'locate_structure',
      description:
        '【结构侦察】按村庄特征方块（床/箱子/钟/工作台/熔炉/书架…）和实体（村民/流浪商人/铁傀儡/猫）' +
        '在半径 64 格内搜索，返回命中种类、数量、最近距离与方位。' +
        '找村庄、营地、据点时**必须先用它**，不要用 scan_environment 一大圈瞎找。只读，不会移动。',
      parameters: {
        type: 'object',
        properties: {
          radius: {
            type: 'integer',
            minimum: 16,
            maximum: 96,
            description: '扫描半径（格），默认 64；超过 96 会被截断'
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  }
]

// ------------------------------ 寻路配置 ------------------------------
/**
 * 为 pathfinder 设置默认 Movements（移动参数）。
 * mcbot.js / brain.js 在 spawn 后会调用它。
 */
function setupMovements(bot) {
  if (!bot.pathfinder) {
    throw new Error('bot.pathfinder 不存在，请先执行 bot.loadPlugin(pathfinder)')
  }

  const movements = new Movements(bot)
  movements.canDig = true // 允许挖穿挡路的方块
  movements.allow1by1towers = true // 允许垫脚往上爬
  movements.canOpenDoors = true // 允许开门
  movements.allowParkour = true
  movements.maxDropDown = 4 // 最多跳下 4 格

  // 垫脚方块（pathfinder 里属性名就是 scafoldingBlocks 这个拼写）
  movements.scafoldingBlocks = ['dirt', 'cobblestone', 'oak_planks']
    .map((name) => bot.registry.itemsByName[name]?.id)
    .filter((id) => id !== undefined)

  bot.pathfinder.setMovements(movements)
  bot.pathfinder.thinkTimeout = 15000
  bot.pathfinder.tickTimeout = 40

  return movements
}

// ------------------------------ 背包统计 ------------------------------
/** 该方块的掉落物 ID（如 stone -> cobblestone，oak_log -> oak_log） */
function getItemName(blockName) {
  return ITEM_ALIAS[blockName] || blockName
}

/**
 * 统计背包里某种“掉落物”的总数量。
 * inventory.items() 会把同一格堆叠算作 item.count，同一物品可能分布在多个格子，所以要累加。
 */
function countInInventory(bot, blockName) {
  const itemName = getItemName(blockName)
  return bot.inventory
    .items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0)
}

// ------------------------------ 工具能力检查（漏洞 2 的修复核心） ------------------------------
/**
 * 在背包里挑一件“能收获该方块、且等级最高”的工具。
 *
 * prismarine-block 的 block.harvestTools 形如 { 800: true, 801: true }，
 * key 是物品 type（数字 ID），value 恒为 true，表示这些物品都能正常挖出掉落物。
 * 该字段为 undefined 时表示“空手也能挖出东西”（泥土、木头等）。
 *
 * @returns {object|null} mineflayer Item，或 null（背包里没合适的）
 */
function findHarvestTool(bot, block) {
  const items = bot.inventory.items()

  if (!block.harvestTools) {
    // 空手可挖：顺手找把斧头加快速度（没有也无所谓）
    return items.find((item) => item.name.endsWith('_axe')) || null
  }

  const candidates = items.filter((item) => block.harvestTools[item.type])
  if (candidates.length === 0) return null

  // 等级高的排前面（netherite > diamond > iron > stone > golden > wooden）
  const rank = (name) => {
    const index = TOOL_TIERS.findIndex((tier) => name.startsWith(tier))
    return index === -1 ? TOOL_TIERS.length : index
  }
  candidates.sort((a, b) => rank(a.name) - rank(b.name))
  return candidates[0]
}

/**
 * 挖掘前的“能力检查”。分两种情况返回：
 *   { ok: true, tool }                → 可以挖，tool 是建议装备的工具（可能为 null）
 *   { ok: false, kind, message }      → 不能挖，kind 用于上层决定“换方块”还是“直接结束”
 *
 * kind 取值：
 *   'undiggable'  —— 方块本身不可破坏（基岩、水、空气…），换一个候选方块即可
 *   'missing-tool'—— 缺工具，换多少个方块都没用，应该立刻把结论交回大模型
 */
function checkDigCapability(bot, block) {
  // 1) 方块本身能不能破坏
  if (!block.diggable) {
    return {
      ok: false,
      kind: 'undiggable',
      message: `${block.name} 这种方块无法被破坏`
    }
  }

  // 2) 工具前置条件：harvestTools 存在 = 必须用对应等级的镐/斧/锹才挖得出东西
  const tool = findHarvestTool(bot, block)
  if (block.harvestTools && !tool) {
    const hint = guessToolHint(block.name)
    return {
      ok: false,
      kind: 'missing-tool',
      message: `我没有合适的工具挖掘 ${block.name}，可能需要先去合成一把${hint}（或去背包/箱子里找一件）。`
    }
  }

  return { ok: true, tool }
}

/** 装备工具（失败不影响后续尝试，只打日志） */
async function equipTool(bot, tool) {
  if (!tool) return
  if (bot.heldItem && bot.heldItem.name === tool.name) return
  try {
    await bot.equip(tool, 'hand')
  } catch (err) {
    log('WARN',`[tools] 装备 ${tool.name} 失败：${describeError(err)}`)
  }
}

// ------------------------------ 智能拾取（漏洞 1 的修复核心） ------------------------------
/**
 * 挖完之后“保险式”捡掉落物。
 *
 * 【为什么不是无条件 nearestEntity】
 *   绝大多数情况下，方块被打掉的瞬间物品就会自动飞进背包（服务端拾取判定半径 ~1 格），
 *   地上根本没有 item 实体。此时：
 *     - 如果还去找实体，通常找到的是“正在消失的旧实体”，坐标已经失效；
 *     - 拿失效坐标去 pathfinder.goto，就会一直算不出路 → 报 No path 或把循环卡死。
 *
 * 【正确顺序】
 *   1) 先等 1000ms，让自动吸附完成；
 *   2) 比较背包数量——变了就直接返回，绝不去碰 nearestEntity；
 *   3) 只有数量没变，才去 nearestEntity 找 5 格内的 item；
 *   4) 找到了才寻路（外面包 try/catch，走不过去也只是“这次没捡到”，绝不抛错）；
 *   5) 没找到就安静地返回，由调用方继续下一轮循环。
 *
 * @param {object} bot
 * @param {string} blockName   方块名（用于统计背包掉落物）
 * @param {number} beforeCount 挖掘前的背包数量
 * @returns {Promise<{pickedBy: 'auto'|'walk'|'none', count: number}>}
 */
async function smartPickup(bot, blockName, beforeCount) {
  // 1) 给游戏引擎时间把物品吸进背包
  await sleep(AUTO_PICKUP_WAIT)

  // 2) 自动吸附成功：直接收工
  const afterAuto = countInInventory(bot, blockName)
  if (afterAuto > beforeCount) {
    return { pickedBy: 'auto', count: afterAuto }
  }

  // 3) 数量没变 → 物品还在地上，找最近的掉落物实体
  //    bot.nearestEntity(predicate) 会遍历 bot.entities 并返回距离最近的匹配实体；
  //    这里额外用 5 格半径过滤，避免去追远处（甚至掉进岩浆里）的物品。
  let drop = null
  try {
    drop = bot.nearestEntity(
      (entity) =>
        entity &&
        entity !== bot.entity &&
        entity.name === 'item' && // 掉落物的实体名固定是 'item'，不是物品 ID
        entity.position &&
        entity.position.distanceTo(bot.entity.position) <= DROP_RADIUS
    )
  } catch (err) {
    // 实体表在区块卸载时可能瞬变，取实体这一步出错也不该让整个采集失败
    log('WARN',`[tools] 查找掉落物实体失败：${describeError(err)}`)
  }

  if (!drop) {
    // 没找到 → 不报错，交给上层继续循环（物品可能已被别的玩家捡走 / 消失了）
    return { pickedBy: 'none', count: countInInventory(bot, blockName) }
  }

  // 4) 走过去（半径 1 即方块中心，触发拾取判定）
  try {
    await withTimeout(
      bot.pathfinder.goto(new GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)),
      PICKUP_TIMEOUT,
      '走向掉落物'
    )
    await sleep(300) // 等拾取判定
  } catch (err) {
    // 走不过去（掉落物在树上/墙角/已消失）→ 只告警，不抛错，不影响后续采集
    log('WARN',`[tools] 走向掉落物失败（忽略）：${describeError(err)}`)
    return { pickedBy: 'none', count: countInInventory(bot, blockName) }
  }

  const finalCount = countInInventory(bot, blockName)
  return { pickedBy: finalCount > beforeCount ? 'walk' : 'none', count: finalCount }
}

// ------------------------------ 单次挖掘 ------------------------------
/**
 * 挖一个方块：找最近的 → 能力检查 → 寻路靠近 → 复核 → 装备 → 挖 → 智能拾取。
 *
 * @returns {Promise<
 *   | {status:'dug', pos:object, pickedBy:string, count:number}
 *   | {status:'missing-tool', message:string}
 *   | {status:'not-found'}
 *   | {status:'unreachable'}
 * >}
 * 注意：这里不 throw，所有异常都在内部消化成状态码，方便上层统一拼字符串。
 */
async function digOneBlock(bot, blockName, blockId, target) {
  // 1) 找最近的一批候选方块（findBlocks 结果已按距离排序）
  const positions = bot.findBlocks({
    matching: blockId,
    maxDistance: SEARCH_RADIUS,
    count: CANDIDATES_PER_ROUND * 3
  })
  if (positions.length === 0) return { status: 'not-found' }

  // 2) 逐个候选尝试
  for (const pos of positions.slice(0, CANDIDATES_PER_ROUND)) {
    const block = bot.blockAt(pos)
    if (!block || block.name !== blockName) continue // 可能已被别人挖掉

    // 2.1 工具能力预检：远处也能判断，避免白跑一趟（漏洞 2 修复）
    const capability = checkDigCapability(bot, block)
    if (!capability.ok) {
      if (capability.kind === 'missing-tool') {
        // 缺工具：换方块也没用，直接把这个结论抛给大模型去思考
        return { status: 'missing-tool', message: capability.message }
      }
      // 不可破坏的方块：换下一个候选
      log('WARN',`[tools] 跳过 ${formatPos(pos)}：${capability.message}`)
      continue
    }

    // 2.2 如果已经在拾取范围内，先用官方 API 预检（含距离与 diggable）
    const inReach = bot.canDigBlock(block) === true

    // 2.3 寻路靠近（半径 2：方块本身占位，半径 1 常常无解）
    if (!inReach) {
      try {
        await withTimeout(
          bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2)),
          GOTO_TIMEOUT,
          '靠近方块'
        )
      } catch (err) {
        // 寻路失败不致命：可能已经在边上，也可能只是算路超时
        log('WARN',`[tools] 靠近 ${formatPos(pos)} 失败：${describeError(err)}`)
      }
    }

    // 2.4 到达后复查方块与世界状态
    const target0 = bot.blockAt(pos)
    if (!target0 || target0.name !== blockName) continue

    // 2.5 最终复核 bot.canDigBlock（此时距离判定才有意义）
    if (bot.canDigBlock(target0) === false) {
      log('WARN',`[tools] ${formatPos(pos)} 仍不可挖（超出范围或不可破坏），换下一个候选`)
      continue
    }

    // 2.6 装备工具（缺工具的情况上面已经提前返回了）
    await equipTool(bot, capability.tool)

    // 2.7 记录挖掘前的背包数量，用于判断是“自动吸附”还是“掉在地上”
    const beforeCount = countInInventory(bot, blockName)

    // 2.8 挖掘
    try {
      await withTimeout(bot.dig(target0), DIG_TIMEOUT, '挖掘方块')
    } catch (err) {
      log('WARN',`[tools] 挖掘 ${formatPos(pos)} 失败：${describeError(err)}`)
      continue // 换下一个候选方块
    }

    // 2.9 智能拾取：先等自动吸附，再看要不要走过去捡
    const pickup = await smartPickup(bot, blockName, beforeCount)

    log('TOOL',
      `[tools] 已挖掉 ${blockName} ${formatPos(pos)}；` +
        (pickup.pickedBy === 'auto'
          ? '物品已自动吸附进背包'
          : pickup.pickedBy === 'walk'
            ? '走过去捡起了掉落物'
            : '未捡到掉落物（已忽略，继续采集）') +
        `，背包现有 ${pickup.count}/${target}`
    )

    return { status: 'dug', pos, pickedBy: pickup.pickedBy, count: pickup.count }
  }

  return { status: 'unreachable' }
}

// ------------------------------ 高级工具：collect_resource ------------------------------
/**
 * collect_resource(bot, args) —— 高鲁棒性版本
 *
 * 参数：
 *   block_name  方块英文 ID（如 oak_log / stone）
 *   count       希望背包里最终拥有的数量（绝对值）
 *
 * 返回：一定是一句中文结果字符串（永不 throw），例如
 *   “成功收集了 2 个 oak_log（目标 3 个）。”
 *   “我没有合适的工具挖掘 stone，可能需要先去合成一把镐子。”
 *
 * 逻辑：
 *   1) 参数/环境校验 → 2) 等区块 → 3) 统计已有数量
 *   4) 循环：最多尝试挖掘 count 次，直到达标或没有资源
 *   5) 任何意外异常 → catch 后返回友好错误，让 ReAct 继续决策
 */
async function collectResource(bot, args = {}) {
  const blockName = args.block_name
  const rawCount = Number(args.count)

  try {
    // ---------------- 1. 参数校验 ----------------
    if (!blockName || typeof blockName !== 'string') {
      return '收集失败：缺少参数 block_name，请传入英文方块 ID，例如 oak_log'
    }
    if (!Number.isFinite(rawCount) || rawCount <= 0) {
      return '收集失败：count 必须是大于 0 的整数，例如 3'
    }

    const blockInfo = bot.registry.blocksByName[blockName]
    if (!blockInfo) {
      return `收集失败：当前游戏版本里不存在方块 "${blockName}"，请使用英文 ID，例如 oak_log`
    }
    if (!bot.pathfinder) {
      return '收集失败：机器人未加载 mineflayer-pathfinder 插件，无法寻路'
    }
    if (!bot.entity) {
      return '收集失败：机器人还没有出生（spawn），无法执行动作'
    }

    const target = Math.min(Math.floor(rawCount), MAX_COUNT)

    // ---------------- 2. 等区块加载 ----------------
    // 否则 findBlocks 会漏掉尚未加载的区块，导致“明明有树却说没有”
    try {
      await withTimeout(bot.waitForChunksToLoad(), CHUNK_TIMEOUT, '等待区块加载')
    } catch (err) {
      log('WARN',`[tools] ${describeError(err)}，继续尝试搜索`)
    }

    // ---------------- 3. 统计背包已有数量 ----------------
    const startHave = countInInventory(bot, blockName)
    log('TOOL',`[tools] collect_resource 开始：目标 ${target} 个 ${blockName}，背包已有 ${startHave} 个`)

    if (startHave >= target) {
      return `背包里已经有 ${startHave} 个 ${blockName}，已达到目标 ${target} 个，无需再收集`
    }

    // ---------------- 4. 主循环：最多尝试挖掘 count 次 ----------------
    const maxAttempts = Math.min(target, MAX_DIG_ATTEMPTS)
    let attempts = 0 // 已尝试挖掘的次数
    let stopReason = '' // 提前结束的原因（用于最终话术）

    for (let round = 1; round <= maxAttempts; round++) {
      // 每轮都重新统计背包：上一轮可能因为自动吸附/走过去捡而增加了数量
      if (countInInventory(bot, blockName) >= target) break

      // step() 返回字符串表示“必须立刻结束”，返回 null 表示继续下一轮
      const stepResult = await digOneBlock(bot, blockName, blockInfo.id, target)
      attempts += 1

      if (stepResult.status === 'dug') {
        continue // 挖到了，回循环顶部重新判断是否达标
      }

      if (stepResult.status === 'missing-tool') {
        // 关键：把“缺工具”的结论直接交给大模型，让它去合成/找工具
        return stepResult.message
      }

      if (stepResult.status === 'not-found') {
        stopReason = `周围 ${SEARCH_RADIUS} 格内没有找到 ${blockName}`
        break
      }

      // unreachable：这一轮 3 个候选都靠近失败，下一轮会重新找别的方块
      stopReason = `${blockName} 一时挖不到（可能被遮挡或道路不通）`
      await sleep(300)
    }

    // ---------------- 5. 汇总真实结果 ----------------
    const finalHave = countInInventory(bot, blockName)
    const gained = finalHave - startHave

    if (finalHave >= target) {
      return `成功收集了 ${gained} 个 ${blockName}，背包现在共有 ${finalHave} 个（目标 ${target} 个已达成）。`
    }
    if (gained > 0) {
      return (
        `成功收集了 ${gained} 个 ${blockName}（目标 ${target} 个）` +
        `，背包现在共有 ${finalHave} 个。` +
        (stopReason ? `停止原因：${stopReason}，需要的话请先移动到资源更多的地方。` : '')
      )
    }

    return (
      `没能收集到 ${blockName}（目标 ${target} 个）` +
      `：${stopReason || `已尝试 ${attempts} 次挖掘但没有收获`}，请先移动到有该资源的区域再试。`
    )
  } catch (err) {
    // ---------------- 6. 兜底：任何意外都转成“人话”返回 ----------------
    // 典型来源：区块卸载导致的 blockAt 返回 null、pathfinder 内部异常、
    //           实体表在遍历时被清空、bot 在挖掘途中死亡等。
    log('ERROR', `[tools] collect_resource 异常：${describeError(err)}${err && err.stack ? `\n${err.stack}` : ''}`)
    return `收集 ${blockName || '资源'} 时发生异常：${describeError(err)}。请检查机器人是否还活着/是否卡住，然后再试一次。`
  }
}

// ============================================================================
//  合成（Crafting）相关
// ----------------------------------------------------------------------------
//  Minecraft 的合成分成两套：
//    1) 2x2 配方（背包自带的合成格）：木板、木棍、工作台、火把…… → craftingTable 传 null
//    2) 3x3 配方（必须打开工作台）：木镐、剑、箱子…… → 必须给 bot.craft 传一个真实的方块实例
//  bot.recipesFor(id, metadata, minResultCount, craftingTable) 只返回“材料够 + 工作台条件满足”的配方，
//  所以它返回空数组时不一定是没配方，也可能只是缺材料/缺工作台 —— 下面用 recipesAll 做二次诊断。
// ============================================================================

const CRAFT_TABLE_NAME = 'crafting_table'
const TABLE_SEARCH_RADIUS = 16 // 周围找工作台的最大半径
const CRAFT_TIMEOUT = 20000 // 合成动作超时（毫秒）

/**
 * 一个“假的工作台”，仅用于 bot.recipesAll 的第三个参数。
 * 原因：recipesAll 内部只是做 `if (!recipe.requiresTable || craftingTable)` 的真值判断，
 * 传一个真值对象就能拿到“所有配方”（忽略工作台条件），从而区分
 * “这个物品压根没有配方” vs “有配方但缺工作台 / 缺材料”。
 */
const CRAFT_TABLE_FLAG = { __fakeCraftingTable: true }

/** 统计背包里某物品的总数量（同名物品可能分散在多个格子） */
function countItem(bot, itemName) {
  return bot.inventory
    .items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0)
}

/** 把材料名换成大模型更容易理解的叫法（避免出现 pale_oak_planks 这种干扰项） */
function friendlyMaterialName(name) {
  if (name.endsWith('_planks')) return '木板（任意木材种类都行）'
  if (name.endsWith('_log') || name.endsWith('_wood')) return '原木'
  if (name === 'stick') return '木棍'
  return name
}

/**
 * 检查执行 times 次配方后，材料是否够。
 * recipe.delta 形如 [{ id, metadata, count }]：
 *   count < 0 表示被消耗，count > 0 表示产出。
 * @returns {string[]} 缺失描述数组（空数组 = 材料充足）
 */
function missingMaterials(bot, recipe, times) {
  const missing = []

  for (const d of recipe.delta) {
    if (d.count >= 0) continue // 产物，跳过
    const need = -d.count * times
    const have = bot.inventory.count(d.id, d.metadata)
    if (have < need) {
      const name = bot.registry.items[d.id]?.name || `id:${d.id}`
      missing.push(`${friendlyMaterialName(name)} 需要 ${need} 个，背包只有 ${have} 个`)
    }
  }

  return missing
}

/**
 * 同一件物品往往有多个等价配方（例如木镐可以由 oak_planks / spruce_planks / pale_oak_planks… 合成）。
 * 这里挑“总缺口最小”的那个来生成提示，避免出现
 * “缺少 pale_oak_planks”，而机器人手里明明有 oak_planks 的误导信息。
 */
function pickClosestRecipe(bot, recipes, times) {
  let best = null

  for (const recipe of recipes) {
    const craftTimes = Math.max(1, times)
    let deficit = 0

    for (const d of recipe.delta) {
      if (d.count >= 0) continue
      const need = -d.count * craftTimes
      const have = bot.inventory.count(d.id, d.metadata)
      if (have < need) deficit += need - have
    }

    if (!best || deficit < best.deficit) {
      best = { recipe, deficit, missing: missingMaterials(bot, recipe, craftTimes) }
    }
  }

  return best
}

/** 在周围找现有的工作台方块 */
function findNearbyCraftingTable(bot) {
  const tableId = bot.registry.blocksByName[CRAFT_TABLE_NAME]?.id
  if (tableId === undefined) return null
  return bot.findBlock({ matching: tableId, maxDistance: TABLE_SEARCH_RADIUS }) || null
}

/**
 * 找一个能放方块的空位：脚下高度、四周相邻的“空气 + 下方实心”格子。
 * boundingBox：
 *   'empty'  → 空气/花草这类可穿过
 *   'block'  → 完整实心方块（可以当贴附面）
 */
function findPlaceSpot(bot) {
  const feet = bot.entity.position.floored()
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1]
  ]

  for (const [dx, dy, dz] of dirs) {
    const spot = feet.offset(dx, dy, dz)
    const body = bot.blockAt(spot) // 放置目标格
    const head = bot.blockAt(spot.offset(0, 1, 0)) // 上方要空（工作台有高度）
    const ground = bot.blockAt(spot.offset(0, -1, 0)) // 下方要实心，作为贴附面

    if (!body || !head || !ground) continue
    if (body.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue
    if (ground.boundingBox !== 'block') continue

    return { reference: ground, face: new Vec3(0, 1, 0), pos: spot }
  }

  return null
}

/**
 * 把背包里的工作台放到地上。
 * @returns {Promise<object|null>} 放置成功返回方块实例，失败返回 null
 */
async function placeCraftingTable(bot, tableItem) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const spot = findPlaceSpot(bot)

    if (spot) {
      try {
        await bot.equip(tableItem, 'hand')
        // placeBlock(贴附方块, 方向向量)：在 ground 上方一格放置手中的方块
        await withTimeout(bot.placeBlock(spot.reference, spot.face), 5000, '放置工作台')
        await sleep(300)

        const placed = bot.blockAt(spot.pos)
        if (placed && placed.name === CRAFT_TABLE_NAME) {
          log('TOOL',`[tools] 已在 ${formatPos(spot.pos)} 放置工作台`)
          return placed
        }
      } catch (err) {
        log('WARN',`[tools] 放置工作台失败：${describeError(err)}`)
      }
    }

    // 第一次没放成功：寻路到旁边一点的空地再试一次
    if (attempt === 1) {
      const p = bot.entity.position
      try {
        await withTimeout(
          bot.pathfinder.goto(new GoalNear(p.x + 3, p.y, p.z, 2)),
          15000,
          '寻找可放置的空地'
        )
      } catch (err) {
        log('WARN',`[tools] 移动到空地失败：${describeError(err)}`)
      }
    }
  }

  return null
}

/**
 * 确保手边有一个可用的工作台（3x3 配方的前提）。
 * 优先级：周围已有的 → 背包里的（放下）→ 失败返回 null
 */
async function ensureCraftingTableInReach(bot) {
  // 1) 周围已存在工作台：走过去（craft 时需要在 4~5 格内才能 activateBlock）
  const existing = findNearbyCraftingTable(bot)
  if (existing) {
    try {
      await withTimeout(
        bot.pathfinder.goto(
          new GoalNear(existing.position.x, existing.position.y, existing.position.z, 2)
        ),
        GOTO_TIMEOUT,
        '走向工作台'
      )
    } catch (err) {
      log('WARN',`[tools] 走向工作台失败：${describeError(err)}`)
    }
    return existing
  }

  // 2) 背包里有工作台：找地方放下
  const tableItem = bot.inventory.items().find((item) => item.name === CRAFT_TABLE_NAME)
  if (!tableItem) return null

  return await placeCraftingTable(bot, tableItem)
}

/**
 * craft_item 工具实现。
 *
 * 流程：
 *   1) 参数校验（item_name / count）
 *   2) 先尝试 2x2 配方（craftingTable 传 null）
 *   3) 2x2 不行 → 找/放工作台，再试 3x3
 *   4) 还是不行 → 用 recipesAll 诊断到底是“没配方”“缺工作台”还是“缺材料”，给出可执行的建议
 *   5) 真正合成前再核对材料数量（bot.craft 不会帮你算 times 的材料）
 *   6) bot.craft(recipe, times, tableBlock) 执行，最后用背包前后差值汇报真实结果
 *
 * @param {object} bot
 * @param {{item_name?: string, count?: number|string}} args
 * @returns {Promise<string>} 一定返回中文结果字符串
 */
async function craftItem(bot, args = {}) {
  const itemName = args.item_name
  const rawCount = Number(args.count)

  try {
    // ---------------- 1. 参数校验 ----------------
    if (!itemName || typeof itemName !== 'string') {
      return '合成失败：缺少参数 item_name，请传入英文物品 ID，例如 oak_planks'
    }
    if (!Number.isFinite(rawCount) || rawCount <= 0) {
      return '合成失败：count 必须是大于 0 的整数，例如 4'
    }
    if (!bot.entity) {
      return '合成失败：机器人还没有出生（spawn），无法执行合成'
    }

    const item = bot.registry.itemsByName[itemName]
    if (!item) {
      return `合成失败：物品 ID "${itemName}" 不存在，请使用英文 ID（如 oak_planks、crafting_table、wooden_pickaxe）`
    }

    const target = Math.min(Math.floor(rawCount), 64)

    // ---------------- 2. 先试 2x2（空手合成格） ----------------
    let tableBlock = null
    let recipes = bot.recipesFor(item.id, null, 1, null)
    let useTable = false

    // ---------------- 3. 2x2 不行 → 需要工作台 ----------------
    if (recipes.length === 0) {
      tableBlock = await ensureCraftingTableInReach(bot)

      if (tableBlock) {
        recipes = bot.recipesFor(item.id, null, 1, tableBlock)
        useTable = recipes.length > 0
      }

      // ---------------- 4. 仍然不行 → 诊断原因 ----------------
      if (recipes.length === 0) {
        // recipesAll 的第三个参数只做真值判断，给个真值对象即可拿到“全部配方”
        const allRecipes = bot.recipesAll(item.id, null, tableBlock || CRAFT_TABLE_FLAG)

        if (allRecipes.length === 0) {
          return `无法合成 ${itemName}：这个物品没有可用的合成配方（可能需要熔炉冶炼，或物品 ID 写错了）。`
        }

        const needsTable = allRecipes.every((r) => r.requiresTable)
        if (needsTable && !tableBlock) {
          const hasTableItem = bot.inventory.items().some((i) => i.name === CRAFT_TABLE_NAME)
          return (
            `无法合成 ${itemName}：这个配方需要工作台，但周围找不到工作台，` +
            (hasTableItem
              ? '背包里的工作台也没能放下去（附近没有空地）。请先走到开阔一点的地方再试。'
              : '背包里也没有 crafting_table。请先用 craft_item 合成 crafting_table（需要 4 个木板）并放置。')
          )
        }

        // 还有配方但材料不够 → 挑最接近的那个配方，明确告诉缺什么
        const times = Math.max(1, Math.ceil(target / allRecipes[0].result.count))
        const closest = pickClosestRecipe(bot, allRecipes, times)
        const missing = closest ? closest.missing : []

        // 有些“材料不足”其实是路径错了：铁锭/玻璃这类主要靠熔炉冶炼，
        // 用合成配方去找只会找到 iron_block → 9 锭这种歪门邪道，浪费一步思考。
        const smeltFrom = SMELTING_SOURCE[itemName]
        const smeltHint = smeltFrom
          ? `（提示：${labelName(itemName)} 通常是把 ${labelName(smeltFrom)} 放进熔炉烧出来的，当前工具集没有熔炼能力）`
          : ''

        return (
          `无法合成 ${labelName(itemName)}：材料不足。` +
          (missing.length
            ? `缺少：${missing.join('；')}。请先用 collect_resource 收集，或用 craft_item 合成中间材料。`
            : '请先收集足够的原材料。') +
          smeltHint
        )
      }
    }

    // ---------------- 5. 选定配方，换算执行次数 ----------------
    const recipe = recipes[0]
    const perCraft = recipe.result.count // 每执行一次配方产出几个（木板是 4）

    let times = Math.max(1, Math.ceil(target / perCraft))
    times = Math.min(times, 64) // 硬上限，防止模型传巨大数字把循环拖死

    // 材料够不够执行 times 次？不够就退化成 1 次
    let missing = missingMaterials(bot, recipe, times)
    if (missing.length) {
      times = 1
      missing = missingMaterials(bot, recipe, times)
      if (missing.length) {
        return `材料不足，合成失败：${missing.join('；')}。请先用 collect_resource 收集材料。`
      }
    }

    // ---------------- 6. 真正合成 ----------------
    const beforeCount = countItem(bot, itemName)
    log('TOOL',
      `[tools] craft_item 开始：${itemName} 目标 ${target}，执行 ${times} 次配方` +
        `（每次产出 ${perCraft} 个${useTable ? '，使用工作台' : '，空手合成'}）`
    )

    // 逐次执行配方，而不是 bot.craft(recipe, times, ...) 一口气跑完：
    //   1) mineflayer 连续多次合成时，客户端模拟的合成格与服务器容易短暂不同步
    //      （实测出现“第 3 次合成莫名产出一个 oak_button”），每次之间留 250ms 更稳；
    //   2) 每次都能检查背包，达标或材料耗尽就立刻停，不做无用功。
    let craftError = ''
    let executed = 0 // 实际成功执行的配方次数
    for (let i = 1; i <= times; i++) {
      // 每次合成前重新核对材料（上一次可能刚好把材料用光）
      const missingNow = missingMaterials(bot, recipe, 1)
      if (missingNow.length) {
        craftError = `材料在合成途中不足：${missingNow.join('；')}`
        break
      }

      try {
        // bot.craft 的第二个参数是“执行几次配方”，这里固定 1 次，次数由我们的循环控制
        await withTimeout(bot.craft(recipe, 1, useTable ? tableBlock : null), CRAFT_TIMEOUT, '合成物品')
      } catch (err) {
        // 常见原因：工作台被破坏/被挡、窗口被意外关闭、材料被其他操作消耗
        craftError = describeError(err)
        break
      }

      await sleep(250) // 等服务器把产物同步进背包
      executed += 1

      if (countItem(bot, itemName) - beforeCount >= target) break // 已经够了
    }

    // ---------------- 7. 用背包前后差值汇报真实结果 ----------------
    const finalCount = countItem(bot, itemName)
    const gained = finalCount - beforeCount

    if (gained >= target) {
      return `成功合成了 ${gained} 个 ${itemName}，背包现在共有 ${finalCount} 个（执行了 ${executed} 次配方）。`
    }
    if (gained > 0) {
      return (
        `只合成了 ${gained} 个 ${itemName}（目标 ${target} 个），背包现在共有 ${finalCount} 个。` +
        (craftError ? `中断原因：${craftError}。` : '')
      )
    }
    return (
      `合成 ${itemName} 失败：` +
      (craftError || `配方执行了 ${executed} 次，但背包数量没有变化`) +
      '。请确认材料是否足够、工作台是否还在。'
    )
  } catch (err) {
    // 兜底：任何意外都不让 ReAct 循环崩掉
    log('ERROR', `[tools] craft_item 异常：${describeError(err)}${err && err.stack ? `\n${err.stack}` : ''}`)
    return `合成 ${itemName || '物品'} 时发生异常：${describeError(err)}。请检查机器人状态后再试。`
  }
}

// ------------------------------ 工具：状态查询 ------------------------------
/**
 * get_status：坐标、维度、血量、饥饿值、手持物、背包里的木头数量。
 * 这些信息足够大模型回答“你在哪里”“你还好吗”，也能避免它盲目重复采集。
 */
function getStatus(bot) {
  if (!bot.entity) {
    return '机器人还没有出生（spawn），暂时无法获取坐标和状态'
  }

  const pos = bot.entity.position
  const health = Math.round(bot.health ?? 0)
  const food = Math.round(bot.food ?? 0)
  const held = bot.heldItem ? bot.heldItem.name : '空手'

  // 背包清单：合成任务需要看木板/木棍这类材料，所以列出全部物品（最多 15 格）
  const items = bot.inventory.items()
  const species = new Set(items.map((item) => item.name)).size
  const bagText = items.length
    ? items
        .slice(0, 15)
        .map((item) => `${labelName(item.name)} x${item.count}`)
        .join('、') + (items.length > 15 ? ' …' : '')
    : '空'

  // 长期挂机最容易踩的坑就是“背包满了还在挖”，所以把占用格数和种类数直接摆出来，
  // 让模型自己判断要不要先 drop_item 清理。
  const capacity = `背包占用 ${items.length}/36 格、共 ${species} 种`
  const fullHint =
    items.length >= 32 || species >= 30
      ? `⚠️ 背包快满了，捡不起新掉落物，请先用 drop_item 丢弃泥土(dirt)/砂砾(gravel) 这类低价值方块`
      : ''

  return (
    `当前坐标 ${formatPos(pos)}，所在维度 ${bot.game.dimension}；` +
    `血量 ${health}/20，饥饿值 ${food}/20；手上拿着 ${held}；` +
    `${capacity}；背包：${bagText}${fullHint ? `。${fullHint}` : ''}`
  )
}

// ============================================================================
//  泛用交互工具：环境感知 / 战斗 / 方块交互 / 换装
// ----------------------------------------------------------------------------
//  设计要点（为什么这些工具必须做成“宏指令”而不是让模型自己拼）：
//    - 实体是动态的：目标会移动、会掉血、会消失，模型拿到的坐标一秒后就失效，
//      所以“靠近 + 挥击 + 判定死亡”必须在一次工具调用内闭环完成。
//    - 槽位有语义：护甲不能塞主手，盾牌必须进副手，换装必须按物品名推断槽位。
//    - 交互分两种协议：activateBlock（右键方块）与 useOn（用物品作用在方块上），
//      选错了就是“打不开箱子”“种子种不下去”，因此交给 action 参数显式区分。
// ============================================================================

/** 等待区块加载（交互/战斗前调用，避免 findBlock / 实体表不完整） */
async function ensureChunksLoaded(bot) {
  try {
    await withTimeout(bot.waitForChunksToLoad(), CHUNK_TIMEOUT, '等待区块加载')
  } catch (err) {
    log('WARN', `[tools] ${describeError(err)}，继续尝试`)
  }
}

/** 取周围 radius 格内所有“有效”的实体（排除机器人自己） */
function nearbyEntities(bot, radius = ENTITY_RADIUS) {
  if (!bot.entity) return []
  const origin = bot.entity.position

  return Object.values(bot.entities).filter((entity) => {
    if (!entity || entity === bot.entity) return false
    if (!entity.position) return false
    // 实体消失后会从 bot.entities 里被删除；isValid 只做旧版本兼容兜底
    if (entity.isValid === false) return false
    return entity.position.distanceTo(origin) <= radius
  })
}

/**
 * 实体名匹配。
 * 支持三种写法：
 *   1) 精确 ID：'zombie'、'cow'、'oak_boat'
 *   2) 玩家名：entity.name 就是玩家用户名
 *   3) 分类别名：'player'（所有玩家）、'mob'（所有生物）、'hostile'（敌对生物）
 */
function matchesEntity(entity, entityName) {
  const wanted = String(entityName || '').toLowerCase().trim()
  if (!wanted) return true

  if (wanted === 'player') return entity.type === 'player'
  if (wanted === 'mob' || wanted === 'animal') return entity.type === 'mob'
  if (wanted === 'hostile') return entity.type === 'mob' && /hostile/i.test(entity.kind || '')

  const name = String(entity.name || '').toLowerCase()
  const display = String(entity.displayName || '').toLowerCase()
  return name === wanted || display === wanted
}

/** 汇总附近实体种类，用于“没找到 xxx”时给模型兜底信息 */
function summarizeNearbyEntities(bot, radius = ENTITY_RADIUS) {
  const counts = new Map()

  for (const entity of nearbyEntities(bot, radius)) {
    if (!entity.name) continue
    counts.set(entity.name, (counts.get(entity.name) || 0) + 1)
  }

  if (counts.size === 0) return `周围 ${radius} 格内没有看到任何实体`

  const list = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name} x${count}`)
    .join('、')

  return `附近能看到：${list}`
}

/** 找最近的匹配实体（按距离升序） */
function findNearestEntity(bot, entityName, radius = ENTITY_RADIUS) {
  if (!bot.entity) return null
  const origin = bot.entity.position

  const candidates = nearbyEntities(bot, radius)
    .filter((entity) => matchesEntity(entity, entityName))
    .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))

  return candidates[0] || null
}

// ------------------------------ find_entities ------------------------------
/**
 * 环境感知：返回周围 32 格内目标实体的数量 + 最近一个的坐标。
 * 这是个“只读”工具，永远不会改变世界，可以放心让模型多调。
 */
async function findEntities(bot, args = {}) {
  try {
    if (!bot.entity) return '扫描失败：机器人还没有出生（spawn）'

    // 刚 spawn 时区块还在流式加载，bot.entities 是空的，
    // 不等一下就会误报“周围什么都没有”（实测踩过）。
    await ensureChunksLoaded(bot)

    const entityName = String(args.entity_name || '').trim()
    const origin = bot.entity.position

    // 不指定名字时：给出“按类型汇总 + 最近坐标”，比只报一个总数有用得多
    if (!entityName) {
      const all = nearbyEntities(bot, ENTITY_RADIUS)
      if (all.length === 0) return summarizeNearbyEntities(bot, ENTITY_RADIUS)

      all.sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))
      const nearest = all[0]
      return (
        `${summarizeNearbyEntities(bot, ENTITY_RADIUS)}。` +
        `最近的一个是 ${nearest.name}，在 ${formatPos(nearest.position)}，` +
        `距离约 ${nearest.position.distanceTo(origin).toFixed(1)} 格。`
      )
    }

    const list = nearbyEntities(bot, ENTITY_RADIUS)
      .filter((entity) => matchesEntity(entity, entityName))
      .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))

    if (list.length === 0) {
      return entityName
        ? `周围 ${ENTITY_RADIUS} 格内没有找到 ${entityName}。${summarizeNearbyEntities(bot, ENTITY_RADIUS)}`
        : summarizeNearbyEntities(bot, ENTITY_RADIUS)
    }

    const nearest = list[0]
    const distance = nearest.position.distanceTo(origin)

    return (
      `周围 ${ENTITY_RADIUS} 格内找到 ${list.length} 个 ${entityName || '实体'}，` +
      `最近的一个在 ${formatPos(nearest.position)}，距离约 ${distance.toFixed(1)} 格。`
    )
  } catch (err) {
    log('ERROR', `[tools] find_entities 异常：${describeError(err)}`)
    return `扫描实体失败：${describeError(err)}`
  }
}

// ------------------------------ attack_entity ------------------------------
/** 武器评分：剑 > 斧（同材质），材质越高分越高；非武器返回 0 */
function weaponScore(itemName) {
  const tierIndex = TOOL_TIERS.findIndex((tier) => itemName.startsWith(tier))
  const tierScore = tierIndex === -1 ? 0 : TOOL_TIERS.length - tierIndex

  if (itemName.endsWith('_sword')) return 100 + tierScore
  if (itemName.endsWith('_axe')) return 60 + tierScore // 斧伤害高但攻速慢
  return 0
}

/** 装备背包里攻击力最高的武器；没有武器则保持现状（空手也能打） */
async function equipBestWeapon(bot) {
  const weapons = bot.inventory.items().filter((item) => weaponScore(item.name) > 0)
  if (weapons.length === 0) return null

  weapons.sort((a, b) => weaponScore(b.name) - weaponScore(a.name))
  const best = weapons[0]

  if (bot.heldItem && bot.heldItem.name === best.name) return best

  try {
    await bot.equip(best, 'hand')
    log('TOOL', `[tools] 已装备武器 ${best.name}`)
    return best
  } catch (err) {
    log('WARN', `[tools] 装备武器 ${best.name} 失败：${describeError(err)}`)
    return null
  }
}

/**
 * 实体是否还“活着”。
 * 三重判定：
 *   1) 已从 bot.entities 中移除 → 死亡/离开视野
 *   2) isValid === false（老版本字段）→ 已失效
 *   3) entity.health <= 0（部分生物会同步血量）→ 已死亡
 */
function isEntityAlive(bot, entity) {
  if (!entity) return false
  if (entity.isValid === false) return false
  if (!bot.entities[entity.id]) return false
  if (typeof entity.health === 'number' && entity.health <= 0) return false
  return true
}

/**
 * 战斗/狩猎：找最近的实体 → 装最强武器 → 追着打 → 直到死亡或超时。
 *
 * 为什么不用 pathfinder 的 GoalFollow？
 *   GoalFollow 会不停重算路径，对“边跑边打”反而容易抖；这里用
 *   “距离 > 3 就 goto 一次，否则原地挥击”的循环，更接近人类操作，也更好控制时限。
 */
async function attackEntity(bot, args = {}) {
  const entityName = String(args.entity_name || '').trim()

  try {
    if (!entityName) return '攻击失败：缺少参数 entity_name，例如 zombie、cow'
    if (!bot.entity) return '攻击失败：机器人还没有出生（spawn）'
    if (!bot.pathfinder) return '攻击失败：未加载 mineflayer-pathfinder 插件，无法追赶目标'

    // 血量保护：硬拼很可能送死，先把结论交回大模型
    if (typeof bot.health === 'number' && bot.health <= 5) {
      return `我现在只有 ${Math.round(bot.health)}/20 点血，硬拼很可能死亡。建议先吃东西回血或撤退。`
    }

    const target = findNearestEntity(bot, entityName, ATTACK_RADIUS)
    if (!target) {
      return `周围 ${ATTACK_RADIUS} 格内没有找到 ${entityName}。${summarizeNearbyEntities(bot, ENTITY_RADIUS)}`
    }

    const weapon = await equipBestWeapon(bot)
    log(
      'TOOL',
      `[tools] 开始攻击 ${entityName}（目标 ${formatPos(target.position)}，武器：${weapon ? weapon.name : '空手'}）`
    )

    const startedAt = Date.now()
    const deadline = startedAt + ATTACK_DEADLINE
    let swings = 0
    let approachFailures = 0

    while (Date.now() < deadline && swings < MAX_ATTACK_SWINGS) {
      if (!isEntityAlive(bot, target)) break

      const distance = target.position.distanceTo(bot.entity.position)

      // 目标会移动：距离超过 3 格就重新追一次
      if (distance > 3) {
        // 单次寻路不能超过“剩余总时限”，否则一次 20s 超时就把整个 30s 预算吃光
        const remaining = Math.max(2000, deadline - Date.now())
        try {
          await withTimeout(
            bot.pathfinder.goto(
              new GoalNear(target.position.x, target.position.y, target.position.z, 2)
            ),
            Math.min(ATTACK_APPROACH_TIMEOUT, remaining),
            '靠近目标'
          )
        } catch (err) {
          approachFailures += 1
          log('WARN', `[tools] 靠近目标失败（第 ${approachFailures} 次）：${describeError(err)}`)
          if (approachFailures >= 3) break
          await sleep(300)
          continue
        }
      }

      // 瞄准实体中心（身高 70% 处），避免挥空
      try {
        await bot.lookAt(target.position.offset(0, (target.height || 1.8) * 0.7, 0), true)
      } catch (_) {
        /* 瞄准失败也照样挥击 */
      }

      try {
        bot.attack(target)
        swings += 1
      } catch (err) {
        log('WARN', `[tools] 挥击失败：${describeError(err)}`)
        break
      }

      await sleep(ATTACK_SWING_INTERVAL) // 等武器冷却，避免无效点击
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    const killed = !isEntityAlive(bot, target)

    if (killed) {
      await sleep(500) // 给掉落物一点自动吸附时间
      return `成功击杀了 ${entityName}（位置 ${formatPos(target.position)}，挥击 ${swings} 次，耗时 ${seconds} 秒）`
    }

    return (
      `攻击 ${entityName} 未完成：挥击 ${swings} 次、耗时 ${seconds} 秒后目标仍未死亡` +
      `（可能跑远、被挡住或超时）。我当前血量 ${Math.round(bot.health ?? 0)}/20。`
    )
  } catch (err) {
    log('ERROR', `[tools] attack_entity 异常：${describeError(err)}`)
    return `攻击 ${entityName || '目标'} 时发生异常：${describeError(err)}。请检查机器人状态后再试。`
  }
}

// ------------------------------ equip_item ------------------------------
/** 槽位中文名，用于给模型的返回文案 */
const SLOT_LABEL = {
  hand: '主手',
  'off-hand': '副手',
  head: '头盔槽',
  torso: '胸甲槽',
  legs: '护腿槽',
  feet: '靴子槽'
}

/**
 * 按物品名推断装备槽位。
 * mineflayer 的 bot.equip(item, destination) 的 destination 只有这几个值：
 *   'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'
 * 塞错槽位服务端会直接拒绝，所以必须先映射。
 */
function destinationForItem(itemName) {
  const name = itemName.toLowerCase()

  if (name.endsWith('_helmet') || name.endsWith('_skull') || name === 'carved_pumpkin') return 'head'
  if (name.endsWith('_chestplate') || name === 'elytra') return 'torso'
  if (name.endsWith('_leggings')) return 'legs'
  if (name.endsWith('_boots')) return 'feet'
  if (name === 'shield' || name === 'totem_of_undying') return 'off-hand'

  return 'hand' // 工具、武器、食物、方块一律进主手
}

/** 动态换装：从背包取物品 → 推断槽位 → 装备 → 校验 */
async function equipItemTool(bot, args = {}) {
  const itemName = String(args.item_name || '').trim()

  try {
    if (!itemName) return '装备失败：缺少参数 item_name，例如 stone_pickaxe、iron_helmet'
    if (!bot.entity) return '装备失败：机器人还没有出生（spawn）'

    const item = bot.inventory.items().find((i) => i.name === itemName)
    if (!item) {
      const bag =
        bot.inventory
          .items()
          .map((i) => `${labelName(i.name)} x${i.count}`)
          .slice(0, 12)
          .join('、') || '空'
      return `装备失败：背包里没有 ${itemName}（可能需要先用 craft_item 合成或 collect_resource 采集）。当前背包：${bag}`
    }

    const destination = destinationForItem(itemName)

    await withTimeout(bot.equip(item, destination), EQUIP_TIMEOUT, '装备物品')

    // 主手要复核：护甲槽没有像 heldItem 这么方便的属性，只能信任 equip 不抛错
    if (destination === 'hand' && bot.heldItem?.name !== itemName) {
      return `已尝试把 ${itemName} 装备到主手，但主手显示的是 ${bot.heldItem ? bot.heldItem.name : '空'}，请稍后重试。`
    }

    return `已把 ${itemName} 装备到${SLOT_LABEL[destination] || destination}`
  } catch (err) {
    log('ERROR', `[tools] equip_item 异常：${describeError(err)}`)
    return `装备 ${itemName || '物品'} 失败：${describeError(err)}`
  }
}

// ------------------------------ drop_item ------------------------------
/**
 * 丢弃背包里的物品（长期挂机时“背包塞满”的唯一解法）。
 *
 * 为什么不能一把 tossStack 了事：
 *   mineflayer 的 tossStack(item) 一次只丢“这一格”，而同一物品往往分布在 3~4 格，
 *   只扔一次会出现“说丢了 64 个，其实只空了 1 格”。所以这里按 grid 逐格处理：
 *     · 想全丢 → 每个匹配的格子都 tossStack
 *     · 想丢一部分 → 每格用 toss(type, metadata, take) 精确控制数量
 *
 * 之所以每次都读“背包前后差值”而不是直接相信参数：
 *   服务端可能因为卡顿/被踢/窗口开着而静默忽略丢弃请求，
 *   不校验就会向指挥官谎报“已丢弃”，下一轮又开始重复调用。
 *
 * @param {object} bot
 * @param {{item_name?: string, count?: number|string}} args
 * @returns {Promise<string>} 一定返回中文结果字符串
 */
async function dropItem(bot, args = {}) {
  const rawName = String(args.item_name || '').trim()
  const rawCount = Number(args.count)

  try {
    // ---------------- 1. 参数校验 ----------------
    if (!rawName) return '丢弃失败：缺少参数 item_name，请传入英文物品 ID，例如 dirt'
    if (!Number.isFinite(rawCount) || rawCount <= 0) {
      return '丢弃失败：count 必须是大于 0 的整数，例如 10'
    }
    if (!bot.entity) return '丢弃失败：机器人还没有出生（spawn），无法执行动作'
    if (!bot.inventory) return '丢弃失败：背包数据还没同步，请稍后再试'

    // 兼容“填方块名”的写法：stone → cobblestone（挖石头掉的是圆石）
    const itemName = getItemName(rawName)
    const itemInfo = bot.registry.itemsByName[itemName]
    if (!itemInfo) {
      return `丢弃失败：物品 ID "${rawName}" 不存在，请使用英文 ID（例如 dirt、gravel、andesite）`
    }

    // ---------------- 2. 统计背包现有数量 ----------------
    const stacks = bot.inventory.items().filter((item) => item.name === itemName)
    const have = stacks.reduce((sum, item) => sum + item.count, 0)

    if (have === 0) {
      const bag =
        bot.inventory
          .items()
          .map((i) => `${labelName(i.name)} x${i.count}`)
          .slice(0, 12)
          .join('、') || '空'
      return `丢弃失败：背包里没有 ${rawName}。当前背包：${bag}`
    }

    // ---------------- 3. 关掉容器界面 ----------------
    // 箱子/工作台窗口开着时，服务端会忽略丢弃包，表现为“什么都没发生”。
    if (bot.currentWindow) {
      try {
        await bot.closeWindow(bot.currentWindow)
        await sleep(150)
      } catch (err) {
        log('WARN', `[tools] 关闭容器界面失败（继续尝试丢弃）：${describeError(err)}`)
      }
    }

    // ---------------- 4. 计算并执行丢弃 ----------------
    const want = Math.min(Math.floor(rawCount), MAX_DROP_COUNT)
    const dropAll = want >= have // 数量大于等于现有 → 全部丢光

    let dropped = 0

    // 每一轮都重新读一遍背包（不复用上面的 stacks 快照）：
    // tossStack / toss 会改变格子内容，拿旧快照去丢第二次很容易丢错格子或重复丢同一格。
    // guard 是硬上限（36 格最多 36 次），同时用“数量没变化就退出”防止死循环。
    if (dropAll) {
      for (let guard = 0; guard < 40; guard++) {
        const stack = bot.inventory.items().find((item) => item.name === itemName)
        if (!stack) break

        const before = countItem(bot, itemName)
        try {
          await withTimeout(bot.tossStack(stack), DROP_TIMEOUT, '丢弃整组物品')
        } catch (err) {
          log('WARN', `[tools] 丢弃 ${itemName} 整组失败：${describeError(err)}`)
        }
        await sleep(DROP_SETTLE)

        const after = countItem(bot, itemName)
        dropped += Math.max(0, before - after)
        if (after >= before) break // 服务端没确认，别在原地刷包
      }
    } else {
      // 丢一部分：按格子切分，用 toss 精确控制数量
      let remaining = want
      for (let guard = 0; guard < 40 && remaining > 0; guard++) {
        const stack = bot.inventory.items().find((item) => item.name === itemName)
        if (!stack) break

        const take = Math.min(remaining, stack.count)
        const before = countItem(bot, itemName)
        try {
          await withTimeout(bot.toss(stack.type, stack.metadata, take), DROP_TIMEOUT, '丢弃物品')
        } catch (err) {
          log('WARN', `[tools] 丢弃 ${itemName} x${take} 失败：${describeError(err)}`)
        }
        await sleep(DROP_SETTLE)

        const actually = Math.max(0, before - countItem(bot, itemName))
        dropped += actually
        remaining -= actually
        if (actually === 0) break // 没丢动（界面没关/卡住），交给上层决定
      }
    }

    // ---------------- 5. 用背包真实差值汇报（绝不谎报） ----------------
    const left = countItem(bot, itemName)

    if (dropped === 0) {
      return (
        `丢弃 ${rawName} 失败：服务端没有确认丢弃，背包里仍然是 ${left} 个。` +
        '可能是界面没关、机器人卡住或在死亡状态，请先 get_status 检查。'
      )
    }

    log('TOOL', `[tools] drop_item：${itemName} 丢弃 ${dropped} 个，剩余 ${left} 个`)

    if (left === 0) {
      return `已丢弃 ${dropped} 个 ${itemName}，这个物品已经全部丢光，空出了背包空间`
    }
    return `已丢弃 ${dropped} 个 ${itemName}，背包里还剩 ${left} 个`
  } catch (err) {
    log('ERROR', `[tools] drop_item 异常：${describeError(err)}`)
    return `丢弃 ${rawName || '物品'} 时发生异常：${describeError(err)}。请检查机器人状态后再试。`
  }
}

// ------------------------------ interact_with_block ------------------------------
/**
 * 万物交互：种地、开箱、用桶、剪羊毛都靠它。
 *
 * 两种协议必须区分清楚，否则会出现“打不开 / 种不下去”：
 *   activateBlock(block)  → 右键方块本身（开箱子、按按钮、拉门、工作台）
 *   useOn(block)          → 用当前手持物品作用于方块（锄头锄地、种子种地、骨粉、水桶、剪刀）
 */
async function interactWithBlock(bot, args = {}) {
  const blockName = String(args.block_name || '').trim()
  const action = String(args.action || 'activate').toLowerCase()

  try {
    if (!blockName) return '交互失败：缺少参数 block_name，例如 chest、crafting_table、farmland'
    if (!['activate', 'use_on'].includes(action)) {
      return `交互失败：action 只能是 "activate" 或 "use_on"，收到 "${action}"`
    }
    if (!bot.entity) return '交互失败：机器人还没有出生（spawn）'
    if (!bot.pathfinder) return '交互失败：未加载 mineflayer-pathfinder 插件，无法寻路'

    const blockInfo = bot.registry.blocksByName[blockName]
    if (!blockInfo) {
      return `交互失败：方块 ID "${blockName}" 不存在，请用英文 ID（例如 chest、crafting_table、farmland、water）`
    }

    await ensureChunksLoaded(bot)

    const block = bot.findBlock({ matching: blockInfo.id, maxDistance: INTERACT_SEARCH_RADIUS })
    if (!block) {
      return `周围 ${INTERACT_SEARCH_RADIUS} 格内没有找到 ${blockName}，请先靠近它，或用 craft_item 合成后放下来`
    }

    // 走到方块旁边（已经在 4 格内就不折腾；交互距离上限约 5 格）
    if (block.position.distanceTo(bot.entity.position) > 4) {
      try {
        await withTimeout(
          bot.pathfinder.goto(
            new GoalNear(block.position.x, block.position.y, block.position.z, 2)
          ),
          GOTO_TIMEOUT,
          '走向目标方块'
        )
      } catch (err) {
        log('WARN', `[tools] 走向 ${blockName} 失败：${describeError(err)}`)
      }
    }

    // 距离复核：交互的有效距离约 5 格，超出范围服务端会静默忽略，
    // 不检查就会“假装成功”（实测走过一次假成功），这里必须拦住。
    const reachDistance = block.position
      .offset(0.5, 0.5, 0.5)
      .distanceTo(bot.entity.position.offset(0, 1.6, 0))
    if (reachDistance > 5) {
      return (
        `无法交互：${blockName} 在 ${formatPos(block.position)}，我在 ${formatPos(bot.entity.position)}，` +
        `相距约 ${reachDistance.toFixed(1)} 格且走不过去。请先移动到它旁边再试。`
      )
    }

    // 对准方块中心，服务端才会判定命中
    try {
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
    } catch (_) {
      /* 瞄准失败也继续尝试 */
    }

    const held = bot.heldItem ? bot.heldItem.name : '空手'

    // ---- use_on：用手中物品作用于方块 ----
    if (action === 'use_on') {
      await withTimeout(bot.useOn(block), INTERACT_TIMEOUT, 'use_on 交互')
      await sleep(300) // 等方块状态刷新（dirt → farmland、种子 → 作物）
      return `已把手中的 ${held} 用在 ${blockName} ${formatPos(block.position)} 上（use_on）`
    }

    // ---- activate：右键激活方块 ----
    try {
      await withTimeout(bot.activateBlock(block), INTERACT_TIMEOUT, '右键激活方块')
    } catch (err) {
      // 水/岩浆这类流体，activateBlock 常常无效，退化为 useOn（如水桶取水）
      log('WARN', `[tools] activateBlock 失败，尝试 useOn 兜底：${describeError(err)}`)
      await withTimeout(bot.useOn(block), INTERACT_TIMEOUT, 'useOn 兜底')
      await sleep(300)
      return `已对 ${blockName} ${formatPos(block.position)} 使用手中的 ${held}（activate 失败后退化为 use_on）`
    }

    await sleep(400) // 等服务器推送窗口数据

    // ---- 如果打开的是容器（箱子/熔炉/工作台/木桶…），汇报内容并关闭 ----
    const win = bot.currentWindow
    if (win) {
      let items = []
      try {
        items = (win.containerItems?.() || []).filter((i) => i && i.count > 0)
      } catch (err) {
        log('WARN', `[tools] 读取容器内容失败：${describeError(err)}`)
      }

      const summary = items.length
        ? items
            .slice(0, 10)
            .map((i) => `${labelName(i.name)} x${i.count}`)
            .join('、')
        : '空的'

      try {
        await bot.closeWindow(win) // 不关窗会挡住后续所有交互
      } catch (err) {
        log('WARN', `[tools] 关闭容器失败：${describeError(err)}`)
      }

      return `已打开 ${blockName} ${formatPos(block.position)}，里面共有 ${items.length} 格物品：${summary}（已自动关闭界面）`
    }

    return `已右键激活 ${blockName} ${formatPos(block.position)}（没有打开界面，可能是按钮/门/拉杆或作物方块）`
  } catch (err) {
    log('ERROR', `[tools] interact_with_block 异常：${describeError(err)}`)
    return `与 ${blockName || '方块'} 交互失败：${describeError(err)}`
  }
}

// ============================================================================
//  自由移动与环境扫描：move_to / explore / scan_environment
// ----------------------------------------------------------------------------
//  为什么必须有这三个工具：
//    此前所有工具都是“绑定目标”的宏指令（挖 X、打 Y、开 Z）——目标不在视野里就是死路，
//    机器人只能原地重复调用，最后向指挥官报告“我没有移动工具，无法主动探索”。
//    补上“能走 + 能看”之后，探索才真正闭环：
//      scan_environment（看）→ explore / move_to（走）→ scan_environment（再看）
//
//  安全设计（移动类工具最大的风险是“掉进岩浆还不自知”）：
//    1) 移动期间每 400ms 巡检：脚下/身旁有岩浆、火、仙人掌、细雪 → 立刻 pathfinder.stop()；
//    2) 血量比出发时掉了 4 点以上 → 立刻停（被怪打、摔落、溺水都能兜住）；
//    3) 中断原因原样返回，模型才知道“为什么停”，而不是干等超时。
// ============================================================================

/** 会让机器人“站着也掉血”的方块：移动途中一发现就刹车 */
const DANGER_BLOCKS = ['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow']

/**
 * 检测身边是否有危险方块。
 * 用 findBlock 的 point 参数把检测中心放在脚下（默认是眼睛位置 +1.62，
 * 会导致“脚已经踩进岩浆了却查不到”）。
 * @returns {string} 危险描述，安全时返回空字符串
 */
function detectDangerNearby(bot, radius = DANGER_RADIUS) {
  if (!bot.entity) return ''

  const feet = bot.entity.position

  for (const name of DANGER_BLOCKS) {
    const info = bot.registry.blocksByName[name]
    if (!info) continue

    let block = null
    try {
      block = bot.findBlock({ matching: info.id, maxDistance: radius, point: feet })
    } catch (err) {
      log('WARN', `[tools] 危险方块检测失败（忽略）：${describeError(err)}`)
    }
    if (block) return `${radius} 格内有${labelName(name)}（${formatPos(block.position)}）`
  }

  return ''
}

/**
 * 带安全护栏的寻路：走的过程中巡检危险方块与掉血，命中就主动 stop()。
 *
 * 返回一个“永不抛错”的结果对象，让上层能区分三种失败：
 *   · ok            → 走到了
 *   · aborted 非空  → 中途主动中断（岩浆/掉血），原因给模型看
 *   · error 非空    → 真的走不过去（No path / 超时）
 *
 * @param {object} bot
 * @param {object} goal    pathfinder 的 GoalBlock / GoalNear
 * @param {number} timeoutMs
 * @param {string} label   超时文案里显示的标签
 * @returns {Promise<{ok: boolean, aborted: string, error: string}>}
 */
async function gotoWithGuard(bot, goal, timeoutMs, label) {
  if (!bot.entity) return { ok: false, aborted: '', error: '机器人还没有出生（spawn）' }
  if (!bot.pathfinder) return { ok: false, aborted: '', error: '未加载 mineflayer-pathfinder 插件' }

  // 出发前先看一眼脚边：已经贴着岩浆/火就别起步了（巡检间隔 400ms，短距离移动可能来不及拦）
  const dangerBefore = detectDangerNearby(bot)
  if (dangerBefore) {
    return { ok: false, aborted: `出发前检查发现 ${dangerBefore}，为安全起见没有移动`, error: '' }
  }

  const startHealth = typeof bot.health === 'number' ? bot.health : 20
  let aborted = ''

  const watchdog = setInterval(() => {
    if (aborted) return

    // 1) 掉血保护：被怪追、摔落、溺水都会在这里被抓住
    if (typeof bot.health === 'number' && startHealth - bot.health >= HEALTH_DROP_LIMIT) {
      aborted = `移动中血量从 ${startHealth} 掉到 ${Math.round(bot.health)}，可能受到攻击或摔落`
    }

    // 2) 危险方块保护：这一步必须在掉血之前判断，才能“踩进岩浆前”就停下
    if (!aborted) aborted = detectDangerNearby(bot)

    if (!aborted) return

    // 立刻刹车：pathfinder.stop() 会让 goto 的 Promise 以 reject 结束，下面统一归一化
    try {
      bot.pathfinder.stop()
    } catch (err) {
      log('WARN', `[tools] 停止寻路失败：${describeError(err)}`)
    }
    log('WARN', `[tools] 移动中断：${aborted}`)
  }, MOVE_TICK)

  try {
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, label)
    return { ok: !aborted, aborted, error: '' }
  } catch (err) {
    // 主动刹车导致的 reject 不算“走不过去”，别把两种结果混在一起
    return { ok: false, aborted, error: aborted ? '' : describeError(err) }
  } finally {
    clearInterval(watchdog)
  }
}

/** x/y/z 参数校验：统一走这里，避免三处各写一遍 */
function parseCoords(args = {}) {
  const x = Number(args.x)
  const y = Number(args.y)
  const z = Number(args.z)
  return { x, y, z, valid: [x, y, z].every((v) => Number.isFinite(v)) }
}

/**
 * move_to：走到指定绝对坐标。
 *
 * 为什么先 GoalBlock 再退 GoalNear：
 *   精确落点经常被树/实体/水占住，GoalBlock 会一直算不出路；
 *   但“到达 2 格以内”对人类来说就是到了，所以失败一次就降级重试，
 *   并在结果里说明“停在 2 格范围内”，避免模型以为任务失败又重来一遍。
 */
async function moveTo(bot, args = {}) {
  const { x, y, z, valid } = parseCoords(args)

  try {
    if (!valid) {
      return '移动失败：x / y / z 必须是数字，例如 {"x": 100, "y": 65, "z": 100}'
    }
    if (!bot.entity) return '移动失败：机器人还没有出生（spawn）'
    if (!bot.pathfinder) return '移动失败：未加载 mineflayer-pathfinder 插件，无法寻路'

    const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const from = bot.entity.position.clone()
    const distance = from.distanceTo(target)

    if (distance <= 1.5) {
      return `我已经在 ${formatPos(from)}，离目标 ${formatPos(target)} 只有 ${distance.toFixed(1)} 格，不需要移动`
    }
    if (distance > MOVE_SINGLE_MAX) {
      return (
        `移动失败：目标 ${formatPos(target)} 距离 ${distance.toFixed(0)} 格，超过单次上限 ${MOVE_SINGLE_MAX} 格。` +
        '请拆成几段移动，或用 explore 逐步扩大范围。'
      )
    }

    const timeout = Math.min(
      MOVE_MAX_TIMEOUT,
      Math.max(MOVE_DEFAULT_TIMEOUT, Math.round(distance * 1500))
    )
    log(
      'TOOL',
      `[tools] move_to：${formatPos(from)} → ${formatPos(target)}（约 ${distance.toFixed(1)} 格，超时 ${timeout}ms）`
    )

    let result = await gotoWithGuard(
      bot,
      new GoalBlock(target.x, target.y, target.z),
      timeout,
      '移动到目标坐标'
    )
    let nearOnly = false

    // 精确落点走不通 → 退化为“目标 2 格以内”（不放弃整次移动）
    if (!result.ok && !result.aborted) {
      result = await gotoWithGuard(
        bot,
        new GoalNear(target.x, target.y, target.z, 2),
        timeout,
        '移动到目标附近'
      )
      nearOnly = true
    }

    const now = bot.entity.position.clone()
    const remaining = now.distanceTo(target)

    if (result.aborted) {
      return (
        `移动中断：${result.aborted}。我已经停下，当前坐标 ${formatPos(now)}，距目标还有 ${remaining.toFixed(1)} 格。` +
        '建议先 scan_environment 看地形，或改用 explore 换个方向绕行。'
      )
    }

    if (result.ok || remaining <= 2.5) {
      return (
        `移动完成：已到达 ${formatPos(now)}，距目标 ${formatPos(target)} 约 ${remaining.toFixed(1)} 格` +
        (nearOnly ? '（精确落点被占用，停在 2 格范围内）' : '')
      )
    }

    return (
      `移动失败：从 ${formatPos(from)} 到 ${formatPos(target)} 走不过去（${result.error}），` +
      `当前停在 ${formatPos(now)}，还差 ${remaining.toFixed(1)} 格。` +
      '地址可能被水/岩浆/高墙隔断，建议用 scan_environment 侦察后分两段绕行。'
    )
  } catch (err) {
    log('ERROR', `[tools] move_to 异常：${describeError(err)}`)
    return `移动到 (${args.x}, ${args.y}, ${args.z}) 时发生异常：${describeError(err)}。请检查机器人状态后再试。`
  }
}

/** 方向别名表（English + 中文 + 缩写），统一映射到四个基本方向 */
const DIRECTION_ALIAS = {
  north: 'north',
  n: 'north',
  北: 'north',
  北边: 'north',
  北面: 'north',
  south: 'south',
  s: 'south',
  南: 'south',
  南边: 'south',
  南面: 'south',
  east: 'east',
  e: 'east',
  东: 'east',
  东边: 'east',
  东面: 'east',
  west: 'west',
  w: 'west',
  西: 'west',
  西边: 'west',
  西面: 'west'
}

/** 方向 → 位移向量与中文标签（Minecraft 坐标系：北 = -Z，东 = +X） */
const DIRECTION_VECTORS = {
  north: { dx: 0, dz: -1, label: '北' },
  south: { dx: 0, dz: 1, label: '南' },
  east: { dx: 1, dz: 0, label: '东' },
  west: { dx: -1, dz: 0, label: '西' }
}

/** 解析方向：支持中英文、缩写；空值或 random 则随机挑一个 */
function resolveDirection(raw) {
  const key = String(raw || '').trim().toLowerCase()
  const keys = ['north', 'south', 'east', 'west']

  const isRandom = !key || ['random', 'auto', 'any', '随机', '任意', '随便'].includes(key)
  const name = isRandom ? keys[Math.floor(Math.random() * keys.length)] : DIRECTION_ALIAS[key]

  if (!name) return { ok: false, raw, name: '', ...DIRECTION_VECTORS.north }
  return { ok: true, raw, name, random: isRandom, ...DIRECTION_VECTORS[name] }
}

/**
 * explore：朝一个方向走 distance 格（默认 50）。
 *
 * 与 move_to 的分工：
 *   move_to  —— 我明确知道要去哪（回家、指挥官给的坐标）
 *   explore  —— 我不知道目标在哪，只想“出去看看”（找资源、扩大探索范围）
 * 所以这里不要求精确落点，GoalNear(…, 3) 就够，路上碰到障碍时反而更好通过。
 */
async function explore(bot, args = {}) {
  const rawDistance = args.distance === undefined ? EXPLORE_DEFAULT_DISTANCE : Number(args.distance)

  try {
    if (!bot.entity) return '探索失败：机器人还没有出生（spawn）'
    if (!bot.pathfinder) return '探索失败：未加载 mineflayer-pathfinder 插件，无法寻路'
    if (!Number.isFinite(rawDistance) || rawDistance <= 0) {
      return `探索失败：distance 必须是大于 0 的数字（默认 ${EXPLORE_DEFAULT_DISTANCE} 格）`
    }

    const dir = resolveDirection(args.direction)
    if (!dir.ok) {
      return `探索失败：方向 "${dir.raw}" 无法识别，请用 north / south / east / west（或 北/南/东/西）`
    }

    const distance = Math.min(Math.floor(rawDistance), EXPLORE_MAX_DISTANCE)
    const from = bot.entity.position.clone()
    const target = new Vec3(
      Math.floor(from.x + dir.dx * distance),
      Math.floor(from.y),
      Math.floor(from.z + dir.dz * distance)
    )

    // 长距离留足时间：每格按 1.8 秒估算（含绕路/挖穿/垫脚）
    const timeout = Math.min(MOVE_MAX_TIMEOUT, Math.max(MOVE_DEFAULT_TIMEOUT, distance * 1800))
    log(
      'TOOL',
      `[tools] explore：向${dir.label}${dir.random ? '（随机方向）' : ''}走 ${distance} 格，` +
        `目标 ${formatPos(target)}`
    )

    const result = await gotoWithGuard(
      bot,
      new GoalNear(target.x, target.y, target.z, 3),
      timeout,
      '探索移动'
    )

    const now = bot.entity.position.clone()
    const moved = now.distanceTo(from)

    if (result.aborted) {
      return (
        `探索中断：${result.aborted}。我已向${dir.label}走了约 ${moved.toFixed(0)} 格，` +
        `当前坐标 ${formatPos(now)}。建议先 scan_environment 确认安全，再决定绕行方向。`
      )
    }

    if (result.ok) {
      return (
        `已向${dir.label}探索约 ${moved.toFixed(0)} 格，当前坐标 ${formatPos(now)}（目标 ${formatPos(target)}）。` +
        '建议现在用 scan_environment 复查周围有没有资源或危险。'
      )
    }

    // 走了一部分但没到：仍然算“有进展”，别让模型以为完全失败而原地重试
    if (moved >= 10) {
      return (
        `向${dir.label}只走了约 ${moved.toFixed(0)}/${distance} 格就被地形挡住` +
        `（当前 ${formatPos(now)}）：${result.error}。建议换一个方向，或用 move_to 绕行。`
      )
    }

    return (
      `探索失败：向${dir.label}方向从 ${formatPos(from)} 出发走 ${distance} 格不通（${result.error}）。` +
      '这个方向可能被山体/水/岩浆隔断，请换一个方向 explore。'
    )
  } catch (err) {
    log('ERROR', `[tools] explore 异常：${describeError(err)}`)
    return `探索时发生异常：${describeError(err)}。请检查机器人状态后再试。`
  }
}

// ------------------------------ scan_environment ------------------------------
/** “有价值方块”的判定：矿石、原木、箱子/熔炉这类功能性结构 */
const VALUABLE_BLOCK_PATTERN = /(_ore|_log|_wood|ancient_debris|chest|barrel|crafting_table|furnace)$/

/** 扫描时忽略的实体（掉落物/经验球/箭矢会淹没真正的信息） */
const IGNORED_ENTITY_NAMES = new Set(['item', 'experience_orb', 'arrow', 'spectral_arrow', 'area_effect_cloud'])

/**
 * 相对方位（Minecraft：北 = -Z，东 = +X）。
 * 用主轴判断，斜向也归到“更像”的那个方向，输出更好读。
 */
function directionLabel(bot, position) {
  if (!bot.entity) return '附近'
  const dx = position.x - bot.entity.position.x
  const dz = position.z - bot.entity.position.z

  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? '东边' : '西边'
  return dz >= 0 ? '南边' : '北边'
}

/** 按“种类”聚合扫描到的方块：保留数量与最近的那一处 */
function collectValuableBlocks(bot, radius) {
  const ids = []
  for (const block of bot.registry.blocksArray) {
    if (VALUABLE_BLOCK_PATTERN.test(block.name)) ids.push(block.id)
  }
  if (ids.length === 0) return []

  const origin = bot.entity.position
  const groups = new Map()

  // 一次 findBlocks 传 id 数组，比“每种方块各扫一遍”快一个数量级
  const positions = bot.findBlocks({ matching: ids, maxDistance: radius, count: 120 })

  for (const pos of positions) {
    const block = bot.blockAt(pos)
    if (!block) continue

    const distance = pos.distanceTo(origin)
    const prev = groups.get(block.name)

    if (!prev) {
      groups.set(block.name, { name: block.name, position: pos, distance, count: 1 })
      continue
    }

    prev.count += 1
    if (distance < prev.distance) {
      prev.distance = distance
      prev.position = pos
    }
  }

  return [...groups.values()]
}

/** 按“种类”聚合扫描到的实体：保留数量与最近的那一只 */
function collectScanEntities(bot, radius) {
  const origin = bot.entity.position
  const groups = new Map()

  for (const entity of nearbyEntities(bot, radius)) {
    if (!entity.name || IGNORED_ENTITY_NAMES.has(entity.name)) continue

    const distance = entity.position.distanceTo(origin)
    const prev = groups.get(entity.name)

    if (!prev) {
      groups.set(entity.name, {
        name: entity.name,
        position: entity.position,
        distance,
        count: 1,
        type: entity.type,
        kind: entity.kind
      })
      continue
    }

    prev.count += 1
    if (distance < prev.distance) {
      prev.distance = distance
      prev.position = entity.position
    }
  }

  return [...groups.values()]
}

/**
 * scan_environment：把“附近有什么”一次性说清楚。
 *
 * 输出刻意做成“方位 + 距离 + 中文名(英文ID)”的一行式清单：
 *   模型读到就能直接拼出 explore / collect_resource / attack_entity 的参数，
 *   不需要再去理解坐标数组（它经常把 x/z 搞反）。
 */
async function scanEnvironment(bot, args = {}) {
  const rawRadius = args.radius === undefined ? SCAN_DEFAULT_RADIUS : Number(args.radius)

  try {
    if (!bot.entity) return '扫描失败：机器人还没有出生（spawn）'
    if (!Number.isFinite(rawRadius) || rawRadius <= 0) {
      return `扫描失败：radius 必须是大于 0 的数字（默认 ${SCAN_DEFAULT_RADIUS} 格）`
    }

    const radius = Math.min(Math.floor(rawRadius), SCAN_MAX_RADIUS)

    // 刚 spawn / 刚传送时区块还没加载完，不等一下会误报“周围什么都没有”
    await ensureChunksLoaded(bot)

    const blocks = collectValuableBlocks(bot, radius)
    const entities = collectScanEntities(bot, radius)

    const entries = [
      ...entities.map((item) => ({ ...item, kindOf: 'entity' })),
      ...blocks.map((item) => ({ ...item, kindOf: 'block' }))
    ].sort((a, b) => a.distance - b.distance)

    if (entries.length === 0) {
      return (
        `扫描结果：半径 ${radius} 格内没有发现玩家、生物或有价值的方块。` +
        '建议用 explore 向一个方向移动 30~50 格后再扫描。'
      )
    }

    const top = entries.slice(0, SCAN_MAX_ITEMS)
    const parts = top.map((item) => {
      const where =
        item.distance < 1.5 ? '脚下' : `${directionLabel(bot, item.position)} ${Math.round(item.distance)} 格`
      const rolePrefix = item.kindOf === 'entity' && item.type === 'player' ? '玩家' : ''
      const multi = item.count > 1 ? `（共 ${item.count} ${item.kindOf === 'entity' ? '只' : '处'}）` : ''
      return `${where}有${rolePrefix}${labelName(item.name)}${multi}`
    })

    const more = entries.length > top.length ? `；另外还有 ${entries.length - top.length} 类没列出` : ''
    const hostileCount = entities.filter((item) => /hostile/i.test(item.kind || '')).length
    const riskHint = hostileCount > 0 ? '附近有敌对生物，靠近前先确认血量和武器。' : '周围暂时没有敌对生物。'

    const nearest = top[0]
    log(
      'TOOL',
      `[tools] scan_environment：半径 ${radius} 内命中 ${entries.length} 类，最近的是 ${nearest.name}`
    )

    return `扫描结果：${parts.join('；')}${more}。${riskHint}（当前坐标 ${formatPos(bot.entity.position)}）`
  } catch (err) {
    log('ERROR', `[tools] scan_environment 异常：${describeError(err)}`)
    return `扫描环境失败：${describeError(err)}`
  }
}

// ============================================================================
//  生存与侦察：escape_danger / locate_structure
// ----------------------------------------------------------------------------
//  escape_danger  —— 保命优先级最高的动作：出水 → 必要时挖头顶 1 格 → 找岸边
//  locate_structure —— 按“村庄特征方块 + 实体”侦察，替代用 scan_environment 瞎转
// ============================================================================

const ESCAPE_TIMEOUT = 6000 // 单次脱困总预算（毫秒）
const ESCAPE_SWIM_TICK = 200 // 上浮时每次检查的间隔
const ESCAPE_SHORE_RADIUS = 24 // 找岸边的搜索半径
const ESCAPE_DIG_MAX_OXYGEN = 6 // 只有氧气低于等于这个值，才允许挖头顶方块（严格限制）
const ESCAPE_SHORE_PATTERN = /^(sand|gravel|grass_block|dirt|coarse_dirt|stone|clay|cobblestone)$/

const STRUCTURE_SCAN_RADIUS = 64 // 村庄特征方块默认扫描半径
const STRUCTURE_SCAN_MAX_RADIUS = 96 // 上限，防止模型传 500
const STRUCTURE_MAX_RESULTS = 48 // findBlocks 单次最多返回多少个坐标
/** 村庄/营地特征方块：床有 16 种颜色、箱子还有 trapped_chest，必须用模式匹配而不是枚举常量 */
const STRUCTURE_BLOCK_PATTERN =
  /(_bed$|^chest$|^trapped_chest$|^bell$|^crafting_table$|^furnace$|^barrel$|^bookshelf$|^composter$|^fletching_table$|^cartography_table$|^smithing_table$|^stonecutter$|^grindstone$|^lectern$|^loom$|^anvil$|^chipped_anvil$|^damaged_anvil$)/
/** 村庄居民类实体 */
const STRUCTURE_ENTITY_PATTERN = /^(villager|wandering_trader|iron_golem|cat)$/

/**
 * escape_danger —— 从水里/危险地形里爬出来。
 *
 * 三段式策略（顺序不可颠倒，先便宜后昂贵）：
 *   1) 游泳上浮：水上世界绝大多数情况足够，且不破坏地形；
 *   2) 挖头顶 1 格：**只在还在水里且氧气 <= 6 时**才允许，严格 1 格，防止它拿这个工具乱挖；
 *   3) 找最近岸边（沙/砾石/草方块/土/石）寻路过去。
 *
 * 返回：人类可读的处理过程 + 处理后的生存状态（模型据此决定要不要再逃一次）。
 */
async function escapeDanger(bot) {
  if (!bot || !bot.entity) return '机器人还没有出生（spawn），无法执行逃生。'

  const before = readSurvivalState(bot)
  const steps = []

  // ① 游泳上浮
  if (before.inWater) {
    bot.setControlState('jump', true)
    const deadline = Date.now() + ESCAPE_TIMEOUT
    try {
      while (Date.now() < deadline) {
        await sleep(ESCAPE_SWIM_TICK)
        if (!bot.entity.isInWater) break
      }
    } finally {
      bot.setControlState('jump', false)
    }
    steps.push(bot.entity.isInWater ? '上浮没能出水（可能头顶被方块封住）' : '已游出水面')
  }

  // ② 仍在水下且氧气告急 → 允许挖开头顶 1 格（严格限制）
  const oxygen = before.oxygen === null ? 20 : before.oxygen
  if (bot.entity.isInWater && oxygen <= ESCAPE_DIG_MAX_OXYGEN) {
    const above = bot.blockAt(bot.entity.position.offset(0, 1, 0))
    if (above && above.boundingBox === 'block' && bot.canDigBlock(above)) {
      try {
        await withTimeout(bot.dig(above), DIG_TIMEOUT, '挖开头顶方块')
        steps.push(`氧气告急，挖开了头顶的 ${labelName(above.name)}`)
      } catch (err) {
        steps.push(`头顶方块没能挖开：${describeError(err)}`)
      }
    } else {
      steps.push('头顶不是可挖的方块，放弃挖洞')
    }
  }

  // ③ 找最近岸边上岸
  if (bot.entity.isInWater) {
    try {
      const registry = bot.registry || getGameData(bot)
      const shoreIds = []
      for (const block of registry.blocksArray || []) {
        if (ESCAPE_SHORE_PATTERN.test(block.name)) shoreIds.push(block.id)
      }

      const positions = bot.findBlocks({
        matching: shoreIds,
        maxDistance: ESCAPE_SHORE_RADIUS,
        count: 8
      })

      // 取最近的、且本身不在水下的岸边方块
      const target = positions
        .filter((pos) => {
          const block = bot.blockAt(pos)
          return block && block.name !== 'water'
        })
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]

      if (target) {
        const result = await gotoWithGuard(
          bot,
          new GoalNear(target.x, target.y, target.z, 1),
          ESCAPE_TIMEOUT,
          '上岸'
        )
        steps.push(
          result.ok
            ? `已朝 ${directionLabel(bot, target)} 的岸边移动`
            : `上岸移动失败：${result.aborted || result.error}`
        )
      } else {
        steps.push(`半径 ${ESCAPE_SHORE_RADIUS} 格内没找到岸边方块`)
      }
    } catch (err) {
      steps.push(`找岸边时出错：${describeError(err)}`)
    }
  }

  const after = readSurvivalState(bot)
  const head = before.inWater ? '【逃生】原本在水里' : '【逃生】当前不在水里'
  const body = steps.length > 0 ? steps.join('；') : '无需处理'
  const tail = after.critical
    ? `仍然危急（${after.reason}），请立刻再调用一次 escape_danger 或向岸边前进。`
    : '已脱离危险。'

  return `${head}。${body}。\n当前：${formatSurvivalLine(after)}\n${tail}`
}

/**
 * locate_structure —— 找村庄/营地这类“没有单一方块 ID”的结构。
 *
 * 原理：村庄没有“village”这个方块，只能靠**特征集合**判定：
 *   床（16 色）、箱子、钟、工作台、熔炉、书架、制箭台… + 村民/铁傀儡/猫。
 * 输出按“种类聚合 + 最近一处 + 方位”，并给出置信度结论，方便模型决定往哪走。
 * 只读：绝不移动、不挖掘。
 */
function locateStructure(bot, args = {}) {
  if (!bot || !bot.entity) return '机器人还没有出生（spawn），无法侦察。'

  const requested = Number(args.radius)
  const radius = Math.min(
    Math.max(Number.isFinite(requested) && requested > 0 ? requested : STRUCTURE_SCAN_RADIUS, 16),
    STRUCTURE_SCAN_MAX_RADIUS
  )

  const registry = bot.registry || getGameData(bot)
  const structureIds = []
  for (const block of registry.blocksArray || []) {
    if (STRUCTURE_BLOCK_PATTERN.test(block.name)) structureIds.push(block.id)
  }

  let positions = []
  try {
    positions = bot.findBlocks({ matching: structureIds, maxDistance: radius, count: STRUCTURE_MAX_RESULTS })
  } catch (err) {
    return `侦察失败：${describeError(err)}`
  }

  // 按方块名聚合：数量 + 最近的一处（方位/距离）
  const byName = new Map()
  for (const pos of positions) {
    const block = bot.blockAt(pos)
    if (!block) continue
    const distance = Math.round(pos.distanceTo(bot.entity.position))
    const entry = byName.get(block.name) || { count: 0, nearest: distance, at: pos }
    entry.count += 1
    if (distance < entry.nearest) {
      entry.nearest = distance
      entry.at = pos
    }
    byName.set(block.name, entry)
  }

  // 实体侧：村民/铁傀儡/猫（很多村庄的床在房子里，实体反而更好认）
  const entities = Object.values(bot.entities || {}).filter(
    (entity) => entity && entity !== bot.entity && STRUCTURE_ENTITY_PATTERN.test(entity.name || '')
  )
  const entityByType = new Map()
  for (const entity of entities) {
    const distance = Math.round(entity.position.distanceTo(bot.entity.position))
    const entry = entityByType.get(entity.name) || { count: 0, nearest: distance, at: entity.position }
    entry.count += 1
    if (distance < entry.nearest) {
      entry.nearest = distance
      entry.at = entity.position
    }
    entityByType.set(entity.name, entry)
  }

  const lines = []
  let blockHits = 0
  for (const [name, entry] of byName) {
    blockHits += entry.count
    lines.push(`- ${labelName(name)} ×${entry.count}，最近 ${entry.nearest} 格（${directionLabel(bot, entry.at)}）`)
  }
  let entityHits = 0
  for (const [name, entry] of entityByType) {
    entityHits += entry.count
    lines.push(`- ${labelName(name)} ×${entry.count}，最近 ${entry.nearest} 格（${directionLabel(bot, entry.at)}）`)
  }

  if (lines.length === 0) {
    return (
      `【结构侦察】半径 ${radius} 格内没有发现床/箱子/钟/村民等村庄特征。\n` +
      '可能原因：附近确实没有村庄，或者区块还没加载出来。\n' +
      '建议：换一个方向 explore 走一段（约 50 格）后再侦察一次，不要原地反复扫。'
    )
  }

  let verdict = '疑似有人活动（零散结构，可能是前哨/矿洞营地）'
  if (byName.has('bell') || entityByType.has('villager') || entityByType.has('iron_golem')) {
    verdict = '高度疑似村庄'
  } else if (blockHits >= 3) {
    verdict = '可能是村庄的一部分（房屋/仓库）'
  }

  return (
    `【结构侦察】半径 ${radius} 格内命中 ${blockHits} 个特征方块、${entityHits} 个实体：\n` +
    `${lines.join('\n')}\n` +
    `结论：${verdict}。建议朝最近的那一处移动（可用 move_to 或 explore）。`
  )
}

// ------------------------------ 统一执行入口 ------------------------------
/**
 * 工具分发（内部函数）：只负责把 toolName 路由到具体实现，返回值可能是任何类型。
 * 汉化统一放在外层的 executeTool 里做，这样每个工具都不用各自记得去翻译。
 */
async function dispatchTool(bot, toolName, safeArgs) {
  switch (toolName) {
    // ---- 资源与制造 ----
    case 'collect_resource':
      return await collectResource(bot, safeArgs)

    case 'craft_item':
      return await craftItem(bot, safeArgs)

    // ---- 战斗与感知 ----
    case 'attack_entity':
      return await attackEntity(bot, safeArgs)

    case 'find_entities':
      return await findEntities(bot, safeArgs)

    // ---- 交互与装备 ----
    case 'interact_with_block':
      return await interactWithBlock(bot, safeArgs)

    case 'equip_item':
      return await equipItemTool(bot, safeArgs)

    // ---- 背包管理 ----
    case 'drop_item':
      return await dropItem(bot, safeArgs)

    // ---- 移动与探索 ----
    case 'move_to':
      return await moveTo(bot, safeArgs)

    case 'explore':
      return await explore(bot, safeArgs)

    case 'scan_environment':
      return await scanEnvironment(bot, safeArgs)

    // ---- 状态 ----
    case 'get_status':
      return getStatus(bot)

    // ---- 游戏知识（返回严格 Markdown，禁止二次汉化） ----
    case 'query_game_knowledge':
      return queryGameKnowledge(bot, safeArgs)

    // ---- 生存与侦察 ----
    case 'escape_danger':
      return escapeDanger(bot)

    case 'locate_structure':
      return locateStructure(bot, safeArgs)

    default:
      return (
        `未知工具 "${toolName}"。可用工具：collect_resource、craft_item、` +
        `attack_entity、find_entities、interact_with_block、equip_item、drop_item、` +
        `move_to、explore、scan_environment、get_status、query_game_knowledge、escape_danger、locate_structure`
      )
  }
}

/**
 * 执行大模型请求的工具（对外唯一入口）。
 *
 * 关键点：所有工具的返回值都会经过 localizeText 汉化，
 * 于是整个项目只有这一处需要维护“英文 ID → 中文”的落地逻辑，
 * 新增工具时自动继承汉化能力（DRY）。
 *
 * @param {object} bot       mineflayer 实例
 * @param {string} toolName  工具名
 * @param {object} args      已完成 JSON.parse 的参数对象（block_name 等仍是英文 ID）
 * @returns {Promise<string>} 一定返回字符串，供 role=tool 的 message 使用
 */
async function executeTool(bot, toolName, args = {}) {
  const safeArgs = args && typeof args === 'object' ? args : {}

  try {
    const raw = await dispatchTool(bot, toolName, safeArgs)

    // 例外：query_game_knowledge 返回严格 Markdown 表格，格子里的英文 ID 必须原样
    // 交给前端拼贴图 URL，一旦被 localizeText 包成“圆石(cobblestone)”就解析不了了。
    if (raw && typeof raw === 'object' && raw.__raw === true) return String(raw.text ?? '')

    // raw 全部是字符串；仍然兜一层 String() 防止某个工具忘了 return
    return localizeText(String(raw ?? ''))
  } catch (err) {
    // 双重兜底：各工具内部已 try/catch，这里防止遗漏分支的意外
    return localizeText(`工具 ${toolName} 执行出错：${describeError(err)}`)
  }
}

module.exports = {
  toolDefinitions,
  executeTool,
  setupMovements, // bot/connection.js 复用
  // 汉化能力（前端/CLI 若想自行格式化可以复用）
  itemNameMap,
  entityNameMap,
  labelName,
  localizeText,
  // 便于单独测试 / 二次封装
  collectResource,
  craftItem,
  attackEntity,
  findEntities,
  interactWithBlock,
  equipItemTool,
  dropItem,
  moveTo,
  explore,
  scanEnvironment,
  escapeDanger, // 逃生（单测/诊断可直接调）
  locateStructure,
  detectDangerNearby,
  countInInventory,
  checkDigCapability,
  matchesEntity,
  findNearestEntity
}
