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

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')

const { runAgent, ACTIVE_PERSONA, CRITICAL_ABORT_TAG } = require('./agent/loop')
const { isPersona, getSystemPrompt, listPersonas } = require('./agent/personas')
const {
  waitForSpawn,
  isReady,
  disconnect,
  getBot,
  interruptBotActions,
  onCritical,
  getVersionCheck
} = require('./bot/connection')
const { readSurvivalState } = require('./agent/survival')
const { getViewerInfo, restartViewer } = require('./bot/viewer')
const { getHudSnapshot } = require('./bot/hud')
const { log, describeError } = require('./agent/utils')

const SERVER_PORT = Number(process.env.PORT || 3000)
const HEARTBEAT_MS = 15000 // SSE 心跳间隔，防止代理 60s 超时断流

/**
 * 危急中断后自动注入的救援指令（作为新一轮 user 消息）。
 * 措辞要点：先否定原任务，再点名唯一允许的动作，避免模型接着回去挖矿。
 */
const RESCUE_INSTRUCTION =
  '【自动保命】你刚刚因致命危险被强制中断，现在仍处于危险中。' +
  '不要继续原来的任务，也不要解释过程。立刻调用 escape_danger 脱困；' +
  '脱离危险后调用 get_status 确认状态，再用一句话汇报。'

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

// ----------------------------------------------------------------------------
//  访问令牌（.env 的 ACCESS_TOKEN）
// ----------------------------------------------------------------------------
//  这是一台“能被一句话驱动去挖矿”的机器人：不设防的话，局域网里任何人
//  都能通过 /api/agent 指挥它，并且烧掉你的 DeepSeek 额度。
//  规则：
//    · ACCESS_TOKEN 为空  → 不校验（只建议纯本机调试）；
//    · ACCESS_TOKEN 非空  → 所有 /api/* 必须带令牌，支持三种写法：
//        请求头 x-access-token: <token>
//        请求头 Authorization: Bearer <token>
//        查询参数 ?token=<token>（EventSource 只能 GET，必须支持这种）
//    · /api/health 例外：前端在拿到令牌之前就要靠它探活、取 viewer 地址。
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || '').trim()

