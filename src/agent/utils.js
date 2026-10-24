/**
 * ============================================================================
 *  src/agent/utils.js —— 全项目共用的最小工具集（无业务逻辑，无副作用初始化）
 * ----------------------------------------------------------------------------
 *  重构前：log / sleep / withTimeout / formatPos / describeError 这些函数
 *  在 tools.js、server.js、loop.js、connection.js 里各写了一遍（DRY 违规）。
 *  现在统一收敛到这里，任何模块需要就直接 require，禁止再复制粘贴。
 *
 *  这里的函数必须保持“纯工具”定位：
 *    - 不 require mineflayer / openai（否则会制造模块耦合）
 *    - 不读写全局状态
 * ============================================================================
 */

/** 统一日志：`[HH:mm:ss] [TAG] message`，全项目唯一的时间戳格式化实现 */
function log(tag, message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`[${time}] [${tag}] ${message}`)
}

/** 等待若干毫秒 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 给任意 Promise 加超时保护。
 * 寻路（pathfinder.goto）、挖掘（bot.dig）、合成（bot.craft）、大模型请求
 * 在异常情况下都可能永远不 resolve，没有超时会把整个 Agent 卡死。
 *
 * @param {Promise|any} promise
 * @param {number} ms      超时毫秒
 * @param {string} label   超时信息里的动作名，方便定位是谁卡住了
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** 把 Vec3 格式化成 (x, y, z)，用于拼给大模型/前端看的文本 */
function formatPos(pos) {
  if (!pos) return '(未知)'
  return `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`
}

/** 把各种错误整理成一行可读文本（OpenAI SDK 的错误可能带 status，也可能只有 message） */
function describeError(err) {
  if (!err) return '未知错误'
  const status = err.status ? `HTTP ${err.status} ` : ''
  return `${status}${err.message || String(err)}`
}

/**
 * 清洗模型正文里的特殊 token（<||DSML||>、｜DSML｜、零宽字符…）。
 * 有些模型在工具调用格式出错时会把内部标记写进 content，必须剔掉，
 * 否则乱码会直接显示给用户，还会污染下一轮上下文。
 */
function cleanContent(text) {
  if (!text) return ''
  return text
    .replace(/<\|{1,2}[\s\S]{0,40}?\|{1,2}>/g, '') // <||DSML||>、<|im_start|> 一类
    .replace(/｜[^｜\n]{1,40}｜/g, '') // 全角竖线包裹的 DSML 标记
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '') // 零宽字符
    .trim()
}

/** 正文里是否残留特殊 token（用于告警，不用于清洗） */
function hasSpecialToken(text) {
  return typeof text === 'string' && /<\|[\s\S]{0,40}?\|>|｜[^｜\n]{1,40}｜/.test(text)
}

module.exports = {
  log,
  sleep,
  withTimeout,
  formatPos,
  describeError,
  cleanContent,
  hasSpecialToken
}
