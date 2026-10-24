/**
 * ============================================================================
 *  src/agent/loop.js —— ReAct 循环（项目核心，唯一持有“思考-行动-观察”逻辑）
 * ----------------------------------------------------------------------------
 *  职责边界（单一职责原则）：
 *    本文件只负责：组织对话历史 → 调用大模型 → 分发工具 → 防死循环 → 返回结论
 *    不负责：HTTP / SSE 连接管理（server.js）、机器人连接（bot/connection.js）、
 *            具体动作实现（agent/tools.js）
 *
 *  对外的唯一出口：
 *    await runAgent(userMessage, sendSSE, options)
 *      userMessage : 用户的一句话指令
 *      sendSSE     : (type, data) => void，把每一步推给前端/终端（解耦关键）
 *      options     : { bot?, maxSteps?, shouldStop? }
 *      return      : Promise<string> 最终自然语言回复
 *
 *  sendSSE 的 type 约定（前端按这个上色）：
 *    start / step / thought / action / observe / warn / error / done
 *
 *  被重构保护的两处逻辑（禁止改动）：
 *    1) MAX_STEPS 步数上限
 *    2) 连续相同工具调用的拦截：第 2 次警告并跳过，第 3 次强制终止
 * ============================================================================
 */

require('dotenv').config()

const OpenAI = require('openai')

const { toolDefinitions, executeTool } = require('./tools')
const { getBot } = require('../bot/connection')
const { log, sleep, describeError, cleanContent, hasSpecialToken } = require('./utils')

// ------------------------------ 1. 配置 ------------------------------
const AI_CONFIG = {
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  temperature: Number(process.env.AI_TEMPERATURE || 0.3),
  timeout: Number(process.env.AI_TIMEOUT || 120000)
}

/** ReAct 最大步数（防止模型反复调用同一工具） */
const MAX_STEPS = Number(process.env.MAX_STEPS || 8)

/** 防死循环护栏：连续相同调用第 2 次警告，第 3 次强制终止 */
const GUARD_WARN_AT = 2
const GUARD_BREAK_AT = 3

/** 护栏命中时插给模型的警告文案（作为 role: 'tool' 的内容） */
const LOOP_WARNING_TEXT =
  '⚠️ 你似乎陷入了死循环：刚才已经用完全相同的参数调用过这个工具。' +
  '请不要重复调用相同的工具，先调用 get_status 检查背包和坐标，或者直接向用户汇报当前进展。'

// ------------------------------ 人格提示词 ------------------------------
// 三个版本（worker / tsundere / chunibyo）全部放在 personas.js：
//   人格（魂：称呼、口头禅、吐槽方式） + 能力内核（CORE：工具清单、任务拆解、ReAct 纪律）。
// 换人格只换魂，能力永远一致 —— 新增工具只需要改 personas.js 里的 CORE 一处。
const { getSystemPrompt, isPersona, DEFAULT_PERSONA } = require('./personas')

/**
 * 当前默认人格：AGENT_PERSONA=worker | tsundere | chunibyo
 * 没配、配错都回落到 DEFAULT_PERSONA（worker = 幽默的赛博打工人），
 * 这样日志里显示的人格永远是真实生效的那个，不会出现“写着 chunibyo 其实跑的是 worker”。
 */
const ACTIVE_PERSONA = isPersona(process.env.AGENT_PERSONA)
  ? String(process.env.AGENT_PERSONA).trim().toLowerCase()
  : DEFAULT_PERSONA

/** 默认系统提示词（保留同名导出，server.js / brain.js 一行都不用改） */
const SYSTEM_PROMPT = getSystemPrompt(ACTIVE_PERSONA)

// ------------------------------ 2. 大模型客户端（懒加载） ------------------------------
let client = null