/** 定长字符串比较：避免逐字符短路泄漏令牌长度信息 */
function tokenEquals(provided) {
  if (!provided) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(ACCESS_TOKEN)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** 从三种常见位置取出令牌 */
function extractAccessToken(req) {
  const header = req.get('x-access-token')
  if (header) return String(header).trim()

  const auth = req.get('authorization')
  if (auth) {
    const raw = String(auth).trim()
    return raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw
  }

  return String(req.query.token || '').trim()
}

/** 鉴权中间件：挂在 /api 上，health 放行 */
function requireAccessToken(req, res, next) {
  if (!ACCESS_TOKEN) return next()
  if (req.path === '/health') return next()

  if (tokenEquals(extractAccessToken(req))) return next()

  log('WARN', `拒绝未授权请求：${req.method} ${req.originalUrl.split('?')[0]}（来自 ${req.ip}）`)
  return res.status(401).json({
    ok: false,
    authRequired: true,
    error: '缺少或错误的访问令牌：请带上 ?token=… 或请求头 x-access-token（值见 .env 的 ACCESS_TOKEN）'
  })
}

app.use('/api', requireAccessToken)

/**
 * 同一时间只允许一个 Agent 任务占用机器人，避免两路 SSE 抢 bot。
 *
 * 与旧版“忙就拒绝”的区别：现在新任务会 **抢占** 旧任务（abort + 掐断寻路/挖掘），
 * 然后等旧任务在 finally 里释放串行锁，再启动新的 —— 任意时刻仍然只有一个 run 在跑。
 */
let activeRun = null // { id, controller, message, finished, emit }
let runSeq = 0

/** 是否正在执行任务（/api/viewer 的提示文案要用） */
function isAgentBusy() {
  return Boolean(activeRun)
}

/**
 * 当前连接的 Minecraft 版本（未 spawn 时退回 .env 的 MC_VERSION）。
 * 用于给提示词注入“版本意识”：不同版本物品 ID 不同，模型必须知道自己站在哪一版。
 */
function currentGameVersion() {
  const bot = getBot()
  return (bot && bot.version) || String(process.env.MC_VERSION || '')
}

/**
 * 中断当前任务：先 abort（让循环退出），再掐底层动作（让机器人立刻停手）。
 *
 * @param {string} reason 日志用的人类可读原因
 * @param {string} [detail] 传给 AbortController 的原因文本（循环会用它区分“用户取消/危急中断”）
 * @returns {boolean} 是否真的中断了
 */
function abortActiveRun(reason = '用户中断', detail = '') {
  if (!activeRun) return false

  const id = activeRun.id
  // 只在有 detail 时传参：不传时 Node 会给出标准的 DOMException AbortError，
  // loop.js 用 typeof === 'string' 就能区分“用户取消”与“危急中断”。
  activeRun.controller.abort(detail ? detail : undefined)
  // abort 只能让循环在下一次检查时停下，pathfinder.goto 可能还要走几十秒，
  // 所以这里必须直接掐断底层动作，否则用户点了停止还得看它走完。
  interruptBotActions()
  log('HTTP', `已中断任务 #${id}（${reason}）`)
  return true
}

// ----------------------------------------------------------------------------
//  痛觉神经 → 脊髓反射
// ----------------------------------------------------------------------------
//  connection.js 在 health 事件与 500ms 巡检里发现残血/溺水/着火时广播危急事件，
//  这里负责“立刻动”：
//    1) 掐断底层动作（寻路、挖掘、按键）——不等模型同意
//    2) abort 当前 ReAct 循环（并把原因文本带进去）
//    3) 往正在看的 SSE 里推一条 warn ——用户必须马上知道发生了什么
//  之后（路由层）还会自动补一个保命回合，让模型真的去 escape_danger。
onCritical((info) => {
  const warnText = `${CRITICAL_ABORT_TAG}检测到${info.reason}，已强制停止当前任务！`

  // 没有任务在跑也要掐动作：机器人可能正停在岩浆边上继续挖
  if (!activeRun) {
    interruptBotActions()
    log('WARN', `${warnText}（当前无任务，仅停止底层动作）`)
    return
  }

  const run = activeRun
  try {
    run.emit('warn', { text: warnText, critical: true })
  } catch (err) {
    log('WARN', `推送危急警告失败（忽略）：${describeError(err)}`)
  }
  abortActiveRun(`危急事件：${info.reason}`, warnText)
})

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
const MAX_HISTORY_MESSAGES = 20 // 最多保留最近 20 条（重启后会从日志恢复同样数量）
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

// ----------------------------------------------------------------------------
//  记忆落盘（chat_history.log）
// ----------------------------------------------------------------------------
//  只有 RAM 的记忆，一重启就“失忆”，长任务很容易被打断在半路。
//  这里把每一轮完整的问答追加成一行 JSON（JSONL），启动时读回最近若干轮，
//  刷新页面 / 重启服务后 Agent 仍然记得“我们之前在做什么”。
//
//  为什么按“轮”而不是按“条”写：一轮 = 一条 user + 一条 assistant，原子性更好；
//  即使进程在写到一半时被 kill，最多丢一整行，不会留下孤立的半条。
const HISTORY_LOG = path.join(__dirname, '..', 'chat_history.log')
const HISTORY_LOG_MAX_BYTES = 2 * 1024 * 1024 // 超过 2MB 就压缩，防止无限增长
const HISTORY_LOG_KEEP_LINES = 200

/** 追加一轮问答（失败只告警，绝不影响主流程） */
function appendHistoryLog(user, assistant) {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), user, assistant }) + '\n'
    fs.appendFileSync(HISTORY_LOG, line, 'utf8')

    if (fs.statSync(HISTORY_LOG).size > HISTORY_LOG_MAX_BYTES) {
      const lines = fs
        .readFileSync(HISTORY_LOG, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-HISTORY_LOG_KEEP_LINES)
      fs.writeFileSync(HISTORY_LOG, lines.join('\n') + '\n', 'utf8')
      log('HTTP', `chat_history.log 超过 2MB，已压缩为最近 ${lines.length} 轮`)
    }
  } catch (err) {
    log('WARN', `写入 chat_history.log 失败（忽略）：${describeError(err)}`)
  }
}

