/**
 * ============================================================================
 *  src/agent/history.js —— 多轮记忆与上下文拼接（纯函数，无 IO、无状态）
 * ----------------------------------------------------------------------------
 *  被搬迁自 loop.js（A2 步骤），函数体逐字节未改。
 *  只处理「纯文本 user/assistant」：tool / tool_calls 消息一律不入历史，
 *  否则 tool_call_id 配对不上，接口直接 400。
 * ============================================================================
 */

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

/**
 * 把一行生存状态贴到最后一条 role:tool 消息的末尾（零新增消息、零额外 token 条数）。
 *
 * 为什么“先剥再贴”：同一轮里若模型连续两次没产生新的工具结果（格式纠错 continue），
 * 上一次贴的状态还留在那条消息里，直接追加会越滚越长。这里按标记把旧行截掉再重贴。
 * 没有 tool 消息（第 1 步）时返回 false，初始状态交给 system prompt 覆盖。
 */
function attachSurvivalLine(messages, line) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'tool') continue
    const base = String(message.content || '')
      .split('【生存状态')
      .shift()
      .trimEnd()
    message.content = base ? `${base}\n${line}` : line
    return true
  }
  return false
}
module.exports = {
  MAX_HISTORY_MESSAGES,
  sanitizeHistory,
  attachSurvivalLine
}
