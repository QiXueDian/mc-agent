/**
 * ============================================================================
 *  src/agent/protocol.js —— 协议层（纯函数，无 IO、无状态）
 * ----------------------------------------------------------------------------
 *  职责：把「模型吐出来的东西」翻译成「可执行/可回话的东西」
 *    - tool_call.function.arguments 的安全解析
 *    - assistant 消息规范化（tool_calls 只保留标准三字段）
 *    - 正文伪工具调用（DSML / XML / Markdown JSON）的检测、抢救与 Schema 校验
 *
 *  被搬迁自 loop.js（A2 步骤），函数体逐字节未改。
 *  loop.js 仍然是唯一出口，并在自身重新导出 parsePseudoToolCalls / looksLikeToolText。
 * ============================================================================
 */

const { log, DSML_OPEN, DSML_CLOSE, DSML_TEXT_RE } = require('./utils')
const { toolDefinitions } = require('./tools')

// ------------------------------ 1.1 伪工具调用（DSML/XML）防御 ------------------------------
/**
 * 畸形工具调用特征。
 * 有些模型会把内部方言写进正文，例如：
 *   <||invoke name="craft_item"><||parameter name="item_name">crafting_table</||parameter></||invoke>
 *   < | | calls> / <| |invoke> / < | | tool_calls> / function_call:
 * 这类文本绝不能当成最终答复，否则用户会看到一坨乱码，任务也真的没执行。
 *
 * 直接复用 utils.js 的 DSML 词法：门禁判据与清洗判据必须是同一套，
 * 否则会出现「洗得掉但识别不出」或「识别得出但洗不掉」的半吊子状态。
 */
const MALFORMED_TOOL_RE = DSML_TEXT_RE

/** 工具白名单：抢救出来的调用必须命中这里，防止模型编造工具名 */
const TOOL_NAME_SET = new Set(toolDefinitions.map((def) => def.function.name))

/** 工具参数 schema：用于校验抢救出来的参数，校验不过一律当解析失败 */
const TOOL_SCHEMA_MAP = new Map(toolDefinitions.map((def) => [def.function.name, def.function.parameters]))

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

// ------------------------------ 3.1 伪工具调用解析（抢救逻辑） ------------------------------
/** 正文里是否混入了伪工具调用（开放标签也算） */
function looksLikeToolText(text) {
  if (typeof text !== 'string' || text === '') return false
  return MALFORMED_TOOL_RE.test(text)
}

/** 把 XML 风格的值转成 JSON 可用类型：数字 / 布尔 / 对象数组 / 字符串 */
function coerceScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true'
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text)
  if (/^[[{][\s\S]*[\]}]$/.test(text)) {
    try {
      return JSON.parse(text)
    } catch (_) {
      return text
    }
  }
  return text
}

/**
 * name="x" 的通用写法：容忍属性顺序、单/双/全角引号、引号缺失、任意空白。
 * 由 DSML_OPEN 统一提供“标签头 + 竖线空白容忍”，这里只管属性部分。
 */
const DSML_NAME_ATTR = '[^<>]{0,120}?name\\s*=\\s*["\'“”]?([A-Za-z0-9_]+)["\'“”]?'

/** 成对的 < | | parameter name="x">value< / | | parameter> */
const PARAM_CLOSED_RE = new RegExp(
  `${DSML_OPEN}parameter\\b${DSML_NAME_ATTR}[^<>]{0,80}>([\\s\\S]*?)${DSML_CLOSE}parameter\\b[^<>]{0,120}>`,
  'gi'
)

/** 未闭合的 < | | parameter name="x">value（模型输出被截断） */
const PARAM_LOOSE_RE = new RegExp(
  `${DSML_OPEN}parameter\\b${DSML_NAME_ATTR}[^<>]{0,80}>([^<]*)`,
  'gi'
)

/** invoke 开标签的切分点：< | | invoke name= */
const INVOKE_SPLIT_RE = new RegExp(`${DSML_OPEN}invoke\\b[^<>]{0,120}?name\\s*=\\s*`, 'i')