/** 懒创建 OpenAI 客户端：缺少 key 时抛出可读错误，由 runAgent 统一兜底并推给前端 */
function getClient() {
  if (!AI_CONFIG.apiKey || AI_CONFIG.apiKey === 'sk-xxxxxxxxxxxxxxxx') {
    throw new Error('没有检测到有效的 DEEPSEEK_API_KEY，请先在 .env 中配置（参考 .env.example）')
  }
  if (!client) {
    client = new OpenAI({
      apiKey: AI_CONFIG.apiKey,
      baseURL: AI_CONFIG.baseURL,
      timeout: AI_CONFIG.timeout,
      maxRetries: 2 // 网络抖动自动重试，不把错误直接抛进循环
    })
  }
  return client
}

// ------------------------------ 3. 协议层小工具（只服务本文件） ------------------------------
/** 安全解析 tool_call.function.arguments（JSON 字符串），失败不抛异常 */
function safeParseArgs(rawArguments) {
  if (rawArguments === undefined || rawArguments === null) return { args: {}, error: null }
  const raw = String(rawArguments).trim()
  if (raw === '') return { args: {}, error: null } // 无参数工具（get_status）
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { args: {}, error: null }
    return { args: parsed, error: null }
  } catch (err) {
    return { args: {}, error: `参数不是合法 JSON：${raw}` }
  }
}

