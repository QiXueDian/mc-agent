/**
 * ============================================================================
 *  src/server.js —— HTTP 接入层（只做“收请求 → 推事件 → 关连接”）
 * ----------------------------------------------------------------------------
 *  重构后本文件只剩三件事：
 *    1) 托管 public/ 静态资源
 *    2) 用统一函数创建 SSE 通道（headers / 心跳 / 断开检测 / 关闭）
 *    3) 调用 agent/loop.js 的 runAgent(message, emit)，把 emit 注入循环
 *
 *  业务逻辑（ReAct、工具执行、机器人连接）全部不在本文件里出现。
 *
 *  启动：node src/server.js  →  http://localhost:3000
 * ============================================================================
 */

require('dotenv').config()

const path = require('path')
const express = require('express')

const { runAgent, ACTIVE_PERSONA } = require('./agent/loop')
const { isPersona, getSystemPrompt, listPersonas } = require('./agent/personas')
const {
  waitForSpawn,
  isReady,
  disconnect,
  getBot,
  interruptBotActions
} = require('./bot/connection')
const { getViewerInfo, restartViewer } = require('./bot/viewer')
const { getHudSnapshot } = require('./bot/hud')
const { log, describeError } = require('./agent/utils')

const SERVER_PORT = Number(process.env.PORT || 3000)
const HEARTBEAT_MS = 15000 // SSE 心跳间隔，防止代理 60s 超时断流

// ------------------------------ 1. 统一 SSE 发送 ------------------------------
/**
 * 全项目唯一的 SSE 写入口（DRY）：
 *   以前每个分支都手写 res.write(`data: ${JSON.stringify(...)}\n\n`)，
 *   一处引号写错就整条流坏掉；现在只有这一个实现。
 *
 * @param {import('http').ServerResponse} res
 * @param {string} type  事件类型：start/step/thought/action/observe/warn/error/done
 * @param {object} data  附带字段（text/step/tool/args…）
 * @returns {boolean} 是否写入成功
 */
function sendSSE(res, type, data = {}) {
  if (!res || res.writableEnded || res.destroyed) return false
  try {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
    return true
  } catch (err) {
    // 客户端在写入瞬间断开时可能抛错，不能让它打断 Agent 循环
    log('WARN', `SSE 写入失败（忽略）：${describeError(err)}`)
    return false
  }
}

/**
 * 创建一条 SSE 通道：一次性处理响应头、心跳、断开检测与关闭。
 * 这样路由里就再也看不到重复的 res.writeHead / setInterval / res.end。
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {{ emit: Function, close: Function, isClosed: Function }}
 */
function createSSEChannel(req, res) {
  // 1) 响应头：Content-Type 必须是 text/event-stream，且禁止缓存/压缩
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', // no-transform：阻止代理压缩（压缩会攒数据导致不实时）
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // 关掉 Nginx 缓冲
  })
  res.flushHeaders?.() // 立刻发出响应头，EventSource 才会尽快触发 onopen

  // 2) 断开检测：浏览器关页面后不再继续跑 Agent（省 token）
  let closed = false
  req.on('close', () => {
    closed = true
  })

  // 3) 心跳注释帧，防止中间代理因长时间无数据断开
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n')
  }, HEARTBEAT_MS)

  // 4) 推送：统一的“已断开就不再写”保护
  const emit = (type, data) => {
    if (closed) return false
    return sendSSE(res, type, data)
  }

  // 5) 关闭：清心跳 + 结束响应（调用方放在 finally 里，保证一定执行）
  const close = () => {
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  }

  return { emit, close, isClosed: () => closed }
}

// ------------------------------ 2. Express 应用 ------------------------------
const app = express()

// 托管前端：public/index.html → http://localhost:3000/
// 只为了让 POST /api/persona、/api/viewer/mode 能读 JSON body；GET 完全不受影响
app.use(express.json({ limit: '16kb' }))
app.use(express.static(path.join(__dirname, '..', 'public')))

/**
 * 同一时间只允许一个 Agent 任务占用机器人，避免两路 SSE 抢 bot。
 *
 * 与旧版“忙就拒绝”的区别：现在新任务会 **抢占** 旧任务（abort + 掐断寻路/挖掘），
 * 然后等旧任务在 finally 里释放串行锁，再启动新的 —— 任意时刻仍然只有一个 run 在跑。
 */
