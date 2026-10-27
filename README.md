# MC-Agent · Minecraft 自主生存智能体

![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
![LLM](https://img.shields.io/badge/LLM-DeepSeek-4D6BFE)
![Minecraft](https://img.shields.io/badge/Minecraft-1.20.x-62B47A?logo=minecraft&logoColor=white)
![Mineflayer](https://img.shields.io/badge/Mineflayer-4.x-00A98F)
![Transport](https://img.shields.io/badge/Transport-SSE-orange)
![Framework](https://img.shields.io/badge/Agent%20Framework-None-black)

```text
  __  __  ___          _                    _
 |  \/  || __|   __ _  __ _  ___ _ _   | |_
 | |\/| || _|   / _` |/ _` |/ -_) ' \  |  _|
 |_|  |_||___|  \__,_|\__, |\___|_||_|  \__|
                      |___/
      Minecraft Autonomous Agent / ReAct in the wild
```

> 一个**有生存本能、会画合成表、随时可被打断**的 Minecraft AI Agent —— 你说"帮我搞把铁镐"，它自己拆任务、挖矿、合成，水下缺氧会先上浮，你点停止它会立刻收手。

通用大模型只有"嘴"，传统脚本只有"手"。MC-Agent 把两者接起来：你扮演**指挥官**，只下达宏观意图；它扮演**执行者**，用 `思考 → 行动 → 观察` 的循环把一句人话翻译成一连串真实发生在方块世界里的动作——并且每一步都摊在屏幕上给你看。

---

## ✨ 核心特性

### 1. ≈600 行手写 ReAct 内核，零 Agent 框架

不引入 LangChain 之类的重型抽象。循环调度、上下文裁剪、工具分发、流式分帧全部自己写，调用栈、token 消耗、单步延迟都可直接归因，运行时依赖只有 1 个 `openai` SDK 与游戏侧库。

- `messages` 严格按 `[system] → [user] → [assistant(tool_calls)] → [tool] → …` 累积，每个 `tool_call` 必有一条 `role: tool` 配对，**从源头规避协议层 400**
- 工具往返（`tool_calls` / 工具结果）**只在本轮内合法**，跨轮只回放纯文本历史——否则 `tool_call_id` 对不上，接口直接报错
- 可观测性内建：每一步 `thought / action / observe` 带 `step` 序号推给前端，配合时间戳日志，决策链可回放、可计时

### 2. 流式决策可视化

前端用原生 `EventSource` 接 9 类事件，把 AI 的内心戏直接摊在屏幕上：

| 事件 | 含义 | UI 表现 |
| --- | --- | --- |
| `start` / `step` | 任务开始 / 第 N 步思考 | 分隔线 |
| `thought` | 🧠 模型在想什么 | 蓝色卡片 |
| `action` | 🤖 调了哪个工具、参数是什么 | 黄色等宽卡片 |
| `observe` | 👀 工具真实返回 | 绿色等宽卡片 |
| `warn` / `error` | 护栏告警 / 异常 | 橙色 / 红色 |
| `death` | 💀 机器人死亡，上下文已重置 | 红色高亮 |
| `done` | ✅ 最终答复 | 绿色卡片 |

消息走**渲染队列 + 打字机**（12ms/字）逐条"打"出来，保证 SSE 乱序到达时顺序依然稳定。

### 3. 图文 3x3 合成表渲染

`query_game_knowledge` 返回的是严格 Markdown 配方，前端把它**在气泡里就地替换成图形化合成表**：

- 识别「表头 + 分隔行」起表，最多取 3 行、少行自动补"空"，保证恒为 3&times;3 网格
- 向上回溯最近的 `产出：<英文ID> xN` 当标题并从正文摘掉，渲染成 `3x3 输入 → 产物` 一行
- 贴图**三级降级**：`item/*.png` → `block/*.png` → 英文 ID 文本，CDN 挂了也绝不显示碎图
- 全程 `textContent` 重建、**不用 `innerHTML`**，模型返回什么都不会变成 XSS

> 贴图根地址来自 jsDelivr 的 `misode/mcmeta@assets` 分支，与游戏版本解耦；全站只有一处常量，换 CDN 改一行。

### 4. 本地知识库：0 幻觉的配方查询

配方不是"模型记忆"，是 `minecraft-data` 的**本地数据**——不联网、不瞎编：

- `query_type=item` → 堆叠上限 + 最大耐久；`query_type=recipe` → `产出：<ID> xN` + 3 行表格
- **同形状配方自动聚合**：按"哪几格有料"算形状指纹，12 种木板做的工作台只画一张表，其余用一句"图中的 `oak_planks` 可替换为任意木板（如 `spruce_planks` 等 11 种）"带过
- **冷门材料后压**：深板岩 / 黑石 / 樱花木等参与排序，保证"圆石在前、深板岩在后"
- 无序配方给出 `所需材料：a x4, b x2`，熔炼链由 `SMELTING_RECIPES` 兜底
- 中英双写：正文里永远是 `圆石(cobblestone)`，工具参数里永远是纯英文 ID

### 5. Tool Call 容错与清洗机制

模型偶尔会把工具调用**写进正文**（内部方言 `<| |invoke>`、Markdown JSON，甚至竖线被空格拆开）。这套防线分四层：

1. **词法层**：`(?:[|｜]\s*){0,3}` 同时容忍半角/全角竖线与任意空白，`< | | calls>` 这类变体也逃不掉
2. **清洗层**：成对块 → 截断块 → 残余标签 → 包裹 token → 零宽字符，按固定顺序删，标签体不会残留成乱码
3. **抢救层（双通道）**：XML 通道用 `split` 按开标签切分（容忍 `max_tokens` 截断的闭合标签）；JSON 通道只认"有工具名 + 有参数载荷 + 白名单命中"三重判据
4. **校验层**：抢救出的参数必须过工具自带的 **JSON Schema**（必填、类型、上下限、`additionalProperties === false`），任一不合规整段丢弃

> 抢救失败 → 注入一次格式纠错并重试；连续 `MAX_RECOVERY`（默认 2）次仍失败 → **熔断**，绝不把 8 步配额全耗在"重写格式"上。最终出口还有二次校验：带脏标签的"总结"直接替换成安全话术。

### 6. 生存本能：任务给命让路

每步请求前都会读一次真实生存状态，**以零新增消息的方式**贴到最后一条 `role: tool` 末尾（不涨 token 条数）：

```text
【生存状态】血量 18/20｜饥饿 15/20｜氧气 --（不在水下）｜坐标 (10, 64, -3)
【生存状态·危急】水下氧气只剩 4/20｜血量 7/20 低于 10｜…
```

- 阈值：**血量 < 10**、**水下氧气 ≤ 6**、**着火** → `critical`
- 危急时额外注入一条 `role: user` 硬指令："立刻停止当前任务，优先保命"（同一原因只推一次，避免 8 步刷 8 条）
- 氧气只在 `entity.isInWater === true` 时可信——上游 `oxygenLevel` 上岸后不会立刻回满，按直觉读会误判

### 7. 真·可中断：点停止就真的停

`AbortController` 只能让循环在**下一次检查**时退出，而 `pathfinder.goto()` 可能还要走 30 秒——所以中断分两刀：

```js
activeRun.controller.abort()   // 1) 让循环退出
interruptBotActions()          // 2) 掐断 pathfinder.stop() + stopDigging() + clearControlStates()
```

- 同一个时刻只允许一个任务占用机器人，**新指令直接抢占旧任务**（不是"忙就拒绝"）
- 浏览器关标签页 → `req.on('close')` 立刻感知 → 循环提前结束，省 token
- SSE 通道带 15s 心跳与 `X-Accel-Buffering: no`，反代后面也不会攒包

### 8. 第一人称实时画面 + HUD

面板里内嵌一个可折叠的「🎥 AI 视角」：机器人挖矿、跑图、清场时你能直接看到第一人称画面。

- 画面跑在**独立端口 3001**，与 Agent（3000）、MC 端口完全隔离；起不来只 WARN，**Agent 照跑**
- 视角可热切换第一/第三人称：`firstPerson` 是启动参数、被闭包捕获，运行期改不了 → 走"关旧实例 → 等端口释放 → 重开 → 等可连接 → 失败自动恢复原视角"
- 端口占用探测用 **TCP connect 而非 bind**：Windows 的 `SO_REUSEADDR` 会让 bind 探测误报"端口空闲"
- HUD 每 2 秒轮询 `/api/bot/hud`：血量 / 饥饿 / 护甲 / 坐标 / 9 格快捷栏；未 spawn 时置灰但保留旧值（护甲点数靠 `slots[5..8]` 按材质×部位查表——mineflayer 4.x 并没有 `bot.armor`）

### 9. 人格与能力分离

三套语气共用**同一份能力内核**（工具清单、任务拆解、ReAct 纪律、安全规则）。换人格只换"魂"，新增工具只改一处，不会出现"打工人会 `drop_item`、傲娇大师不会"的怪事。

---

## 🏗️ 架构设计

```text
┌─────────────────────────┐        ┌──────────────────────────────────────┐
│  public/index.html      │        │  src/server.js (Express)             │
│  · EventSource 收流     │◀──SSE──│  · createSSEChannel (心跳/断开检测)   │
│  · 打字机 + 渲染队列    │        │  · AbortController + 抢占式调度       │
│  · 3x3 合成表 / HUD     │──POST─▶│  · chatHistory (7 条纯文本)          │
│  · 🎥 AI 视角 iframe    │        └──────────────────┬───────────────────┘
└─────────────────────────┘                           │ emit(type, data)
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │  agent/loop.js  (ReAct 内核) │
                                       │  · 步数上限 / 防死循环护栏    │
                                       │  · 生存巡检 / 死亡上下文重置  │
                                       │  ┌────────────────────────┐  │
                                       │  │ protocol.js  双通道抢救│  │
                                       │  │ history.js   历史清洗  │  │
                                       │  └────────────────────────┘  │
                                       └───────┬──────────────┬───────┘
                                    executeTool│              │systemPrompt
                                               ▼              ▼
                              ┌────────────────────┐   ┌───────────────┐
                              │ agent/tools.js      │   │ personas.js   │
                              │ 14 个宏指令 + 校验  │   │ CORE + 3 soul │
                              └─────┬──────────┬───┘   └───────────────┘
                    query_game_     │          │ bot 实例
                    knowledge       ▼          ▼
                        ┌──────────────────┐  ┌──────────────────────────────┐
                        │ knowledge.js     │  │ bot/connection.js            │
                        │ minecraft-data   │  │ mineflayer + pathfinder      │
                        │ 本地查询 + 渲染  │  │ 断线重连 / 死亡广播 / 中断   │
                        └──────────────────┘  └───────┬──────────────┬───────┘
                                                      ▼              ▼
                                          ┌───────────────┐  ┌──────────────────┐
                                          │ bot/hud.js    │  │ bot/viewer.js    │
                                          │ 状态快照      │  │ :3001 第一人称   │
                                          └───────────────┘  └──────────────────┘
```

**一次任务的完整闭环**：指挥官一句话 → SSE 长连接 → 循环把提示词 + 历史 + 工具清单丢给 DeepSeek → 模型回 `tool_calls` → 工具层在游戏里真的挖了一镐 → 结果以 `role: tool` 回灌 → 下一步思考 → 直到不再调工具，返回人话。

### 模块职责表

| 文件 | 行数 | 只负责 | 明确不负责 |
| --- | ---: | --- | --- |
| `src/server.js` | 436 | 静态托管、SSE 通道、路由、抢占调度 | 不知道"挖矿"是什么 |
| `src/agent/loop.js` | 587 | 组织上下文、调模型、分发工具、护栏 | 不知道"怎么挖" |
| `src/agent/protocol.js` | 338 | arguments 解析、伪调用抢救、Schema 校验 | 不执行任何动作 |
| `src/agent/history.js` | 68 | 历史清洗、生存状态行附着 | 不做 IO |
| `src/agent/tools.js` | 2767 | 14 个宏指令的实现与入参校验 | 不知道"为什么要挖" |
| `src/agent/knowledge.js` | 581 | `minecraft-data` 查询与 Markdown 渲染 | 不碰 bot、不联网 |
| `src/agent/survival.js` | 127 | 生存判定与告警文案 | 不依赖任何业务模块 |
| `src/agent/personas.js` | 224 | CORE + 人格拼装 | 不含工具实现 |
| `src/bot/connection.js` | 221 | 连接生命周期、重连、死亡广播 | 不含推理逻辑 |
| `src/bot/viewer.js` | 444 | 第一人称画面生命周期 | 失败绝不影响 Agent |
| `src/bot/hud.js` | 125 | 血量/护甲/快捷栏快照 | 无副作用 |
| `public/index.html` | 1526 | 渲染、交互、轮询 | 不含业务规则 |

**依赖方向单行道**：`loop → tools / knowledge / protocol → utils`，`bot/*` 只被上层单向依赖，反向 require 会成环。

### HTTP 接口

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
| GET | `/api/health` | 在线状态 / 模型 / 人格 / 视角地址 |

```bash
curl "http://localhost:3000/api/agent?message=去砍10个木头&persona=worker"
```

---

## 🚀 快速开始

### 环境准备

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 18** | 需要原生 `fetch` 与 ESM interop |
| Minecraft Server | 1.8 ~ 1.20.x | **离线模式**（`online-mode=false`），否则 Mineflayer 连不上 |
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

| 分组 | 变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **模型** | `DEEPSEEK_API_KEY` | — | 必填，格式 `sk-…` |
| | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | 换代理 / 自建网关时改 |
| | `DEEPSEEK_MODEL` | `deepseek-chat` | 或 `deepseek-reasoner` |
| | `AI_TEMPERATURE` | `0.3` | 越高越发散 |
| | `AI_TIMEOUT` | `120000` | 单次请求超时（ms），另有 2 次自动重试 |
| **Agent** | `MAX_STEPS` | `8` | ReAct 步数上限 |
| | `MAX_RECOVERY` | `2` | 格式纠错熔断阈值 |
| | `AGENT_PERSONA` | `worker` | 启动时的人格 |
| **Minecraft** | `MC_HOST` / `MC_PORT` | `127.0.0.1` / `25565` | 离线服务器地址 |
| | `MC_USERNAME` | `AIAgent` | 游戏内 ID |
| | `MC_VERSION` | 空 | 留空自动探测 |
| | `MC_RECONNECT_DELAY` | `5000` | 断线重连间隔（ms） |
| **服务 / 视角** | `PORT` | `3000` | Web 服务端口 |
| | `VIEWER_ENABLED` | `1` | `0` = 完全不启动，不监听额外端口 |
| | `VIEWER_PORT` | `3001` | 不能与 `PORT` / `MC_PORT` 冲突 |
| | `VIEWER_HOST` | `localhost` | 仅用于生成访问地址 |
| | `VIEWER_FIRST_PERSON` | `1` | `1` 第一人称 / `0` 第三人称环绕 |
| | `VIEWER_VIEW_DISTANCE` | `8` | 渲染距离（格），越大越吃 CPU |
| | `VIEWER_PUBLIC_URL` | 空 | 显式覆盖 iframe 地址 |

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

### 说点什么试试

```text
帮我搞一把石镐
去附近找个村庄，看看有没有箱子
钻石镐怎么合成？铁锭怎么烧？
把背包里的泥土扔掉，腾点空间
```

---

## 🧠 提示词与人格

提示词拆成两半，生命周期完全不同：

| 组成 | 内容 | 变更频率 |
| --- | --- | --- |
| **CORE**（能力内核，三份共用） | 语言要求、工具清单、任务拆解、探索法则、背包管理、安全规则、执行纪律、中断与死亡纪律 | 工具一变就要同步改，**只存一份** |
| **soul**（人格） | 称呼、口头禅、黑话、语气示例 | 纯风格，随便切 |

### 内置人格

| ID | 名称 | 说话方式 |
| --- | --- | --- |
| `worker` | 幽默的赛博打工人（默认） | 叫用户"老大"，挖矿 = 搬砖、打怪 = 清场；吐槽完必须给方案 |
| `tsundere` | 傲娇的生存大师 | 先给专业结论再补一句傲娇（约 3:1）；失手认但不认输 |
| `chunibyo` | 极其中二的冒险家 | "吾之指挥官"，赶路 = 踏上征途，**中二是包装，数据必须靠谱** |

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

> **安全规则**（优先级最高，压过一切任务）：血量 < 10、水下氧气 < 6、着火 → 立刻停手保命，当前任务作废。
>
> **中断与死亡纪律**：被用户中断只回一句"已停下"然后原地待命；死亡后先报"我在重生点"，再问要不要重来。

---

## 🛠️ 进阶与踩坑

### ① 端口被占用

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动即 `EADDRINUSE` | 3000 被别的进程占了 | `PORT=3100 npm start`，或杀掉占用进程 |
| 页面正常但「🎥 AI 视角」一直灰着 | 3001 被占 / viewer 库加载失败 | 终端会有 `[VIEWER] …` 告警；改 `VIEWER_PORT` 或 `VIEWER_ENABLED=0` 直接关掉 |

> AI 视角是**增强而不是依赖**：起不来只打 WARN，ReAct 循环、SSE、工具执行全部照常。

### ② 模型吐出特殊 token / 伪工具调用

**现象**：正文里出现 `<| |invoke name="craft_item">`、`< | | calls>`，或者一整段 Markdown JSON——既没执行、又给用户看乱码。

**表现与处理**（全自动，无需干预）：

1. 词法层命中 → 通道一（XML/DSML）按开标签切分抢救；不中 → 通道二（JSON）兜底
2. 抢救成功 → 转为本地 `tool_calls` 直接执行，并推一条 `warn` 告知"已抢救为本地执行"
3. 抢救失败 → 注入格式纠错、**丢弃脏的 assistant 文本**（否则模型会照着抄）
4. 连续 2 次失败 → 熔断，返回 `（系统提示：AI 格式错乱，已强制中断任务…）`
5. 收尾阶段仍带脏标签 → 双重校验拦截，替换为安全话术，**绝不把脏文本塞进 `done`**

### ③ 机器人还没进游戏就发指令

会先推一条 `warn`："机器人还没进入游戏，正在等待 spawn…"，然后 `waitForSpawn()` 最多等 60 秒；超时抛"请检查服务器是否已启动"。同一时间只允许一个任务，新指令会**抢占**旧任务。

### ④ 模型死循环：同一个工具同样的参数

对 `工具名 + 稳定序列化参数` 生成指纹（key 排序，`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 视为同一次调用）：

| 第几次 | 处理 |
| --- | --- |
| 第 2 次 | **不执行**，把警告文本作为 `role: tool` 回灌（必须带 `tool_call_id`，否则下一轮 400） |
| 第 3 次 | 给当前及后续所有 `tool_call` 补占位消息，`break`，用一句人话收尾 |

> 经验：模型重复调用，往往是在用错误的方式表达"我想去别处看看"。补齐 `explore` / `move_to` / `scan_environment` 之后，护栏命中率明显下降。

### ⑤ 点"停止生成"之后它为什么还在动？

早期版本确实如此：`abort` 只是让循环在下一次检查时退出，`pathfinder.goto()` 仍会走完。现在停止 = **abort + 掐断底层动作**（`pathfinder.stop()` / `stopDigging()` / `clearControlStates()`），并为剩余 `tool_call` 补占位消息，保证消息结构不破。

### ⑥ 死亡之后上下文炸了？

死亡信息先落到本地变量，等**两次请求之间的安全边界**才重置上下文（保留 `system` + 本轮指令 + 死亡通知，丢掉整段 tool 往返）。刻意不在工具执行中途插入/删除消息——那会让 `tool_call_id` 对不上，DeepSeek 直接 400。

---

## 🧪 测试与开发

```bash
npm test                    # DSML / 伪工具调用回归（21 个用例，纯函数，秒回）
npm run test:knowledge      # 知识库输出逐字节基线比对（工具数 + 5 个配方用例）
npm run test:knowledge:update  # 确认改动是有意的之后，重写基线
npm run test:e2e            # 端到端：真实调用大模型 + 工具链（需要有效 API Key）
npm run test:e2e -- "铁锭怎么烧"   # 自定义问题
```

> 单元测试只测纯函数；`test:e2e` 真跑 `runAgent`，断言最终回复非空、不含伪工具调用、确实调用了 `query_game_knowledge`，并把完整事件写入系统临时目录。

### 目录结构

```text
mc-agent/
├── src/
│   ├── server.js              # HTTP 接入层：静态托管 + SSE 通道 + 路由
│   ├── brain.js               # CLI 入口：同一个 runAgent，换个输出通道
│   ├── agent/
│   │   ├── loop.js            # ⭐ ReAct 循环：唯一的「思考-行动-观察」实现
│   │   ├── protocol.js        # ⭐ 双通道 Tool Call 抢救 + Schema 校验
│   │   ├── history.js         # 历史清洗 + 生存状态行附着
│   │   ├── tools.js           # ⭐ 14 个宏指令 + 入参校验 + 寻路参数
│   │   ├── knowledge.js       # ⭐ minecraft-data 本地查询 + 3x3 配方渲染
│   │   ├── survival.js        # 生存判定（血量 / 氧气 / 着火）
│   │   ├── personas.js        # CORE 能力内核 + 3 套人格
│   │   └── utils.js           # 日志、超时包装、DSML 词法与清洗
│   └── bot/
│       ├── connection.js      # Mineflayer 连接生命周期 + 断线重连
│       ├── viewer.js          # AI 视角：独立端口 + 故障隔离 + 热切换
│       └── hud.js             # 血量 / 护甲 / 快捷栏快照
├── public/index.html          # 单文件前端：SSE + 打字机 + 3x3 合成表 + HUD
├── test/
│   ├── dsml-guard.test.js     # DSML 变体检测 / 清洗 / 抢救
│   ├── knowledge-baseline.js  # 配方输出回归基线
│   └── e2e-test.js            # 端到端冒烟
├── .env.example
└── package.json
```

### 加一个工具要改哪里

1. `src/agent/tools.js`：写 `toolDefinition`（JSON Schema）+ 实现 + `switch` 分发
2. `src/agent/personas.js`：在 CORE 的【工具清单】补一行（**只有这一处**，三套人格自动同步）

---

## 🗺️ Roadmap

- [ ] **长期记忆（RAG）**：把"家在哪、哪儿有矿脉、上次为什么失败"写进向量库，跨进程不丢
- [ ] **多模态**：定期截图 + 视觉模型，直接"看"地形与界面，而不是只靠坐标数组
- [ ] **熔炼与冶炼链**：`smelt_item` + 燃料管理，把 `raw_iron → iron_ingot` 补进闭环
- [ ] **真正的 Kiting**：监听苦力怕引信状态，后撤 + 盾牌格挡，而不是"血少就跑"
- [ ] **多智能体分工**：矿工 / 农民 / 守卫共享世界状态，指挥官只下战略目标
- [ ] **地图记忆**：探索轨迹热力图，避免反复走同一条死路
- [ ] **语音交互**：TTS 播报 + 语音指令，真·游戏搭子

---

## 📄 License

[MIT](./LICENSE) © 2026 QiXueDian

> 本项目仅用于学习与研究。请在自己或获得授权的服务器上运行，尊重服务器规则与玩家体验。
