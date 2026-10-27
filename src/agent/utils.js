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

// ----------------------------------------------------------------------------
// DSML / 伪工具调用词法（全项目唯一实现，禁止在别处手写竖线正则）
// ----------------------------------------------------------------------------
/**
 * 为什么要有这一层：
 *   模型把内部方言写进正文时，竖线经常被拆开 —— `<||calls>`、`< | | calls>`、
 *   `<| |invoke>`、`<｜ ｜calls>` 都会出现。以前写成 `<\|{0,3}`（竖线必须紧邻），
 *   带空格的变体一个都匹配不到：既洗不掉、也检测不到、抢救逻辑还被门禁短路。
 *
 * 关键：`(?:[|｜]\s*){0,3}` —— 竖线之间允许任意空白（\s 已覆盖全角空格 \u3000），
 *      且半角 | 与全角 ｜ 同等对待。
 */
const DSML_PIPE = '[|｜]'
const DSML_OPEN = `<\\s*(?:${DSML_PIPE}\\s*){0,3}`
/**
 * 闭合标签的顺序也不稳定：`</| |invoke>`、`< | | /invoke>`、`< | | / | | invoke>`
 * 都存在，所以 `/` 两侧都要允许竖线+空白。
 */
const DSML_CLOSE = `<\\s*(?:${DSML_PIPE}\\s*){0,3}\\/\\s*(?:${DSML_PIPE}\\s*){0,3}`
const DSML_KEYWORD = '(?:tool[\\s_]?calls?|calls|invoke|parameter|function[\\s_]?call|dsml)'

/** 检测用（无 g 标志，可以放心反复 .test()）：门禁 / 告警 / 清洗共用同一套判据 */
const DSML_TEXT_RE = new RegExp(
  `${DSML_OPEN}${DSML_KEYWORD}\\b` +
    `|${DSML_CLOSE}${DSML_KEYWORD}\\b` +
    '|\\b(?:function[\\s_]?call|tool[\\s_]?call)\\s*[:：=]' +
    '|｜[^｜\\n]{1,40}｜',
  'i'
)

/** 成对标签块：< | | invoke …> … < / | | invoke> —— 整段删除，连标签体一起 */
const DSML_BLOCK_RE = new RegExp(
  `${DSML_OPEN}(?:tool[\\s_]?calls?|calls|invoke)\\b[\\s\\S]*?${DSML_CLOSE}(?:tool[\\s_]?calls?|calls|invoke)?\\s*>`,
  'gi'
)

/** 被截断（没闭合）的 invoke 块：从开标签一直删到结尾，避免半截标签体残留在正文里 */
const DSML_TRUNCATED_RE = new RegExp(
  `${DSML_OPEN}(?:invoke|tool[\\s_]?calls?|calls)\\b[\\s\\S]*?${DSML_OPEN}parameter\\b[\\s\\S]*$`,
  'i'
)

/** 残余单标签：< | | calls>、< | | parameter name="x"> */
const DSML_TAG_RE = new RegExp(`${DSML_OPEN}${DSML_KEYWORD}\\b[^<>]{0,200}>?`, 'gi')

/** 残余闭合单标签：</ | | parameter>、< | | /invoke> */
const DSML_CLOSE_TAG_RE = new RegExp(`${DSML_CLOSE}${DSML_KEYWORD}\\b[^<>]{0,200}>?`, 'gi')

/** 带竖线的包裹 token：<||DSML||>、<|im_start|>、<｜endoftext｜>（必须含竖线，避免误删 <b> 之类） */
const DSML_WRAPPED_SOURCE = '<\\s*(?:[|｜]\\s*)+(?:[A-Za-z_]\\w*)?\\s*(?:[|｜]\\s*)*>'
const DSML_WRAPPED_RE = new RegExp(DSML_WRAPPED_SOURCE, 'gi')
const DSML_WRAPPED_TEST_RE = new RegExp(DSML_WRAPPED_SOURCE, 'i')

/**
 * 清洗模型正文里的特殊 token / 伪工具调用标签。
 *
 * 清洗顺序有讲究：
 *   1) 先删“成对块”——否则标签体（工具名、参数值）会残留成无意义正文；
 *   2) 再删“被截断的块”；
 *   3) 最后才删零散单标签和包裹 token。
 * 反过来会把开标签先删掉，导致闭合标签配不上、标签体全部留下。
 */
function cleanContent(text) {
  if (!text) return ''
  return String(text)
    .replace(DSML_BLOCK_RE, '') // 1) 成对块整段删除
    .replace(DSML_TRUNCATED_RE, '') // 2) 截断块删到结尾
    .replace(DSML_TAG_RE, '') // 3) 残余开标签
    .replace(DSML_CLOSE_TAG_RE, '') // 3.1) 残余闭合标签
    .replace(DSML_WRAPPED_RE, '') // 4) <||DSML||> 一类包裹 token
    .replace(/｜[^｜\n]{1,40}｜/g, '') // 5) 全角竖线包裹的标记
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '') // 6) 零宽字符
    .replace(/[ \t]+\n/g, '\n') // 7) 收拾清洗后的空行
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 正文里是否残留特殊 token / 伪工具调用特征（用于门禁与告警，不负责清洗） */
function hasSpecialToken(text) {
  if (typeof text !== 'string' || text === '') return false
  return DSML_TEXT_RE.test(text) || DSML_WRAPPED_TEST_RE.test(text)
}

module.exports = {
  log,
  sleep,
  withTimeout,
  formatPos,
  describeError,
  cleanContent,
  hasSpecialToken,
  // DSML 词法：loop.js 的解析正则必须复用这些片段，禁止再手写竖线
  DSML_PIPE,
  DSML_OPEN,
  DSML_CLOSE,
  DSML_KEYWORD,
  DSML_TEXT_RE,
  DSML_BLOCK_RE,
  DSML_TAG_RE
}
