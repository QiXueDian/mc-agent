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
const { waitForSpawn, isReady, disconnect } = require('./bot/connection')
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
app.use(express.static(path.join(__dirname, '..', 'public')))

/** 同一时间只允许一个 Agent 任务占用机器人，避免两路 SSE 抢 bot */
let agentBusy = false

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

  log('HTTP', `收到指令：${message || '(空)'}`)

  try {
    // ---- 入参校验 ----
    if (!message) {
      channel.emit('error', { text: '缺少 message 参数，请使用 /api/agent?message=你的指令' })
      return
    }
    if (agentBusy) {
      channel.emit('warn', { text: '机器人正在处理上一个任务，请稍后再试' })
      return
    }

    agentBusy = true

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

    // ---- 3) 确保机器人已进入游戏 ----
    if (!isReady()) {
      channel.emit('warn', { text: '机器人还没进入游戏，正在等待 spawn…' })
      await waitForSpawn()
    }

    // ---- 3.5) 可选：?persona=worker|tsundere|chunibyo 临时换人格（方便对比三个版本）----
    //     不传则用 .env 里 AGENT_PERSONA 指定的默认人格；传错值只警告、不中断任务。
    const personaKey = String(req.query.persona || '').trim().toLowerCase()
    const personaOverride = isPersona(personaKey) ? getSystemPrompt(personaKey) : undefined
    if (personaKey && !personaOverride) {
      channel.emit('warn', { text: `未知人格 "${personaKey}"，本次沿用默认人格 ${ACTIVE_PERSONA}` })
    } else if (personaOverride) {
      log('HTTP', `本次请求使用人格：${personaKey}`)
    }

    // ---- 4) 交给 Agent 循环：唯一的耦合点就是 emit 这个函数 ----
    const answer = await runAgent(message, channel.emit, {
      shouldStop: channel.isClosed,
      history,
      systemPrompt: personaOverride // undefined → 循环内部自动回落到默认人格
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
    agentBusy = false
    channel.close()
  }
})

/** 查看当前对话记忆（调试用；也可以用来确认“目标没丢”） */
app.get('/api/history', (req, res) => {
  res.json({ max: MAX_HISTORY_MESSAGES, count: chatHistory.length, messages: chatHistory })
})

/** 人格清单：前端下拉框 / 手动对比时用 */
app.get('/api/personas', (req, res) => {
  res.json({ active: ACTIVE_PERSONA, personas: listPersonas() })
})

/** 健康检查：排查机器人是否在线 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    botReady: isReady(),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    persona: ACTIVE_PERSONA
  })
})

// ------------------------------ 3. 启动与退出 ------------------------------
const server = app.listen(SERVER_PORT, () => {
  log('HTTP', `Web 服务已启动：http://localhost:${SERVER_PORT}`)
  // connection.js 在 require 时已开始连接，这里只是提示
  log('HTTP', '机器人连接由 src/bot/connection.js 维护（断线自动重连）')
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
