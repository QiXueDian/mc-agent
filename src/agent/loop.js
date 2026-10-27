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
const { getBot, onDeath, interruptBotActions } = require('../bot/connection')
const { log, sleep, describeError, cleanContent, hasSpecialToken } = require('./utils')
const { readSurvivalState, formatSurvivalLine, buildSurvivalAlert } = require('./survival')
const {
  safeParseArgs,
  callSignature,
  normalizeAssistantMessage,
  looksLikeToolText,
  parsePseudoToolCalls
} = require('./protocol')
const { sanitizeHistory, attachSurvivalLine } = require('./history')

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

/** 格式错误时注入给模型的纠错提示（role: user，兼容性最好） */
const TOOL_FORMAT_CORRECTION = '格式错误，请使用标准的 tool_calls 功能，不要在正文输出特殊标签。'

/** 同一轮内允许的纠错次数；超过即熔断，避免把 8 步配额全耗在“重写格式”上 */
const MAX_RECOVERY = Number(process.env.MAX_RECOVERY || 2)

/** 格式彻底错乱时的兜底话术（前端 done 事件只显示这一句） */
const FORMAT_BREAK_TEXT = '（系统提示：AI 格式错乱，已强制中断任务，请重试或换一种指令方式）'

/** 收尾请求前的硬约束：任务已结束，只准说人话 */
const WRAP_UP_INSTRUCTION =
  '任务已结束，严禁输出任何 XML、特殊符号或伪工具调用，只输出纯文本总结。'

/** 收尾文本仍不干净时的安全话术（绝不把脏文本塞进 done 事件） */
const WRAP_UP_SAFE_TEXT =
  '（系统提示：AI 收尾输出格式错乱，已丢弃原始总结。任务可能未完成，请重试或换个说法）'

/**
 * 用户主动中断的固定答复。
 * 刻意不返回“半截结果”：被中断的任务往往只做了一半，写进多轮记忆会污染后续推理。
 */
const USER_ABORT_TEXT = '（任务已被用户取消）'

/** 死亡后注入的系统通知：让模型知道“进度全废、自己在重生点” */
const DEATH_NOTICE_TEXT =
  '【系统通知】你刚刚死亡并在重生点复活，之前的任务进度全部作废（掉落物可能还留在死亡地点）。' +
  '请先确认自己的位置和状态，再决定是否继续或重新规划。'

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

/**
 * 当前 run 注册的死亡监听注销函数。
 * server.js 用串行锁保证同一时刻只有一个 run，所以用模块级单值就够；
 * 万一有并发（例如测试直接调 runAgent），后一个 run 会先卸掉前一个，不会泄漏。
 */