/** 稳定序列化：key 排序后再字符串化，避免 {"a":1,"b":2} 与 {"b":2,"a":1} 被当成两次不同调用 */
function stableStringify(value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 工具调用指纹：工具名 + 规范化参数，用于护栏比对 */
function callSignature(toolName, args) {
  return `${toolName}:${stableStringify(args)}`
}

/** 规范化 assistant 消息：只回传 id / type / function 三个标准字段 */
function normalizeAssistantMessage(message) {
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

  const toolCalls = rawCalls.map((call, index) => ({
    id: call.id || `call_local_${Date.now()}_${index}`,
    type: 'function',
    function: {
      name: call.function?.name || '',
      arguments: call.function?.arguments ?? '{}'
    }
  }))

  const assistantMessage = { role: 'assistant', content: message.content || '' }
  if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls

  return { assistantMessage, toolCalls }
}

// ------------------------------ 4. 多轮记忆 ------------------------------
/** 最多向模型回放多少条历史（服务端一般已裁到 7 条，这里是独立兜底） */
const MAX_HISTORY_MESSAGES = 14

/**
 * 清洗外部传入的历史记录。
 *
 * 只接受 role 为 user / assistant 的纯文本消息：
 *   - 绝不信任外部传进来的 tool / assistant(tool_calls) 消息，否则 tool_call_id
 *     配对不上，接口直接 400；
 *   - 过滤空内容，单条截断到 2000 字，防止历史里塞进巨大文本撑爆 token；
 *   - 只保留最近若干条，并且必须**以 user 开头**，否则会出现“孤立的 assistant 回复”。
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return []

  const cleaned = history
    .filter(
      (msg) =>
        msg &&
        (msg.role === 'user' || msg.role === 'assistant') &&
        typeof msg.content === 'string' &&
        msg.content.trim() !== ''
    )
    .map((msg) => ({ role: msg.role, content: String(msg.content).slice(0, 2000) }))

  const recent = cleaned.slice(-MAX_HISTORY_MESSAGES)
  while (recent.length > 0 && recent[0].role !== 'user') recent.shift()

  return recent
}

// ------------------------------ 5. ReAct 主循环 ------------------------------
/**
 * 跑一次完整的 ReAct 循环。
 *
 * messages 的累积顺序（Agent 的短期记忆）：
 *   [system] → [user] → [assistant(tool_calls)] → [tool] → ... → [assistant(纯文本)]
 * 注意：assistant(tool_calls) 必须先入栈，且每个 tool_call 都要有一条 role=tool
 * 与之配对（tool_call_id 一致），否则下一轮请求会 400。
 *
 * @param {string}   userMessage 用户指令
 * @param {function} sendSSE     (type, data) => void
 * @param {object}   options     { bot, maxSteps, shouldStop, history, trace, systemPrompt }
 *                               systemPrompt：单次请求的人格覆盖（不传则用 AGENT_PERSONA 指定的默认人格）
 * @returns {Promise<string>}    最终回复文本
 */
async function runAgent(userMessage, sendSSE, options = {}) {
  const {
    maxSteps = MAX_STEPS,
    shouldStop = () => false,
    bot = null,
    history = [],
    // 人格提示词：默认取当前人格（幽默的赛博打工人），可由 server.js 按请求覆盖
    systemPrompt = SYSTEM_PROMPT
  } = options

  // 统一的推送包装：SSE 通道异常不应该影响 Agent 循环本身
  const emit = (type, data = {}) => {
    try {
      return sendSSE(type, data)
    } catch (err) {
      log('WARN', `推送 SSE 失败（忽略）：${describeError(err)}`)
      return false
    }
  }

  // 终端追踪开关：Web 端默认打开（服务台可观察）；CLI 端由自己的 emitter 打印，
  // 传 trace:false 关掉，避免同一句话打印两遍。
  const trace = options.trace !== false
  const tlog = trace ? log : () => {}

  const instruction = String(userMessage || '').trim()
  if (!instruction) {
    emit('error', { text: '指令不能为空' })
    return '指令不能为空'
  }

  const botInstance = bot || getBot()

  // ---- 5.1 初始化对话历史（system + 多轮记忆 + 本轮用户消息） ----
  // 历史只放纯文本 user/assistant，工具往返（tool_calls / role:tool）只在本轮内有效，
  // 跨轮保存会让 tool_call_id 对不上，接口会 400。
  const historyMessages = sanitizeHistory(history)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: instruction }
  ]

  emit('start', { text: `收到指令：${instruction}` })
  tlog('AGENT', `收到指令：${instruction}（携带 ${historyMessages.length} 条历史记忆）`)

  let finalAnswer = ''
  let taskFinished = false
  let abortedByGuard = false

  // 护栏计数器：上一次调用的指纹 + 连续重复次数（跨步累加）
  let lastSignature = null
  let repeatCount = 0

  // ---- 4.2 步数受控的循环 ----
  for (let step = 1; step <= maxSteps; step++) {
    if (shouldStop()) {
      tlog('AGENT', '客户端已断开，提前结束循环')
      return finalAnswer || '（客户端已断开连接，任务中止）'
    }

    emit('step', { step, maxSteps, text: `第 ${step}/${maxSteps} 步思考` })
    tlog('LOOP', `=========== 第 ${step}/${maxSteps} 步思考 ===========`)

    // 4.2.1 请求大模型
    let response
    try {
      response = await getClient().chat.completions.create({
        model: AI_CONFIG.model,
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto',
        temperature: AI_CONFIG.temperature
      })
    } catch (err) {
      emit('error', { step, text: `第 ${step} 步请求大模型失败：${describeError(err)}` })
      tlog('ERROR', `第 ${step} 步请求大模型失败：${describeError(err)}`)
      break
    }

    const message = response?.choices?.[0]?.message
    if (!message) {
      emit('error', { step, text: `第 ${step} 步模型返回为空，终止任务` })
      break
    }

    // 4.2.2 规范化响应
    const { assistantMessage, toolCalls } = normalizeAssistantMessage(message)
    const thought = cleanContent(message.content)

    if (hasSpecialToken(message.content)) {
      emit('warn', { step, text: '检测到正文混入特殊 token（如 <||DSML||>），已自动清洗' })
    }
    if (thought) {
      emit('thought', { step, text: thought })
      tlog('THOUGHT', thought)
    }

    // 4.2.3 没有工具调用 => 任务完成
    if (toolCalls.length === 0) {
      finalAnswer = thought || '（模型没有给出文本回复）'
      messages.push({ role: 'assistant', content: message.content || '' })
      taskFinished = true
      tlog('DONE', `第 ${step} 步模型不再调用工具，任务结束`)
      break
    }

    // 4.2.4 assistant(tool_calls) 先行入栈
    messages.push(assistantMessage)

    // 4.2.5 逐个执行工具（用带下标的 for：护栏命中时要给剩下的 tool_call 补占位消息）
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const toolName = call.function.name
      const { args, error: parseError } = safeParseArgs(call.function.arguments)

      // ==================== 防死循环护栏 ====================
      const signature = callSignature(toolName, parseError ? String(call.function.arguments ?? '') : args)

      if (signature === lastSignature) {
        repeatCount += 1
      } else {
        lastSignature = signature
        repeatCount = 1
      }

      // 连续 3 次完全相同 → 强制终止
      if (repeatCount >= GUARD_BREAK_AT) {
        abortedByGuard = true
        tlog('GUARD', `连续 ${repeatCount} 次相同调用（${signature}），强制终止循环`)
        emit('error', {
          step,
          text: `检测到连续 ${repeatCount} 次调用同一个工具（${toolName}）且参数完全相同，已强制终止任务`
        })

        // 当前及后续每个 tool_call 都必须有对应的 tool 消息，否则消息结构不合法
        for (let j = i; j < toolCalls.length; j++) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCalls[j].id,
            name: toolCalls[j].function.name,
            content: '本次调用未执行：任务已因“重复调用同一个工具”被强制终止。'
          })
        }
        break
      }

      // 连续 2 次完全相同 → 不执行，插入警告（用 role: 'tool' 保证与 tool_call_id 配对）
      if (repeatCount >= GUARD_WARN_AT) {
        tlog('GUARD', `第 ${repeatCount} 次相同调用（${signature}），已跳过并插入警告`)
        emit('warn', { step, text: `检测到重复调用 ${toolName}，已跳过执行并向模型发出警告` })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: toolName,
          content: LOOP_WARNING_TEXT
        })
        continue
      }
      // ==================== 护栏结束，正常执行 ====================

      emit('action', { step, tool: toolName, args, text: `${toolName}(${JSON.stringify(args)})` })
      tlog('ACT', `执行 ${toolName}(${JSON.stringify(args)})`)

      let toolResult
      if (parseError) {
        toolResult = `${parseError}。请重新生成符合 JSON Schema 的参数后再调用。`
      } else {
        try {
          // executeTool 内部已兜底，这里再包一层，异常绝不冒泡到循环
          toolResult = await executeTool(botInstance, toolName, args)
        } catch (err) {
          toolResult = `工具 ${toolName} 执行异常：${describeError(err)}`
        }
      }
      toolResult = String(toolResult ?? '')

      emit('observe', { step, tool: toolName, text: toolResult })
      tlog('OBSERVE', `[${step}] ${toolName} -> ${toolResult}`)

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: toolName,
        content: toolResult
      })
    }

    if (abortedByGuard) break

    await sleep(200) // 轻微节流，避免连续请求触发限流
  }

  // ---- 4.3 被护栏终止：兜底回复，不再请求大模型 ----
  if (abortedByGuard) {
    finalAnswer =
      '⚠️ 检测到模型陷入重复调用循环，已强制终止本轮任务。可以换个说法再试，或先让机器人移动到别的区域。'
  }

  // ---- 4.4 达到最大步数：警告 + 一次“只能说话”的收尾请求 ----
  if (!taskFinished && !abortedByGuard) {
    emit('warn', { text: `已达到最大步数 ${maxSteps}，任务可能未完成，正在生成总结…` })
    try {
      // 不传 tools，模型无从产生 tool_calls，只能输出自然语言总结
      const wrapUp = await getClient().chat.completions.create({
        model: AI_CONFIG.model,
        messages,
        temperature: AI_CONFIG.temperature
      })
      const wrapUpText = cleanContent(wrapUp?.choices?.[0]?.message?.content)
      if (wrapUpText) finalAnswer = wrapUpText
    } catch (err) {
      emit('error', { text: `收尾请求失败：${describeError(err)}` })
    }
    if (!finalAnswer) finalAnswer = '（达到最大步数，任务未能完成，也没有拿到总结）'
  }

  return finalAnswer
}

module.exports = {
  runAgent,
  SYSTEM_PROMPT,
  ACTIVE_PERSONA,
  MAX_STEPS
}