/** 解析一个 invoke 体内的全部 parameter */
function parseParameterBlock(block) {
  const args = {}
  let match

  PARAM_CLOSED_RE.lastIndex = 0
  while ((match = PARAM_CLOSED_RE.exec(block)) !== null) {
    args[match[1]] = coerceScalar(match[2])
  }
  if (Object.keys(args).length > 0) return args

  // 兜底：标签没闭合（模型输出被截断）时，值取到下一个 < 或结尾
  PARAM_LOOSE_RE.lastIndex = 0
  while ((match = PARAM_LOOSE_RE.exec(block)) !== null) {
    args[match[1]] = coerceScalar(match[2])
  }
  return args
}

/**
 * 通道一：解析 `< | | invoke name="x">…< / | | invoke>` 这类正文方言。
 *
 * 输入：模型原始正文（可能夹着思考文字、多个 invoke、甚至半截标签）
 * 输出：`{ name, args }[]`；抓不到任何 invoke 时返回 `[]`（不代表出错，通道二会接手）
 *
 * 为什么用 split 而不是 exec 循环：
 *   模型输出经常被 max_tokens 截断，闭合标签直接消失。正则要求成对匹配就会整段丢掉，
 *   而 split 只依赖“开标签”，剩下的参数交给 parseParameterBlock 的 loose 路径兜。
 * 竖线之间/斜杠左右的空白全部由 DSML_OPEN、DSML_CLOSE 负责，本函数不重复处理。
 * 注意：这里**不做白名单与 Schema 校验**，那是 parsePseudoToolCalls 的职责。
 */
function parsePseudoCallsFromXml(text) {
  const chunks = String(text).split(INVOKE_SPLIT_RE)
  if (chunks.length < 2) return []

  const calls = []
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]
    const nameMatch = chunk.match(/^["'“”]?([A-Za-z0-9_]+)/)
    if (!nameMatch) continue
    calls.push({ name: nameMatch[1], args: parseParameterBlock(chunk) })
  }
  return calls
}

/**
 * 解析 Markdown / 裸 JSON 形式的伪调用。
 *
 * 防误伤三重判据（缺一不可）：
 *   1) 必须是对象，且带有 name / tool / function.name；
 *   2) 必须同时带 arguments / parameters / args 字段 —— 纯数据展示（{"player":"Steve"}）不算调用；
 *   3) name 必须在工具白名单里，否则整段丢弃。
 */
function parsePseudoCallsFromJson(text) {
  const candidates = []
  let match

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  while ((match = fence.exec(text)) !== null) candidates.push(match[1])

  const trimmed = String(text).trim()
  if (/^[[{]/.test(trimmed)) candidates.push(trimmed)

  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate.trim())
    } catch (_) {
      continue
    }

    const list = Array.isArray(parsed) ? parsed : [parsed]
    const calls = []

    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue

      const name = entry.name || entry.tool || (entry.function && entry.function.name) || ''

      // 没有工具名 → 这是普通数据，跳过（不能因为一段 JSON 就执行动作）
      if (typeof name !== 'string' || name === '') continue

      // 有工具名但不在白名单 → 整段丢弃（模型可能在编造工具）
      if (!TOOL_NAME_SET.has(name)) return []

      const rawArgs = entry.arguments ?? entry.parameters ?? entry.args ?? (entry.function && entry.function.arguments)
      if (rawArgs === undefined) continue // 没有参数载荷，按数据展示处理

      let args = rawArgs
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch (_) {
          args = {}
        }
      }
      calls.push({ name, args: args && typeof args === 'object' ? args : {} })
    }

    if (calls.length > 0) return calls
  }

  return []
}