let activeRun = null // { id, controller, message, finished }
let runSeq = 0

/** 是否正在执行任务（/api/viewer 的提示文案要用） */
function isAgentBusy() {
  return Boolean(activeRun)
}

/**
 * 中断当前任务：先 abort（让循环退出），再掐底层动作（让机器人立刻停手）。
 * 返回是否真的中断了。
 */
function abortActiveRun(reason = '用户中断') {
  if (!activeRun) return false

  const id = activeRun.id
  activeRun.controller.abort()
  // abort 只能让循环在下一次检查时停下，pathfinder.goto 可能还要走几十秒，
  // 所以这里必须直接掐断底层动作，否则用户点了停止还得看它走完。
  interruptBotActions()
  log('HTTP', `已中断任务 #${id}（${reason}）`)
  return true
}

/**
 * 当前风格（persona）。
 * 初值来自 .env 的 AGENT_PERSONA（启动时决定），之后可由 POST /api/persona 在运行期切换；
 * 因为 runAgent 支持 per-request 覆盖 systemPrompt，所以 loop.js 一行都不用改。
 */
let currentPersonaId = ACTIVE_PERSONA

// ----------------------------------------------------------------------------
//  多轮对话记忆（Context Memory）
// ----------------------------------------------------------------------------
//  单用户测试用全局数组就够了；多用户场景把 chatHistory 换成
//    const chatHistory = new Map()  // key = sessionId
//  读取时 chatHistory.get(sessionId) ?? []，push 前先 set 即可，其余逻辑不变。
//
//  只存 user / assistant 的纯文本：工具调用与工具结果（tool_calls / role:tool）
//  是属于“某一轮内部”的，跨轮保存会导致 tool_call_id 对不上，接口直接 400。
const MAX_HISTORY_MESSAGES = 7 // 最多保留最近 7 条，防止 token 爆炸
const chatHistory = []

/**
 * 裁剪历史：只留最近 max 条，并且保证以 user 开头
 * （否则会出现“孤立的 assistant 回复”，模型容易接错话）。
 */
function trimHistory(list, max = MAX_HISTORY_MESSAGES) {
  if (list.length > max) list.splice(0, list.length - max)
  while (list.length > 0 && list[0].role !== 'user') list.shift()
  return list
}