let detachDeathListener = null

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

  // ---- 5.0 中断信号与死亡监听 ----
  // signal 由 server.js 的 AbortController 提供；不传时退化为纯 shouldStop 模式（CLI 用）。
  const signal = options.signal || null
  const isAborted = () => Boolean(signal && signal.aborted === true)

  // 死亡信息先落到本地变量，等**下一次步开始时**才动上下文 ——
  // 那两个请求之间是唯一安全的边界：此时上一条 tool 消息已配对完整，
  // 中途插入或删除消息都会造成 tool_call_id 对不上，DeepSeek 直接 400。
  let pendingDeath = null
  detachDeathListener = onDeath((info) => {
    pendingDeath = info
  })

  /** 统一的收尾出口：必须注销死亡监听，否则监听器会随轮次累积 */
  const finish = (answer) => {
    if (detachDeathListener) {
      detachDeathListener()
      detachDeathListener = null
    }
    return answer
  }

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
  let abortedByFormat = false // 伪工具调用连续无法解析 → 熔断
  let abortedByUser = false // 用户点了停止 / 发了新指令

  // 护栏计数器：上一次调用的指纹 + 连续重复次数（跨步累加）
  let lastSignature = null
  let repeatCount = 0

  // 伪调用统计：成功抢救次数 / 解析失败次数（失败达到 MAX_RECOVERY 就停）
  let recoveredCount = 0
  let malformedCount = 0

  // 最近一次“生存危急原因”：用于去重，避免同一个原因在每步都推一条 user 消息
  let lastSurvivalReason = ''

  // ---- 4.2 步数受控的循环 ----
  for (let step = 1; step <= maxSteps; step++) {
    if (shouldStop()) {
      tlog('AGENT', '客户端已断开，提前结束循环')
      return finish(finalAnswer || '（客户端已断开连接，任务中止）')
    }

    // 4.1.5 用户点了“停止生成”：先掐掉底层动作（寻路/挖掘），再退出
    if (isAborted()) {
      interruptBotActions()
      tlog('AGENT', `第 ${step} 步检测到用户中断，终止任务`)
      emit('warn', { step, text: '任务已被用户取消' })
      return finish(USER_ABORT_TEXT)
    }

    // 4.1.6 死亡：在“两个请求之间”这个安全边界重置上下文
    //   只保留 system + 本轮用户指令，丢掉全部 tool 往返（它们已经配对完整，整段删是合法的），
    //   否则残留在上下文里会让模型以为上一个任务还在继续。
    if (pendingDeath) {
      const info = pendingDeath
      pendingDeath = null

      const instructionMessage = { role: 'user', content: instruction }
      messages.length = 1
      messages.push(instructionMessage, { role: 'user', content: DEATH_NOTICE_TEXT })

      lastSignature = null
      repeatCount = 0
      recoveredCount = 0
      malformedCount = 0
      lastSurvivalReason = ''

      emit('death', {
        step,
        text: `机器人死亡（位置 ${info.position}），已在重生点复活，之前的任务进度作废`
      })
      tlog('WARN', `[DEATH] 第 ${step} 步检测到死亡，已重置上下文与护栏计数`)
    }

    emit('step', { step, maxSteps, text: `第 ${step}/${maxSteps} 步思考` })
    tlog('LOOP', `=========== 第 ${step}/${maxSteps} 步思考 ===========`)

    // 4.2.0 生存巡检：每步请求前把真实生存状态喂给模型
    //   常态 → 拼到最后一条 role:tool 消息末尾（不新增消息、不涨 token 条数）
    //   危急 → 额外补一条 role:user 的硬指令（同一原因只推一次，避免 8 步刷 8 条）
    const survival = readSurvivalState(botInstance)
    if (survival.available) {
      const line = formatSurvivalLine(survival)
      attachSurvivalLine(messages, line)
      tlog('LOOP', `[SURVIVAL] ${line}`)

      if (survival.critical && survival.reason !== lastSurvivalReason) {
        lastSurvivalReason = survival.reason
        messages.push({ role: 'user', content: buildSurvivalAlert(survival) })
        emit('warn', { step, text: `生存告警：${survival.reason}` })
      } else if (!survival.critical) {
        lastSurvivalReason = ''
      }
    }

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
    let { assistantMessage, toolCalls } = normalizeAssistantMessage(message)
    const thought = cleanContent(message.content)

    if (hasSpecialToken(message.content)) {
      emit('warn', { step, text: '检测到正文混入特殊 token（如 <||DSML||>），已自动清洗' })
    }
    if (thought) {
      emit('thought', { step, text: thought })
      tlog('THOUGHT', thought)
    }

    // 4.2.2.5 伪工具调用抢救：模型把 tool_calls 写进了正文（DSML / XML / Markdown JSON）
    //   命中后绝不能当最终答复 —— 那是“既没执行、又给用户看乱码”。
    if (toolCalls.length === 0 && looksLikeToolText(message.content)) {
      const recovered = parsePseudoToolCalls(message.content)

      if (recovered.length > 0) {
        recoveredCount += 1
        toolCalls = recovered.map((call, index) => ({
          id: `call_recovered_${step}_${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) }
        }))
        assistantMessage.tool_calls = toolCalls
        assistantMessage.content = '' // 不把 XML 文本回灌，避免模型自我强化

        emit('warn', {
          step,
          text: `检测到正文里的伪工具调用，已抢救为本地执行：${toolCalls
            .map((call) => call.function.name)
            .join('、')}`
        })
        tlog(
          'GUARD',
          `[RECOVER] 第 ${step} 步从正文抢救出 ${toolCalls.length} 个调用（累计第 ${recoveredCount} 次抢救）`
        )
        tlog(
          'DIAG',
          `model=${AI_CONFIG.model} finish_reason=${response?.choices?.[0]?.finish_reason} ` +
            `片段=${String(message.content || '').slice(0, 120)}`
        )
      } else {
        malformedCount += 1
        emit('warn', {
          step,
          text: `第 ${malformedCount}/${MAX_RECOVERY} 次工具调用格式错误，已要求模型按标准格式重写`
        })
        tlog(
          'DIAG',
          `[MALFORMED] model=${AI_CONFIG.model} finish_reason=${response?.choices?.[0]?.finish_reason} ` +
            `片段=${String(message.content || '').slice(0, 120)}`
        )

        // 纠错提示用 user 注入；脏的 assistant 文本不进上下文（否则模型会照着抄）
        messages.push({ role: 'user', content: TOOL_FORMAT_CORRECTION })

        if (malformedCount >= MAX_RECOVERY) {
          abortedByFormat = true
          emit('error', { step, text: '模型连续输出畸形工具调用，已强制中断任务' })
          break
        }
        continue
      }
    }

    // 4.2.3 没有工具调用 => 任务完成
    if (toolCalls.length === 0) {
      // 最终出口校验：走到这里说明抢救没成功（或脏文本不属于可抢救形态），
      // 但只要正文还带 DSML/伪调用特征，就绝不能当“正常回复”返回。
      const dirtyFinal =
        hasSpecialToken(message.content) ||
        looksLikeToolText(message.content) ||
        hasSpecialToken(thought) ||
        looksLikeToolText(thought)

      if (dirtyFinal) {
        abortedByFormat = true
        finalAnswer = FORMAT_BREAK_TEXT
        taskFinished = true
        emit('warn', { step, text: '最终回复仍含特殊标签/伪工具调用，已拦截，不会显示给用户' })
        tlog(
          'GUARD',
          `[FINAL-GUARD] 第 ${step} 步最终回复被拦截：片段=${String(message.content || '').slice(0, 120)}`
        )
        break
      }

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

      // 用户中断：当前及后续每个 tool_call 都必须补占位消息，
      // 否则 assistant(tool_calls) 里会有“孤儿 call”，下一轮请求直接 400。
      if (isAborted()) {
        interruptBotActions()
        for (let j = i; j < toolCalls.length; j++) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCalls[j].id,
            name: toolCalls[j].function.name,
            content: '本次调用未执行：用户已取消任务。'
          })
        }
        abortedByUser = true
        tlog('AGENT', `第 ${step} 步工具执行前被中断，已为剩余 ${toolCalls.length - i} 个调用补占位消息`)
        break
      }

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

    // 工具执行期间被中断（比如 pathfinder 走到一半用户点了停止）
    if (abortedByUser || isAborted()) {
      interruptBotActions()
      emit('warn', { step, text: '任务已被用户取消' })
      return finish(USER_ABORT_TEXT)
    }

    if (abortedByGuard) break

    await sleep(200) // 轻微节流，避免连续请求触发限流
  }

  // ---- 4.3 被护栏终止：兜底回复，不再请求大模型 ----
  if (abortedByGuard) {
    finalAnswer =
      '⚠️ 检测到模型陷入重复调用循环，已强制终止本轮任务。可以换个说法再试，或先让机器人移动到别的区域。'
  }

  // ---- 4.3.5 被格式熔断：给一句人话，别让用户看到一堆标签 ----
  if (abortedByFormat) {
    finalAnswer = FORMAT_BREAK_TEXT
  }

  // ---- 4.4 达到最大步数：警告 + 一次“只能说话”的收尾请求 ----
  if (!taskFinished && !abortedByGuard && !abortedByFormat) {
    emit('warn', { text: `已达到最大步数 ${maxSteps}，任务可能未完成，正在生成总结…` })
    try {
      // 第一重保险（约束注入）：不写死这条，模型会照着前面 N 轮的 DSML 上下文继续吐标签。
      // 光靠“不传 tools”是不够的 —— 不传 tools 只禁掉了标准 tool_calls，禁不掉正文方言。
      messages.push({ role: 'user', content: WRAP_UP_INSTRUCTION })

      const wrapUp = await getClient().chat.completions.create({
        model: AI_CONFIG.model,
        messages,
        temperature: AI_CONFIG.temperature
      })

      const rawText = String(wrapUp?.choices?.[0]?.message?.content || '')

      // 第二重保险（双重校验）：
      //   ① 原始文本里是否藏着可执行的伪工具调用 → 命中就丢弃，绝不执行；
      //   ② 清洗后的文本是否仍有残留标签 → 命中就替换为安全话术。
      const rescued = rawText ? parsePseudoToolCalls(rawText) : []
      const cleaned = cleanContent(rawText)
      const stillDirty = hasSpecialToken(cleaned) || looksLikeToolText(cleaned)

      if (rescued.length > 0) {
        tlog(
          'GUARD',
          `[WRAP-UP] 收尾文本含伪工具调用（${rescued.map((call) => call.name).join('、')}），已丢弃且未执行`
        )
        emit('warn', { text: '收尾总结仍试图调用工具，已丢弃并替换为安全提示' })
        finalAnswer = WRAP_UP_SAFE_TEXT
      } else if (stillDirty) {
        tlog('GUARD', `[WRAP-UP] 收尾文本含特殊标签，已替换为安全提示：片段=${rawText.slice(0, 120)}`)
        emit('warn', { text: '收尾总结仍含特殊标签，已替换为安全提示' })
        finalAnswer = WRAP_UP_SAFE_TEXT
      } else if (cleaned) {
        finalAnswer = cleaned
      }
    } catch (err) {
      emit('error', { text: `收尾请求失败：${describeError(err)}` })
    }
    if (!finalAnswer) finalAnswer = '（达到最大步数，任务未能完成，也没有拿到总结）'
  }

  return finish(finalAnswer)
}

module.exports = {
  runAgent,
  ACTIVE_PERSONA,
  // 以下仅用于单元测试与诊断（test/dsml-guard.test.js 依赖前两个），不要在生产代码里依赖
  parsePseudoToolCalls,
  looksLikeToolText
}