/**
 * 用工具自带的 JSON Schema 校验“从正文里抢救出来的参数”。
 *
 * 输入：
 *   name — 工具名，必须命中 TOOL_SCHEMA_MAP（白名单）
 *   args — parsePseudoCallsFromXml / parsePseudoCallsFromJson 产出的对象
 *
 * 输出（契约）：
 *   null   —— 校验通过，调用方可以放心执行
 *   string —— 人类可读的失败原因（缺必填 / 类型不符 / 越界 / 不认识的参数）
 *
 * 为什么必须校验：抢救出来的参数是模型用自由文本写的，类型全靠猜（"4" / "abc" / ""），
 * 直接丢给 executeTool 会变成“工具里抛异常 → 循环继续 → 模型再编一次”的死循环。
 * 注意：additionalProperties === false 时多传的键会被拒绝，别在这里放宽。
 */
function validateArgsAgainstSchema(name, args) {
  const schema = TOOL_SCHEMA_MAP.get(name)
  if (!schema) return `未知工具 ${name}`
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '参数必须是对象'

  const props = schema.properties || {}
  const required = schema.required || []

  for (const key of required) {
    if (!(key in args) || args[key] === undefined || args[key] === '') return `缺少必填参数 ${key}`
  }

  for (const [key, value] of Object.entries(args)) {
    const prop = props[key]
    if (!prop) {
      if (schema.additionalProperties === false) return `不认识的参数 ${key}`
      continue
    }

    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type
    const ok =
      type === undefined ||
      (type === 'string' && typeof value === 'string') ||
      (type === 'integer' && Number.isInteger(value)) ||
      (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'array' && Array.isArray(value)) ||
      (type === 'object' && !!value && typeof value === 'object' && !Array.isArray(value))

    if (!ok) return `参数 ${key} 类型应为 ${type}`
    if (type === 'integer' || type === 'number') {
      if (typeof prop.minimum === 'number' && value < prop.minimum) return `参数 ${key} 不能小于 ${prop.minimum}`
      if (typeof prop.maximum === 'number' && value > prop.maximum) return `参数 ${key} 不能大于 ${prop.maximum}`
    }
  }

  return null
}

/**
 * 把模型正文里的伪工具调用抢救成 `{ name, args }[]`（唯一对外入口）。
 *
 * 双通道顺序（不可颠倒）：
 *   1) 通道一 XML/DSML：正文里出现 `< | | invoke>` 特征才走，用 split 容忍截断；
 *   2) 通道二 JSON：通道一没结果时兜底，识别 ```json fenced 与裸 JSON。
 *   先 XML 后 JSON，是因为 JSON 通道的误伤面更大 —— 模型经常只是“展示数据”，
 *   而 XML 方言一旦出现，基本可以确定它想调工具。
 *
 * 返回空数组 = 抢救失败：调用方要走“格式纠错”流程，**绝不执行任何东西**。
 * 任何一步不合规（非白名单工具 / 参数过不了 Schema）都会整段丢弃，
 * 宁可让模型重写一次，也不能执行一个半截的调用。
 */
function parsePseudoToolCalls(text) {
  if (typeof text !== 'string' || text === '') return []

  // 通道一：XML/DSML 特征（有 <||invoke> 才走）
  let candidates = looksLikeToolText(text) ? parsePseudoCallsFromXml(text) : []

  // 通道二：JSON（只认“有工具名 + 有参数载荷 + 白名单命中”的结构）
  if (candidates.length === 0) candidates = parsePseudoCallsFromJson(text)
  if (candidates.length === 0) return []

  const validated = []
  for (const call of candidates) {
    if (!TOOL_NAME_SET.has(call.name)) return [] // 白名单外，整段丢弃

    const error = validateArgsAgainstSchema(call.name, call.args || {})
    if (error) {
      log('WARN', `[AGENT] 伪调用参数校验失败（${call.name}）：${error}`)
      return []
    }
    validated.push({ name: call.name, args: call.args || {} })
  }

  return validated
}
module.exports = {
  safeParseArgs,
  stableStringify,
  callSignature,
  normalizeAssistantMessage,
  looksLikeToolText,
  coerceScalar,
  parsePseudoCallsFromXml,
  parsePseudoCallsFromJson,
  validateArgsAgainstSchema,
  parsePseudoToolCalls
}