/** 启动时从日志恢复最近的对话（格式坏了就跳过那一行，绝不阻塞启动） */
function restoreHistoryFromLog() {
  try {
    if (!fs.existsSync(HISTORY_LOG)) return

    const maxTurns = Math.ceil(MAX_HISTORY_MESSAGES / 2)
    const lines = fs
      .readFileSync(HISTORY_LOG, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxTurns)

    for (const line of lines) {
      try {
        const turn = JSON.parse(line)
        if (turn && turn.user) chatHistory.push({ role: 'user', content: String(turn.user) })
        if (turn && turn.assistant) chatHistory.push({ role: 'assistant', content: String(turn.assistant) })
      } catch (_) {
        /* 单行损坏：跳过，不影响后面的行 */
      }
    }

    trimHistory(chatHistory)
    if (chatHistory.length > 0) {
      log('HTTP', `已从 chat_history.log 恢复 ${chatHistory.length} 条对话记忆（上限 ${MAX_HISTORY_MESSAGES}）`)
    }
  } catch (err) {
    log('WARN', `读取 chat_history.log 失败（忽略）：${describeError(err)}`)
  }
}

restoreHistoryFromLog()

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
    // emit 也存进来：痛觉神经触发时要第一时间把 warn 推给正在看这条流的用户
    activeRun = { id: runId, controller, message, finished, emit: channel.emit }

    // ---- 可选：?reset=1 清空记忆，方便反复测试 ----
    if (req.query.reset === '1') {
      chatHistory.length = 0
      log('HTTP', '已清空对话记忆')
    }

    // ---- 1) 记录用户消息（追加，不覆盖）----
    chatHistory.push({ role: 'user', content: message })
    trimHistory(chatHistory) // 最多 MAX_HISTORY_MESSAGES 条（默认 20）

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
    let answer = await runAgent(message, channel.emit, {
      shouldStop: channel.isClosed,
      history,
      signal: controller.signal, // 用户点停止 / 被新指令覆盖 / 痛觉中断时，循环靠它退出
      // 显式传入，循环内部不再回落到启动常量；version 决定提示词里的“版本意识”
      systemPrompt: getSystemPrompt(requestPersonaId, { version: currentGameVersion() })
    })

    // ---- 4.5) 危急中断后的自动保命回合 ----
    //   被痛觉神经打断时，用户很可能不在屏幕前；如果只是回一句“任务已中断”，
    //   机器人就会站在原地继续溺水/继续烧。这里在**同一条 SSE** 里立刻补一轮
    //   3 步以内的救援，让模型真的调用 escape_danger，而不是把保命留给下一条指令。
    const abortReason = typeof controller.signal.reason === 'string' ? controller.signal.reason : ''
    const criticalAbort = abortReason.includes(CRITICAL_ABORT_TAG)

    if (criticalAbort && !channel.isClosed()) {
      const state = readSurvivalState(getBot())

      if (state.available && state.critical) {
        channel.emit('warn', { text: `危险尚未解除（${state.reason}），正在自动执行保命动作…` })
        log('AGENT', `紧急中断后进入保命回合：${state.reason}`)

        try {
          answer = await runAgent(RESCUE_INSTRUCTION, channel.emit, {
            // 用户发新指令抢占时 activeRun.id 会变，这里能立刻退出，不会赖着不放手
            shouldStop: () => channel.isClosed() || !activeRun || activeRun.id !== runId,
            history,
            systemPrompt: getSystemPrompt(requestPersonaId, { version: currentGameVersion() }),
            maxSteps: 3
          })
        } catch (err) {
          log('ERROR', `保命回合执行失败（保留中断结论）：${describeError(err)}`)
        }
      }
    }

    // ---- 5) 保存模型回复（客户端提前断开就不存，避免污染记忆）----
    if (!channel.isClosed() && answer) {
      chatHistory.push({ role: 'assistant', content: answer })
      trimHistory(chatHistory)
      // 同时落盘：刷新页面 / 重启服务后仍能接着聊（失败只告警，不影响本轮结果）
      appendHistoryLog(message, answer)
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

/** 健康检查：排查机器人是否在线（不校验令牌，前端要先用它探活 + 取 viewer 地址） */
app.get('/api/health', (req, res) => {
  const bot = getBot()

  res.json({
    ok: true,
    botReady: isReady(),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    persona: currentPersonaId,
    // 当前连接版本（未 spawn 时可能为空）+ 版本自检结果（前端据此提示“合成表可能显示异常”）
    version: (bot && bot.version) || process.env.MC_VERSION || '',
    gameData: getVersionCheck(),
    // 前端据此决定“要不要先问用户要令牌”，避免一开始就吃到一堆 401
    authRequired: Boolean(ACCESS_TOKEN),
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

  if (ACCESS_TOKEN) {
    log('HTTP', '访问令牌已启用：面板首次打开需输入 .env 里的 ACCESS_TOKEN')
  } else {
    log('WARN', '未设置 ACCESS_TOKEN：任何能访问本端口的人都可以指挥机器人，建议在 .env 中补上')
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
