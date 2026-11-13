# MC-Agent · Minecraft 自主生存智能体

![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
![LLM](https://img.shields.io/badge/LLM-DeepSeek-4D6BFE)
![Minecraft](https://img.shields.io/badge/Minecraft-1.12.2%20~%201.20.x-62B47A?logo=minecraft&logoColor=white)
![Mineflayer](https://img.shields.io/badge/Mineflayer-4.x-00A98F)
![Transport](https://img.shields.io/badge/Transport-SSE-orange)
![Viewer](https://img.shields.io/badge/Viewer-prismarine--viewer-purple)
![Framework](https://img.shields.io/badge/Agent%20Framework-None-black)

```text
  __  __  ___          _                    _
 |  \/  || __|   __ _  __ _  ___ _ _   | |_
 | |\/| || _|   / _` |/ _` |/ -_) ' \  |  _|
 |_|  |_||___|  \__,_|\__, |\___|_||_|  \__|
                      |___/
      Minecraft Autonomous Agent / ReAct in the wild
```

> 一个**有生存本能、会画合成表、随时可被打断、且永远不会因为一个 Promise 挂死**的 Minecraft AI Agent。
> 你说“帮我搞把铁镐”，它自己拆任务、挖矿、合成；水下缺氧会先上浮；你点停止，它立刻收手。

**本轮重构关键词**：异步零死锁 · 生存反射弧 · 多版本兼容

通用大模型只有“嘴”，传统脚本只有“手”。MC-Agent 把两者接起来：你扮演**指挥官**，只下达宏观意图；它扮演**执行者**，用 `思考 → 行动 → 观察` 的循环把一句人话翻译成一连串真实发生在方块世界里的动作——并且每一步都摊在屏幕上给你看。

---

## 🎯 为什么是它

Minecraft 机器人真正的难点不在“会不会挖矿”，而在三个容易被忽略的角落：**异步会不会挂死**、**危险来了它知不知道**、**换了服务器版本还认不认得东西**。

| 能力 | 通用大模型 | 传统脚本机器人 | MC-Agent |
| --- | --- | --- | --- |
| 听得懂“搞把铁镐”并自己拆成 10 步 | ✅ | ❌ 只能按固定脚本走 | ✅ ReAct 循环自主拆解 |
| 缺氧时先上浮、着火时先跑 | ❌ 根本不知道自己在挨打 | ❌ 脚本没写就等死 | ✅ 500ms 痛觉巡检 + `escape_danger` |
| 寻路超时后不乱动手 | — | ⚠️ 常见“一边走一边挖” | ✅ **超时即刹车**（批次 P0） |
| 点“停止”就真的停 | ❌ | ⚠️ 要等当前动作跑完 | ✅ abort + 掐断底层动作 |
| 逃生时不会被自己的巡检误杀 | — | — | ✅ **`isEscaping` 豁免**（批次 P1） |
| 断线重连期间下的指令不卡死 | — | ⚠️ 常见固定卡 60 秒 | ✅ 实例轮询对齐（批次 P2） |
| 换 1.12.2 / 1.16.5 / 1.20.4 都认路 | ❌ 训练数据混杂，易张冠李戴 | ❌ ID 写死 | ✅ 全部绑定 `bot.version` |

---

## ✨ 核心特性

### 1. 异步不死锁：三个批次把“底层挂起”焊死

这是本项目最硬的一层。Web Agent 的死法几乎都不是“报错”，而是**某个 Promise 永不 resolve，整个循环静止，日志却看起来一切正常**。重构按批次逐一封堵：

---

#### 批次 P0 · 超时即刹车：`withTimeout` 的致命盲区

`withTimeout()` 只能让**调用方**停止等待，它**取消不了**底层任务。于是出现过一个非常隐蔽的 bug 链条：

```text
goto 超时 30s → 上层 catch 后继续执行 → bot.dig() 开始
              ↓（pathfinder 其实还在后台跑）
寻路与挖掘抢控制权 → 挖到一半被拖走 → 方块碎了但掉落物在别处
```

修复只加了一个函数，但它是整个项目异步纪律的锚点：

```js
// src/agent/tools.js
async function gotoOrThrow(bot, goal, timeoutMs, label) {
  try {
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, label)
  } catch (err) {
    stopPathfinder(bot, label)   // ← 关键：先刹车
    throw err                    // ← 再把错误交给上层
  }
}
```

- **8 处**寻路全部改走它：`smartPickup` / `digOneBlock` / `placeCraftingTable` / `ensureCraftingTableInReach` / `attackEntity` / `smeltItem` / `interactWithBlock` / `gotoWithGuard`（含其超时分支）。
- **6 处** `bot.equip` 全部包 `EQUIP_TIMEOUT`（装备工具 / 工作台 / 熔炉 / 食物 / 武器 / 通用换装）。
- 顺带统一了 `dispatchTool` 的 18 个分支为 `return await`——即使将来有人把它改成同步函数，也不会把未 resolve 的 Promise 漏给 `localizeText`。

> 为什么 `equip` 也必须有超时：`try/catch` 只能接住**抛出来的异常**，接不住**永不 resolve**。`bot.equip` 依赖服务端窗口刷新，网络抖动或界面卡住时会一直挂着，而调用方正在 `await` 它。

#### 批次 P1 · 逃生铁律：巡检只许打断大脑，不许打断身体

危急巡检是 500ms 定时器驱动的，它握有直接改写机器人状态的能力。而 `escape_danger` 第 ① 步靠 `setControlState('jump')` **持续按住跳跃键**上浮——一旦被巡检的 `clearControlStates()` 清掉，机器人就停在水里干等，循环空转到 6 秒超时才放弃。

**实测表现：越危险越动不了。**

解法是一个旗标 + 一处短路，没有任何重构：

```js
// src/agent/tools.js —— 逃生期间置位，finally 一定复位
async function escapeDanger(bot) {
  bot.isEscaping = true
  try { return await runEscapeSteps(bot) }
  finally { bot.isEscaping = false }
}

// src/bot/connection.js —— 命中旗标就只让上层 abort，不碰底层动作
function interruptBotActions() {
  if (bot.isEscaping === true) {
    log('WARN', '[CRITICAL] 机器人正在执行逃生动作，跳过强制停手（只中断模型循环）')
    return
  }
  // pathfinder.stop() / stopDigging() / clearControlStates()
}
```

短路点选在 `interruptBotActions()` 而不是 `onCritical()`，吃的是 `abortActiveRun()` 的时序红利：它**先** `controller.abort()` **后**掐动作，所以这里提前返回天然满足“只中断大模型循环”。用户点停止走的也是同一条路，一并覆盖。

#### 批次 P2 · 断线重连：别把监听器绑在一个已经被换掉的实例上

`scheduleReconnect()` 会 `createBot()` **把实例整个换掉**。旧实现是 `getBot().once('spawn', ...)`——拿的是快照，那个实例永远不会再 spawn，于是新连接明明已经进来了，调用方还要干等 60 秒。

现在改成**双重判定 + 实例对齐**：

```js
// src/bot/connection.js
attachCurrent()                       // 先同步挂一次
poll = setInterval(() => {            // 每 200ms 对齐“当前实例是谁”
  if (isReady()) { settle(true, bot); return }
  attachCurrent()                     // 实例换了 → 监听器跟着搬
}, SPAWN_POLL_MS)
timer = setTimeout(() => settle(false, ...), timeout)   // 超时窗口不因重连重置
```

- `once('spawn')` 抓事件，`isReady()` 轮询兜底 → 就算在“检查未就绪”与“挂上监听”之间刚好 spawn，最多晚 200ms 也能 resolve。
- `detach()` 只解绑自己挂的那一个监听，不动其它模块。
- `manualQuit` 保护：服务关闭时不去顺手拉起僵尸连接。

#### 全链路超时矩阵

| 动作 | 超时 | 超时后的行为 |
| --- | ---: | --- |
| 寻路靠近方块 / 工作台 / 熔炉 / 目标方块 | 30 s | 刹车 + 记录 WARN，或换候选 |
| 走向掉落物 | 10 s | 刹车 + 判定“没捡到”，继续采集 |
| 单次挖掘 `bot.dig` | 20 s | 换下一个候选方块 |
| 等待区块加载 | 8 s | 降级继续搜索 |
| 合成 `bot.craft` | 20 s | 中断并如实汇报“只合成了 N 个” |
| 换装 `bot.equip` | 8 s | 降级继续（空手也能打） |
| 进食 `bot.consume` | 12 s | 中断并核对背包差值 |
| 丢弃 `toss / tossStack` | 5 s | 用背包差值判断是否真的丢掉了 |
| 右键 / `useOn` 交互 | 10 s | 退化为另一条协议通道 |
| 打开熔炉 | 10 s | 如实汇报无法打开 |
| 移动（`move_to` / `explore` / 地标） | 60 ~ 180 s | 带安全巡检中断，返回“走了多远” |
| 逃生总预算 | 6 s | 汇报“上浮未出水”并给出下一步建议 |
| 大模型请求 | 120 s | 自动重试 2 次后中断本步 |
| Wiki 检索 | 8 s | 降级为“经验判断”回答 |

### 2. 生存反射弧：痛觉神经 + 脊髓反射

长任务里最致命的问题不是模型不够聪明，而是**它根本不知道自己正在挨打**：一次 `collect_resource` 要挖十几秒，一次 `goto` 能走 30 秒，而 ReAct 循环只在两次模型请求之间读一次状态——溺水、着火、被砍都发生在这段“聋”的间隙里。

所以感知下沉到连接层，做成两层反射：

- **痛觉神经（`bot/connection.js`）**：`bot.on('health')` + 每 500ms 巡检 `isInWater` / `onFire`，命中「血量 < 10 / 水下氧气 ≤ 6 / 着火」立刻广播 `critical`；采用**上升沿**判定（同一段危险只报一次），避免溺水 10 秒推 20 条警告。
- **脊髓反射（`server.js`）**：收到事件立刻 `pathfinder.stop()` + `stopDigging()` + `clearControlStates()`，并用 `abort('【紧急中断】…')` 打断当前循环，同时往正在看的 SSE 推一条 `warn`。
- **自动保命回合**：若中断后危险仍未解除，在同一条 SSE 里补一轮 3 步以内的救援，逼模型真的调用 `escape_danger`，而不是留一句“任务已中断”就结束。
- **状态面板**：每条 `role: tool` 结果末尾强制附着

```text
[当前状态: 血量 18/20 | 氧气 -- | 饥饿 15/20 | 手持 铁镐(iron_pickaxe)]
```

  模型每次思考前都先看血条；每步开头只**就地刷新**这一行（先按标记剥掉旧行再贴），不新增消息、不涨 token 条数。

> 中断来源靠原因文本区分：`abort()` 不带参数 = 用户取消（回“已停下”），
> `abort('【紧急中断】…')` = 痛觉中断（回“已转入保命模式”并触发救援回合）。

### 3. 零框架 ReAct 内核

不引入 LangChain 之类的重型抽象。循环调度、上下文裁剪、工具分发、流式分帧全部自己写，调用栈、token 消耗、单步延迟都可直接归因，运行时依赖只有 1 个 `openai` SDK 与游戏侧库。

- `messages` 严格按 `[system] → [user] → [assistant(tool_calls)] → [tool] → …` 累积，每个 `tool_call` 必有一条 `role: tool` 配对，**从源头规避协议层 400**
- 工具往返**只在本轮内合法**，跨轮只回放纯文本历史——否则 `tool_call_id` 对不上，接口直接报错
- 步数上限（`MAX_STEPS`，默认 15）只兜底，真正的防死循环靠**同参数连续调用护栏**：第 2 次跳过并警告，第 3 次强制终止
- 可观测性内建：每步 `thought / action / observe` 带 `step` 序号推给前端，决策链可回放、可计时

### 4. 多版本动态兼容：一套代码挂 1.12.2 / 1.16.5 / 1.20.4

版本差异不是“多几个方块”，而是**命名和掉落模型都变了**：1.12.2 的原木叫 `log` 不叫 `oak_log`；1.12 没有 `raw_iron`（铁矿石直接烧铁锭）；1.16.5 没有 `raw_gold`。任何一处写死 ID 或写死原料，换版本就会静默出错。

- **唯一数据源**：`require('minecraft-data')(bot.version)`，按版本缓存；代码里没有任何数字 ID，全部走 `itemsByName` / `blocksByName` / `recipes`
- **硬编码表只当“候选”**：熔炼表存的是**数组**（`iron_ingot: ['raw_iron', 'iron_ore']`），用之前先按当前版本过滤，不存在的原料直接跳过
- **`minecraft-data` 对未知版本返回 `null` 而不是抛错**——不判空会直接打挂 Agent，这里显式兜底并提示用 `MC_VERSION` 指一个相近版本
- **查不到就说清楚**：所有“未找到”提示都带真实版本号
- **spawn 自检**：五组探针（含 `log` 别名）验证数据可用性，失败打 `WARN` 并通过 `/api/health` 的 `gameData` 在面板顶部亮红条
- **提示词带版本意识**：system prompt 写明 `你当前连接的游戏版本是 Minecraft x.y.z`，查不到时要求向玩家确认是不是模组服

### 5. 知识三层 + 空间记忆

不引入向量库、不抓正文、不建索引：

**① 本地数据（0 幻觉，不联网）** —— `query_game_knowledge`

- `item` → 堆叠上限 + 最大耐久；`recipe` → `产出：<ID> xN` + 3×3 表格
- `entity` → 分类 / 血量 / 体型 / 掉落表；`loot` → 方块掉落，**自动区分普通挖掘与精准采集**
- **同形状配方自动聚合**：按“哪几格有料”算形状指纹，12 种木板做的工作台只画一张表
- **冷门材料后压**：深板岩 / 黑石 / 樱花木参与排序，“圆石在前、深板岩在后”
- 中英双写：正文永远是 `圆石(cobblestone)`，工具参数永远是纯英文 ID

**② Wiki 实时检索（唯一联网点）** —— `query_type=wiki`

- 只调 MediaWiki `list=search`，取前 3 条摘要、去 HTML、压到 500 字以内，不抓正文、不切片
- 8 秒 `AbortController` 超时 + 10 分钟内存缓存；失败返回一句人话，要求模型标注“这是经验判断”

**③ 空间记忆（跨会话不迷路）** —— `save_waypoint` / `go_to_waypoint`

- 地标存进项目根目录 `waypoints.json`（键值查找，不语义检索），重启、刷新都还在
- 原子写（临时文件 + rename）、上限 50 个（超出淘汰最久未用）、文件已 gitignore
- 跨维度明确拒绝，而不是让模型以为“走不过去”

### 6. 协议容错四层

模型偶尔会把工具调用**写进正文**（内部方言 `<| |invoke>`、Markdown JSON，甚至竖线被空格拆开）：

1. **词法层**：`(?:[|｜]\s*){0,3}` 同时容忍半角/全角竖线与任意空白，`< | | calls>` 这类变体也逃不掉
2. **清洗层**：成对块 → 截断块 → 残余标签 → 包裹 token → 零宽字符，按固定顺序删，标签体不会残留成乱码
3. **抢救层（双通道）**：XML 通道按开标签切分（容忍 `max_tokens` 截断）；JSON 通道只认“有工具名 + 有参数载荷 + 白名单命中”
4. **校验层**：抢救出的参数必须过工具自带的 **JSON Schema**，任一不合规整段丢弃

> 抢救失败 → 注入一次格式纠错并重试；连续 `MAX_RECOVERY`（默认 2）次仍失败 → **熔断**。最终出口还有二次校验：带脏标签的“总结”直接替换成安全话术。

### 7. 可视化与工程化

前端用原生 `EventSource` 接 9 类事件，把 AI 的内心戏直接摊在屏幕上：

| 事件 | 含义 | UI 表现 |
| --- | --- | --- |
| `start` / `step` | 任务开始 / 第 N 步思考 | 分隔线 |
| `thought` | 🧠 模型在想什么 | 蓝色卡片 |
| `action` | 🤖 调了哪个工具、参数是什么 | 黄色等宽卡片 |
| `observe` | 👀 工具真实返回（末尾带状态面板） | 绿色等宽卡片 |
| `warn` / `error` | 护栏告警 / 异常 | 橙色 / 红色 |
| `death` | 💀 机器人死亡，上下文已重置 | 红色高亮 |
| `done` | ✅ 最终答复 | 绿色卡片 |

- **消息走渲染队列 + 打字机**（12ms/字），SSE 乱序到达时顺序依然稳定
- **3×3 合成表就地渲染**：识别 Markdown 表格 → 生成 `3×3 输入 → 产物`，贴图三级降级（`item/*` → `block/*` → 英文 ID），全程 `textContent` 重建、不用 `innerHTML`
- **AI 视角 + HUD**：第一人称画面跑在独立端口（默认 3001），起不来只 WARN，Agent 照跑；HUD 每 2 秒轮询血量 / 饥饿 / 护甲 / 坐标 / 9 格快捷栏
- **SSE 通道统一封装**：`createSSEChannel()` 一次搞定响应头、15s 心跳、断开检测、关闭

---

## 🏗️ 架构设计

```text
┌──────────────────────────┐         ┌────────────────────────────────────────┐
│  public/index.html       │         │  src/server.js            (570 行)      │
│  · EventSource 收流      │◀──SSE───│  · createSSEChannel 心跳/断开/关闭      │
│  · 打字机 + 渲染队列     │         │  · AbortController + 抢占式调度         │
│  · 3×3 合成表 / HUD      │──POST──▶│  · ACCESS_TOKEN 鉴权（timingSafeEqual）│
│  · 🎥 AI 视角 iframe     │         │  · chatHistory 20 条 + JSONL 落盘       │
└──────────────────────────┘         └───────────────────┬────────────────────┘
                                                         │ emit(type, data)
                                                         ▼
                                    ┌──────────────────────────────────────┐
                                    │  agent/loop.js          (566 行)     │
                                    │  · 步数上限 / 同参重复护栏            │
                                    │  · 生存巡检 / 死亡上下文重置边界      │
                                    │  · 状态面板（就地刷新，不增消息）      │
                                    │   ┌──────────────────┬─────────────┐ │
                                    │   │protocol.js(289)  │history.js   │ │
                                    │   │伪调用抢救+Schema │ (68) 历史清洗│ │
                                    │   └──────────────────┴─────────────┘ │
                                    └───────┬────────────────┬─────────────┘
                                executeTool │                │ systemPrompt
                                            ▼                ▼
                            ┌───────────────────────┐  ┌──────────────────┐
                            │ agent/tools.js(3208)  │  │ personas.js(269) │
                            │ 18 个宏指令 + Schema  │  │ CORE + 3 套人格  │
                            │ gotoOrThrow 超时刹车  │  └──────────────────┘
                            │ isEscaping 逃生豁免   │
                            └───┬────────────┬──────┘
              query_game_       │            │ bot 实例
              knowledge         ▼            ▼
                    ┌──────────────────┐  ┌─────────────────────────────────┐
                    │ knowledge.js     │  │ bot/connection.js     (371 行)  │
                    │ (1016)           │  │ mineflayer + pathfinder         │
                    │ minecraft-data   │  │ 断线重连 / waitForSpawn 实例对齐 │
                    │ + Wiki + 渲染    │  │ 痛觉巡检 / 死亡广播 / 中断豁免   │
                    └──────────────────┘  └──────┬───────────────┬──────────┘
                                                 ▼               ▼
                                       ┌──────────────┐  ┌──────────────────┐
                                       │ bot/hud.js   │  │ bot/viewer.js    │
                                       │ (105) 快照   │  │ (389) :3001 画面 │
                                       └──────────────┘  └──────────────────┘

  横切关注点（不属于任何单个盒子）：
    · utils.js(142)  —— withTimeout / 日志 / DSML 词法，被所有层依赖
    · survival.js(133) —— 生存判定纯函数，loop 与 tools 共用，避免 require 成环
    · waypoints.js(147) —— 空间记忆落盘，只被 tools 调用
```

**一次任务的完整闭环**：指挥官一句话 → SSE 长连接 → 循环把提示词 + 历史 + 18 个工具丢给 DeepSeek → 模型回 `tool_calls` → 工具层在游戏里真的挖了一镐（**并且这一步的任何超时都会先刹车再报告**）→ 结果以 `role: tool` 回灌（末尾带状态面板）→ 下一步思考 → 直到不再调工具，返回人话。

### 模块职责表

| 文件 | 行数 | 只负责 | 明确不负责 |
| --- | ---: | --- | --- |
| `src/server.js` | 570 | 静态托管、SSE 通道、路由、抢占调度、鉴权、记忆落盘、危急反射 | 不知道“挖矿”是什么 |
| `src/brain.js` | 55 | CLI 薄壳：同一套 `runAgent`，只换输出通道 | 不含循环逻辑 |
| `src/agent/loop.js` | 566 | 组织上下文、调模型、分发工具、护栏、状态面板、版本提示 | 不知道“怎么挖” |
| `src/agent/tools.js` | 3208 | 18 个宏指令实现、入参 Schema、寻路超时刹车、逃生旗标 | 不知道“为什么要挖” |
| `src/agent/knowledge.js` | 1016 | `minecraft-data` 查询、Wiki 检索、版本自检、Markdown 渲染 | 不执行游戏动作、不落盘 |
| `src/agent/protocol.js` | 289 | arguments 解析、伪调用抢救、Schema 校验 | 不执行任何动作 |
| `src/agent/personas.js` | 269 | CORE 能力内核 + 3 套人格 + 版本意识 | 不含工具实现 |
| `src/agent/waypoints.js` | 147 | 地标读写（`waypoints.json`，原子写） | 不含寻路逻辑 |
| `src/agent/utils.js` | 142 | 日志、`withTimeout`、DSML 词法与清洗 | 不依赖任何业务模块 |
| `src/agent/survival.js` | 133 | 生存判定、告警文案、极简状态面板 | 不依赖任何业务模块 |
| `src/agent/history.js` | 68 | 历史清洗、状态行就地刷新 | 不做 IO |
| `src/bot/connection.js` | 371 | 连接生命周期、重连、`waitForSpawn`、死亡/危急广播、中断豁免 | 不含推理逻辑 |
| `src/bot/viewer.js` | 389 | 第一人称画面生命周期（独立端口 + 热切换） | 失败绝不影响 Agent |
| `src/bot/hud.js` | 105 | 血量/护甲/快捷栏快照 | 无副作用 |
| `public/index.html` | 1508 | 渲染、交互、轮询、令牌输入、数据告警 | 不含业务规则 |

**依赖方向单行道**：`server → loop → tools / knowledge / protocol → utils`，`bot/*` 只被上层单向依赖。

两条不能破的边界：

1. **`survival.js` 必须是纯函数、零业务依赖**——`loop.js` 要注入生存状态，`tools.js` 的 `escape_danger` 也要同一套判定，而 `tools.js` 已被 `loop.js` require，两边互相 require 会成环。
2. **`bot/*` 不许反向 require `agent/*`**（除了复用 `setupMovements` 这种纯配置函数），否则连接层与推理层会互相拖死。

---

## 🚀 快速开始

### 环境准备

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 18** | 需要原生 `fetch` 与 ESM interop |
| Minecraft Server | 1.12.2 ~ 1.20.x | **离线模式**（`online-mode=false`），否则 Mineflayer 连不上 |
| DeepSeek API Key | — | 到 [platform.deepseek.com](https://platform.deepseek.com/) 申请 |

### 安装

```bash
git clone https://github.com/QiXueDian/mc-agent.git
cd mc-agent
npm install
```

> **canvas 免编译说明**：`prismarine-viewer` 依赖 `canvas`，而 Node 22 + Windows 上没有官方预编译包（`node-gyp` 会要求 VS Build Tools / Python）。本项目在 `package.json` 里用 npm alias 解决：`"canvas": "npm:@napi-rs/canvas@^1.0.13"`——装下来就是预编译二进制，**不需要任何编译工具链**。

### 配置 `.env`

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

`.env.example` 已带完整注释，关键项：

| 分组 | 变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **模型** | `DEEPSEEK_API_KEY` | — | 必填，格式 `sk-…` |
| | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | 换代理 / 自建网关 |
| | `DEEPSEEK_MODEL` | `deepseek-chat` | 或 `deepseek-reasoner` |
| | `AI_TEMPERATURE` | `0.3` | 越高越发散 |
| | `AI_TIMEOUT` | `120000` | 单次大模型请求超时（ms），另有 2 次自动重试 |
| **Agent** | `MAX_STEPS` | `15` | 单次任务步数上限（长链任务如铁镐一般 8~12 步） |
| | `MAX_RECOVERY` | `2` | 伪工具调用格式纠错的熔断阈值 |
| | `AGENT_PERSONA` | `worker` | 启动人格 |
| | `CRITICAL_PULSE_MS` | `500` | 溺水/着火巡检周期（ms），越小越灵敏越吃 CPU |
| | `WIKI_TIMEOUT` | `8000` | Wiki 检索超时（ms），失败降级为“经验判断” |
| **Minecraft** | `MC_HOST` / `MC_PORT` | `127.0.0.1` / `25565` | 离线服务器地址 |
| | `MC_USERNAME` | `AIAgent` | 游戏内 ID |
| | `MC_VERSION` | 空 | 留空自动探测；握手识别不准时强制指定（推荐显式写死） |
| | `MC_RECONNECT_DELAY` | `5000` | 断线重连间隔（ms） |
| **服务 / 鉴权** | `PORT` | `3000` | Web 服务端口 |
| | `ACCESS_TOKEN` | 空 | 面板访问令牌；非空时 `/api/*` 必须携带，否则 401 |
| **AI 视角** | `VIEWER_ENABLED` | `1` | `0` = 完全不启动，不监听额外端口 |
| | `VIEWER_PORT` | `3001` | 不能与 `PORT` / `MC_PORT` 冲突 |
| | `VIEWER_HOST` | `localhost` | 仅用于生成访问地址 |
| | `VIEWER_FIRST_PERSON` | `1` | `1` 第一人称 / `0` 第三人称环绕 |
| | `VIEWER_VIEW_DISTANCE` | `8` | 渲染距离（格），越大越吃 CPU |
| | `VIEWER_PUBLIC_URL` | 空 | 显式覆盖 iframe 地址 |

> 表中所有变量都有代码内置默认值，`.env` 里不写也能跑；`WIKI_TIMEOUT` / `AI_TIMEOUT` 这类调优项未放进 `.env.example` 以免干扰首次配置。
> `prismarine-viewer` 内部固定 `http.listen(port)`（没有 host 参数），实际监听 `0.0.0.0`；需要仅本机访问请用防火墙 / 反向代理限制。

### 启动

```bash
npm start            # Web 模式 → http://localhost:3000
npm run dev          # 同上，node --watch 热重启
npm run cli          # 终端模式：同一套大脑，只换输出通道
```

```bash
# CLI 模式可直接带指令
USER_INSTRUCTION="帮我做个木镐，然后告诉我你在哪" npm run cli
```

> **首次打开面板**：若设置了 `ACCESS_TOKEN`，页面顶部会出现令牌输入框（值只存 `localStorage`，不回传服务器）。
>
> **记忆会落盘**：每轮问答在 `done` 时追加到 `chat_history.log`（一行一轮的 JSONL），启动时自动恢复最近 20 条；文件超过 2MB 自动压缩到最近 200 轮（`*.log` 已 gitignore）。

### 说点什么试试

```text
帮我搞一把石镐
去附近找个村庄，看看有没有箱子
钻石镐怎么合成？铁锭怎么烧？
把背包里的泥土扔掉，腾点空间
```

---

## 🧰 工具清单（18 个）

| 分组 | 工具 | 一句话行为 |
| --- | --- | --- |
| 资源与制造 | `collect_resource` | 找最近的目标方块 → 能力预检 → 寻路 → 挖 → 智能拾取 |
| | `craft_item` | 2×2 优先，需要工作台就找/放一个；材料不足时说清缺什么 |
| | `smelt_item` | 填**产物名**即可：找/放熔炉 → 投料投燃料 → 轮询 → 产出即取 |
| 战斗与感知 | `attack_entity` | 装最强武器、追着打，带 30s 总时限与血量保护 |
| | `find_entities` | 按类型汇总 + 最近坐标，不指定名字也能用 |
| 交互与装备 | `interact_with_block` | `activate`（开箱/按钮）与 `use_on`（锄地/放桶）分协议 |
| | `equip_item` | 按物品名推断槽位（手/副手/头/胸/腿/脚）再装备 |
| 背包与生存 | `drop_item` | 逐格 `tossStack` / `toss`，用背包差值核对真实丢弃数 |
| | `eat_item` | 装备 → `consume` → 背包差值核对；自动挑饱食度最高、跳过有毒食物 |
| 移动与探索 | `move_to` | 精确落点失败自动退化为“2 格内”，不放弃整次移动 |
| | `explore` | 朝某方向走 N 格，走不动按“已走多远”汇报 |
| | `scan_environment` | 一次 `findBlocks` 批量扫描，按距离排序并给相对方位 |
| | `locate_structure` | 用村庄特征方块 + 居民实体判定，只读不移动 |
| 空间记忆 | `save_waypoint` | 默认记住当前位置，原子写入 `waypoints.json` |
| | `go_to_waypoint` | 复用安全寻路；跨维度明确拒绝 |
| 知识 | `query_game_knowledge` | `item` / `recipe` / `entity` / `loot` / `wiki` 五种查询 |
| 状态与保命 | `get_status` | 坐标 / 血量 / 饥饿 / 手持 / 背包占用 + “有什么能吃的” |
| | `escape_danger` | 三段式：上浮 → 必要时挖头顶 1 格 → 找最近岸边 |

### 加一个工具要改哪里

1. `src/agent/tools.js`：写 `toolDefinition`（JSON Schema）+ 实现 + `switch` 分发（统一 `return await`）
2. `src/agent/personas.js`：在 CORE 的【工具清单】补一行（**只有这一处**，三套人格自动同步）

> 任何涉及 `bot.*` 的新调用，先问一句：**它会不会永不 resolve？** 会，就必须包 `withTimeout`；涉及寻路，就必须走 `gotoOrThrow`。

---

## 🌐 HTTP 接口与鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent?message=...` | 主入口，SSE 流式返回决策链 |
| GET | `/api/agent?message=...&reset=1` | 顺带清空多轮记忆 |
| GET | `/api/agent?message=...&persona=chunibyo` | 单次请求切换人格 |
| POST | `/api/agent/stop` | 停止当前任务（幂等，先 abort 再掐动作） |
| GET | `/api/history` | 查看当前对话记忆（调试用） |
| GET | `/api/personas` / POST `/api/persona` | 人格列表 / 运行期切换（下一轮生效） |
| GET | `/api/bot/hud` | HUD 快照（未 spawn 返回 `ready:false`） |
| POST | `/api/viewer/mode` | 切换第一/第三人称（重启 viewer） |
| GET | `/api/health` | `botReady` / `model` / `persona` / `version` / `gameData` / `authRequired` / `viewer` |

> **访问令牌**：`.env` 的 `ACCESS_TOKEN` 非空时，除 `/api/health` 外所有 `/api/*` 都必须带令牌，否则 `401`。
> 三种写法都支持：请求头 `x-access-token: <token>`、`Authorization: Bearer <token>`、查询参数 `?token=<token>`（`EventSource` 不能自定义请求头，所以 Web 面板的 SSE 走查询参数）。
> 比较用 `crypto.timingSafeEqual` 定长比较，避免逐字符短路泄露令牌长度。
> `ACCESS_TOKEN` 留空 = 完全不校验，只建议纯本机调试时这么做。

```bash
# 带令牌（头）
curl -H "x-access-token: <你的 ACCESS_TOKEN>" \
  "http://localhost:3000/api/agent?message=去砍10个木头&persona=worker"

# 带令牌（query，等价）
curl "http://localhost:3000/api/agent?message=去砍10个木头&token=<你的 ACCESS_TOKEN>"
```

---

## 🧠 提示词与人格

提示词拆成两半，生命周期完全不同：

| 组成 | 内容 | 变更频率 |
| --- | --- | --- |
| **CORE**（能力内核，三份共用） | 语言要求、18 个工具清单、任务拆解、探索法则、背包管理、安全规则、执行纪律、中断与死亡纪律 | 工具一变就要同步改，**只存一份** |
| **soul**（人格） | 称呼、口头禅、黑话、语气示例 | 纯风格，随便切 |

### 内置人格

| ID | 名称 | 说话方式 |
| --- | --- | --- |
| `worker` | 幽默的赛博打工人（默认） | 叫用户“老大”，挖矿 = 搬砖、打怪 = 清场；吐槽完必须给方案 |
| `tsundere` | 傲娇的生存大师 | 先给专业结论再补一句傲娇（约 3:1）；失手认但不认输 |
| `chunibyo` | 极其中二的冒险家 | “吾之指挥官”，赶路 = 踏上征途，**中二是包装，数据必须靠谱** |

### 三种切换方式

```bash
# 1) 启动默认值（.env）
AGENT_PERSONA=tsundere

# 2) 单次请求覆盖（方便 AB 对比）
curl "http://localhost:3000/api/agent?message=去挖矿&persona=chunibyo"

# 3) 运行期切换（下一轮指令生效，不影响正在跑的任务）
curl -X POST http://localhost:3000/api/persona -H "Content-Type: application/json" -d '{"id":"tsundere"}'
```

### 加一个新人格

只往 `PERSONAS` 里加一项，CORE 一行都不用碰：

```js
// src/agent/personas.js
const NEW_SOUL = `你是 ${BOT_NAME}，……（称呼 / 性格 / 语气示例）`

const PERSONAS = {
  // …已有的三项
  newbie: { label: '新人实习生', description: '礼貌但手忙脚乱', soul: NEW_SOUL }
}
```

### 内核里的两条硬纪律

> **安全规则**（优先级最高，压过一切任务）：血量 < 10、水下氧气 ≤ 6、着火 → 立刻停手保命，当前任务作废。
>
> **中断与死亡纪律**：被用户中断只回一句“已停下”然后原地待命；死亡后先报“我在重生点”，再问要不要重来。

---

## 🛠️ Troubleshooting：六个真实踩过的坑

每一项都是**现象 → 根因 → 现在的解法**，按“最容易被误判”的顺序排。

### ① 寻路超时后，机器人一边走一边挖

| | |
| --- | --- |
| **现象** | 挖矿工具报“没挖到”，但地上的方块已经碎了；或者合成报“材料够却距离不足”；熔炉“打不开”。日志里全是 WARN，没有 ERROR。 |
| **根因** | `withTimeout` 只让调用方 `reject`，pathfinder 的寻路任务**还在后台跑**。上层 `catch` 之后继续 `bot.dig`，两个动作抢控制权。这是典型的“没有报错，但行为错乱”。 |
| **解法** | 批次 P0：所有寻路改走 `gotoOrThrow()`，**catch 里先 `stopPathfinder()` 再 `throw`**。8 处寻路 + 6 处 `equip` 全部覆盖。 |

### ② 溺水时越挣扎越不动，6 秒后才报“上浮失败”

| | |
| --- | --- |
| **现象** | 氧气见底，模型调了 `escape_danger`，机器人却停在水里不动，最后回一句“上浮没能出水”。 |
| **根因** | 500ms 危急巡检命中后调 `interruptBotActions()` → `clearControlStates()`，把逃生正在按住的 `jump` 键清掉了。**救命的动作被自己的反射弧打断。** |
| **解法** | 批次 P1：`escape_danger` 期间置 `bot.isEscaping = true`，`interruptBotActions()` 命中旗标直接返回——**只 abort 大模型循环，不动底层动作**；`finally` 复位。 |

### ③ 断线重连瞬间发指令，固定卡 60 秒

| | |
| --- | --- |
| **现象** | 服务器重启后机器人明明已经回来了，但 `/api/agent` 请求还是干等 60 秒才报“等待机器人进入游戏超时”。偶发，难复现。 |
| **根因** | `waitForSpawn` 用的是 `getBot().once('spawn')` 的**实例快照**。重连会 `createBot()` 换掉实例，旧实例永远不会再 spawn。 |
| **解法** | 批次 P2：200ms 轮询对齐当前实例（`attachCurrent` 搬监听器）+ `isReady()` 兜底 + 超时窗口不因重连重置 + `manualQuit` 保护。 |

### ④ 挖矿 / 进食偶发“永久卡住”，日志停在 `OBSERVE` 之前

| | |
| --- | --- |
| **现象** | 一次运行卡住十几分钟，SSE 靠心跳续命，界面一直转圈，停止按钮也不管用。 |
| **根因** | `bot.equip` 依赖服务端窗口刷新，界面卡住时 Promise **永不 resolve**。而 `try/catch` 只能接住**抛出的异常**，接不住永不 resolve。 |
| **解法** | 6 处 `bot.equip` 全部包 `withTimeout(..., EQUIP_TIMEOUT, ...)`；逃生/合成/熔炼等长短动作同样各有超时（见上方超时矩阵）。 |

### ⑤ 点“停止生成”之后它为什么还在动？

| | |
| --- | --- |
| **现象** | 点了停止，循环不再输出新步骤，但机器人还在走最后一段路。 |
| **根因** | `AbortController` 只能让循环在**下一次检查**时退出，`pathfinder.goto()` 可能还要走 30 秒。 |
| **解法** | 停止 = **abort + 掐断底层动作**（`pathfinder.stop()` / `stopDigging()` / `clearControlStates()`），并为剩余 `tool_call` 补占位消息，保证消息结构不破。逃生期间除外（见 ②）。 |

### ⑥ 死亡之后上下文炸了 / 换成新版本后“世上没有铁矿石”

| | |
| --- | --- |
| **现象** | ① 死亡后下一步请求直接 400；② 换 1.12.2 服务器，模型坚持说“这里没有铁矿石”。 |
| **根因** | ① 在工具执行中途插入/删除消息，`tool_call_id` 配对断裂。② 1.12.2 的原木叫 `log`、铁矿石不产 `raw_iron`；`minecraft-data` 遇到不认识的版本还返回 `null` 而不是抛错。 |
| **解法** | ① 死亡信息先落本地变量，等到**两个请求之间的安全边界**才重置上下文（保留 `system` + 本轮指令 + 死亡通知）。② 唯一数据源绑定 `bot.version`；熔炼表改成候选数组 + 运行期过滤；spawn 时五组探针自检并在面板亮红条。 |

### 其他常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动即 `EADDRINUSE` | 3000 被占 | `PORT=3100 npm start`，或杀掉占用进程 |
| 「🎥 AI 视角」一直灰着 | 3001 被占 / viewer 加载失败 | 看终端 `[VIEWER] …` 告警；改 `VIEWER_PORT` 或 `VIEWER_ENABLED=0` |
| 正文出现带竖线的 `invoke` / `calls` 标签乱码 | 模型把工具调用写进了正文 | 全自动：抢救 → 纠错 → 熔断（见“协议容错四层”） |
| 模型反复调同一个工具 | 它想“去别处看看”但没工具 | 护栏拦截 + 引导用 `explore` / `scan_environment` |

---

## 🧪 测试与开发

```bash
npm test                       # DSML / 伪工具调用回归（21 个用例，纯函数，秒回）
npm run test:knowledge         # 知识库输出基线比对（工具数 + 5 个配方用例）
npm run test:knowledge:update  # 确认改动是有意的之后，重写基线
npm run test:e2e               # 端到端：真实调用大模型 + 工具链（需有效 API Key）
npm run test:e2e -- "铁锭怎么烧"   # 自定义问题
```

> 单元测试只测纯函数；`test:e2e` 真跑 `runAgent`，断言最终回复非空、不含伪工具调用、确实调用了 `query_game_knowledge`，并把完整事件写入系统临时目录。

### 异步改动的验收清单

改任何 `bot.*` 调用前，先过这四条：

1. **它会不会永不 resolve？** 会 → 必须包 `withTimeout`，标注动作名与毫秒数。
2. **它是寻路吗？** 是 → 必须走 `gotoOrThrow`（或 `gotoWithGuard`），禁止裸调 `pathfinder.goto`。
3. **它和巡检定时器会抢状态吗？** 会 → 用 `isEscaping` 这类旗标做互斥，别指望“反正概率低”。
4. **它会不会在失败后继续执行后续动作？** 会 → 先刹车（`stopPathfinder` / `stopDigging`）再返回/抛出。

配套的回归命令：`npm test` + `node --check`（涉及结构改动时）。

### 目录结构

```text
mc-agent/
├── src/
│   ├── server.js              # HTTP 接入层：静态托管 + SSE 通道 + 路由 + 鉴权 + 记忆落盘
│   ├── brain.js               # CLI 入口：同一个 runAgent，换个输出通道
│   ├── agent/
│   │   ├── loop.js            # ⭐ ReAct 循环：唯一的「思考-行动-观察」实现
│   │   ├── tools.js           # ⭐ 18 个宏指令 + Schema + gotoOrThrow / isEscaping
│   │   ├── knowledge.js       # ⭐ minecraft-data 查询 + Wiki 检索 + 3x3 配方渲染
│   │   ├── protocol.js        # ⭐ 双通道 Tool Call 抢救 + Schema 校验
│   │   ├── personas.js        # CORE 能力内核 + 3 套人格
│   │   ├── waypoints.js       # 空间记忆：地标读写（原子写）
│   │   ├── survival.js        # 生存判定（血量 / 氧气 / 着火）+ 极简状态面板
│   │   ├── history.js         # 历史清洗 + 生存状态行就地刷新
│   │   └── utils.js           # 日志、超时包装、DSML 词法与清洗
│   └── bot/
│       ├── connection.js      # 连接生命周期 + 断线重连 + waitForSpawn + 危急广播
│       ├── viewer.js          # AI 视角：独立端口 + 故障隔离 + 热切换
│       └── hud.js             # 血量 / 护甲 / 快捷栏快照
├── public/index.html          # 单文件前端：SSE + 打字机 + 3x3 合成表 + HUD + 令牌输入
├── test/
│   ├── dsml-guard.test.js     # DSML 变体检测 / 清洗 / 抢救
│   ├── knowledge-baseline.js  # 配方输出回归基线
│   └── e2e-test.js            # 端到端冒烟
├── LICENSE                    # MIT
├── chat_history.log           # 运行时生成：一行一轮问答，重启恢复最近 20 条
├── waypoints.json             # 运行时生成：地标坐标
├── .env.example
└── package.json
```

---

## 🗺️ Roadmap

- [x] **空间记忆（地标）**：`save_waypoint` / `go_to_waypoint` + `waypoints.json`，重启不迷路
- [x] **熔炼与冶炼链**：`smelt_item` + 燃料管理，把 `raw_iron → iron_ingot` 补进闭环
- [x] **进食闭环**：`eat_item` 真的调用 `bot.consume()`，“饿了自己吃”不再是一句口号
- [x] **异步加固（P0/P1/P2）**：寻路超时刹车、逃生动作免打断、断线重连防卡死
- [ ] **长期记忆（RAG）**：矿脉分布、失败经验写进向量库（目前只有地标是结构化的）
- [ ] **多模态**：定期截图 + 视觉模型，直接“看”地形与界面，而不是只靠坐标数组
- [ ] **真正的 Kiting**：监听苦力怕引信状态，后撤 + 盾牌格挡，而不是“血少就跑”
- [ ] **多智能体分工**：矿工 / 农民 / 守卫共享世界状态，指挥官只下战略目标
- [ ] **地图记忆**：探索轨迹热力图，避免反复走同一条死路
- [ ] **语音交互**：TTS 播报 + 语音指令，真·游戏搭子

---

## 📄 License

[MIT](./LICENSE) © 2026 QiXueDian

> 本项目仅用于学习与研究。请在自己或获得授权的服务器上运行，尊重服务器规则与玩家体验。