app.get('/api/agent', async (req, res) => {
  const channel = createSSEChannel(req, res)
  const message = String(req.query.message || '').trim()

  // 在 try 外声明：finally 里要用它们释放串行锁，早退分支也必须能安全走到 finally
  let runId = 0
  let releaseRun = () => {}

  log('HTTP', `收到指令：${message || '(空)'}`)

  try {
    // ---- 入参校验 ----
    if (!message) {
      channel.emit('error', { text: '缺少 message 参数，请使用 /api/agent?message=你的指令' })
      return
    }
    // ---- 抢占式调度：新指令顶掉旧任务（不是“忙就拒绝”）----
    if (activeRun) {
      log('HTTP', `收到新指令，先中断正在执行的任务 #${activeRun.id}`)
      abortActiveRun('被新指令覆盖')
      // 等旧任务在 finally 里释放锁，保证任意时刻只有一个 run 在操作 bot
      try {
        await activeRun.finished
      } catch (_) {
        /* 旧任务的异常由它自己的 catch 处理 */
      }
    }

    const controller = new AbortController()
    runId = ++runSeq
    const finished = new Promise((resolve) => {
      releaseRun = resolve
    })
    activeRun = { id: runId, controller, message, finished }

    // ---- 可选：?reset=1 清空记忆，方便反复测试 ----
    if (req.query.reset === '1') {
      chatHistory.length = 0
      log('HTTP', '已清空对话记忆')
    }

    // ---- 1) 记录用户消息（追加，不覆盖）----
    chatHistory.push({ role: 'user', content: message })
    trimHistory(chatHistory) // 最多 7 条

    // ---- 2) 传给 Agent 的历史：去掉刚 push 的本轮消息 ----
    //     runAgent 内部会自己把 message 作为本轮 user 消息拼在最后，
    //     这里传全量会导致同一句话出现两次。
    const history = chatHistory.slice(0, -1)

    // ---- 3) 风格（persona）----
    //     优先级：?persona= 单次覆盖 > 当前选择（POST /api/persona）> 启动默认值
    //     loop.js 不需要知道这些，它只接收一个 systemPrompt 字符串。
    //     放在等待 spawn 之前：参数问题应当立刻反馈，而不是等机器人上线才报。
    const personaKey = String(req.query.persona || '').trim().toLowerCase()
    let requestPersonaId = currentPersonaId

    if (personaKey) {
      if (isPersona(personaKey)) {
        requestPersonaId = personaKey
        log('HTTP', `本次请求使用风格：${personaKey}（单次覆盖）`)
      } else {
        channel.emit('warn', { text: `未知风格 "${personaKey}"，本次沿用当前风格 ${currentPersonaId}` })
      }
    }

    // ---- 3.5) 确保机器人已进入游戏 ----
    if (!isReady()) {
      channel.emit('warn', { text: '机器人还没进入游戏，正在等待 spawn…' })
      await waitForSpawn()
    }

    // ---- 4) 交给 Agent 循环：唯一的耦合点就是 emit 这个函数 ----
    const answer = await runAgent(message, channel.emit, {
      shouldStop: channel.isClosed,
      history,
      signal: controller.signal, // 用户点停止 / 被新指令覆盖时，循环靠它退出
      systemPrompt: getSystemPrompt(requestPersonaId) // 显式传入，循环内部不再回落到启动常量
    })

    // ---- 5) 保存模型回复（客户端提前断开就不存，避免污染记忆）----
    if (!channel.isClosed() && answer) {
      chatHistory.push({ role: 'assistant', content: answer })
      trimHistory(chatHistory)
    }

    channel.emit('done', { text: answer })
    log('HTTP', `任务结束，关闭 SSE 连接（记忆 ${chatHistory.length}/${MAX_HISTORY_MESSAGES} 条）`)
  } catch (err) {
    // 路由层兜底：Agent 内部已处理大部分异常，这里只处理“还没进循环就失败”的情况
    channel.emit('error', { text: `服务端异常：${describeError(err)}` })
    log('ERROR', `处理请求失败：${describeError(err)}`)
  } finally {
    // 只有“自己还是当前 run”时才清空，避免被抢占后误清掉新任务的登记
    if (activeRun && activeRun.id === runId) activeRun = null
    releaseRun()
    channel.close()
  }
})

/**
 * 停止当前任务（前端红色【停止生成】按钮）。
 * 幂等：没有任务在跑时返回 stopped:false，前端据此决定提示文案。
 */
app.post('/api/agent/stop', (req, res) => {
  if (!activeRun) {
    return res.json({ ok: true, stopped: false, text: '当前没有正在执行的任务' })
  }

  const id = activeRun.id
  abortActiveRun('用户点了停止')
  res.json({ ok: true, stopped: true, id })
})

/** 查看当前对话记忆（调试用；也可以用来确认“目标没丢”） */
app.get('/api/history', (req, res) => {
  res.json({ max: MAX_HISTORY_MESSAGES, count: chatHistory.length, messages: chatHistory })
})

/** 风格清单：前端下拉框用（id / name / description，另带 key / label 别名） */
app.get('/api/personas', (req, res) => {
  res.json({ active: currentPersonaId, personas: listPersonas() })
})

/**
 * 切换当前风格。
 * 只改内存态，不影响正在执行的任务（当前轮 system prompt 已在请求开始时固化），
 * 所以前端提示必须写“下一次指令生效”。
 */
app.post('/api/persona', (req, res) => {
  const id = String((req.body && req.body.id) || '').trim().toLowerCase()

  if (!id) {
    return res.status(400).json({ ok: false, error: '缺少 id 参数' })
  }
  if (!isPersona(id)) {
    // 非法 id：明确报错，不静默回落、不改当前状态
    return res.status(400).json({ ok: false, error: `未知风格 "${id}"`, active: currentPersonaId })
  }

  const previous = currentPersonaId
  currentPersonaId = id

  const info = listPersonas().find((item) => item.id === id)
  log('HTTP', `风格已切换：${previous} → ${id}（${info ? info.name : id}）`)

  return res.json({
    ok: true,
    active: currentPersonaId,
    name: info ? info.name : id,
    description: info ? info.description : ''
  })
})

/**
 * 切换 AI 视角（第一人称 / 第三人称）。
 *
 * 实现方式是“重启 viewer”：prismarine-viewer 的 firstPerson 是启动参数、被闭包捕获，
 * 运行期改不了（调研结论）。重启会短暂中断画面，但不影响 Agent 循环与 SSE。
 * 失败一律 500 + WARN，前端回滚按钮，绝不假装成功。
 */
app.post('/api/viewer/mode', async (req, res) => {
  const raw = req.body ? req.body.firstPerson : undefined

  if (raw === undefined || raw === null || raw === '') {
    return res.status(400).json({ ok: false, error: '缺少 firstPerson 参数（true / false）' })
  }

  const want = raw === true || raw === 'true' || raw === 1 || raw === '1'

  // 切视角只影响画面，不动 Agent；但正在跑任务时提醒一句，免得用户以为任务被打断
  const notice = isAgentBusy() ? '切换视角会短暂中断画面，不影响 Agent 执行' : ''
  if (notice) log('WARN', notice)

  try {
    const result = await restartViewer(getBot(), want)

    if (!result.ok) {
      log('WARN', `[VIEWER] 切换失败，画面保持原状：${result.message}`)
      return res.status(500).json({
        ok: false,
        error: result.message,
        code: result.code,
        notice,
        viewer: getViewerInfo()
      })
    }

    return res.json({
      ok: true,
      firstPerson: result.firstPerson,
      url: result.url,
      notice,
      viewer: getViewerInfo()
    })
  } catch (err) {
    log('WARN', `[VIEWER] 切换异常，画面保持原状：${describeError(err)}`)
    return res.status(500).json({
      ok: false,
      error: `切换失败：${describeError(err)}`,
      notice,
      viewer: getViewerInfo()
    })
  }
})

/**
 * HUD 数据：血量 / 饥饿 / 护甲 / 手持物 / 快捷栏 / 坐标。
 *
 * 设计要点：
 *   · 未 spawn 或背包未同步 → 200 + { ok:true, ready:false }，让前端置灰但保留旧值；
 *   · 前端 2 秒轮询一次，所以要轻：纯内存读，没有寻路/方块查询；
 *   · 所有空槽在后端就归一化为 null，前端不需要防御 undefined。
 */
app.get('/api/bot/hud', (req, res) => {
  try {
    res.json(getHudSnapshot(getBot()))
  } catch (err) {
    log('WARN', `[HUD] 读取状态失败（返回未就绪）：${describeError(err)}`)
    res.json({ ok: true, ready: false, at: Date.now() })
  }
})

/** 健康检查：排查机器人是否在线 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    botReady: isReady(),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    persona: currentPersonaId,
    // 只新增字段，不改动上面任何一个已有字段（前端 iframe 地址也从这里取）
    viewer: getViewerInfo()
  })
})

// ------------------------------ 3. 启动与退出 ------------------------------
const server = app.listen(SERVER_PORT, () => {
  log('HTTP', `Web 服务已启动：http://localhost:${SERVER_PORT}`)
  // connection.js 在 require 时已开始连接，这里只是提示
  log('HTTP', '机器人连接由 src/bot/connection.js 维护（断线自动重连）')

  // AI 视角：独立端口，机器人 spawn 后才真正启动；disabled 时不会有任何监听
  const viewer = getViewerInfo()
  if (!viewer.enabled) {
    log('HTTP', 'AI 视角已禁用（VIEWER_ENABLED=0），不会监听额外端口')
  } else {
    log('HTTP', `AI 视角将在机器人 spawn 后启动：${viewer.url}（独立端口 ${viewer.port}）`)
  }
})

let shuttingDown = false

process.on('SIGINT', () => {
  if (shuttingDown) return
  shuttingDown = true
  log('EXIT', '收到 Ctrl+C，正在关闭服务…')

  server.close(() => {
    disconnect('服务关闭')
    process.exit(0)
  })

  // 兜底：3 秒内没关干净就强制退出
  setTimeout(() => process.exit(0), 3000)
})
