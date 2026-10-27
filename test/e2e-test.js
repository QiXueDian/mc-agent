/**
 * ============================================================================
 *  test/e2e-test.js —— 端到端冒烟测试（真实调用大模型 + 真实工具链）
 * ----------------------------------------------------------------------------
 *  和单元测试的分工：
 *    test/dsml-guard.test.js  只测纯函数（不联网、不调模型），秒回；
 *    本文件                   真跑 runAgent，验证「提示词 → 模型 → 工具 → 最终文本」
 *                             这条链路没断，尤其是 query_game_knowledge 的 Markdown 表格。
 *
 *  不连 Minecraft（bot=null）：只验证知识查询链路，避免测试依赖本地服务端。
 *  产物写到系统临时目录（不污染仓库），路径会打印出来。
 *
 *  运行：
 *    npm run test:e2e                      默认问“石镐怎么合成”
 *    npm run test:e2e -- "铁锭怎么烧"       自定义问题（注意 -- 后面的参数）
 *
 *  前置条件：.env 里有可用的 DEEPSEEK_API_KEY（缺了会直接失败退出，不是静默跳过）。
 * ============================================================================
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

require('dotenv').config()

const { runAgent } = require('../src/agent/loop')
const { getSystemPrompt } = require('../src/agent/personas')
const { looksLikeToolText } = require('../src/agent/protocol')

const QUESTION = String(process.argv[2] || '帮我查一下石镐怎么合成').trim()
const MAX_STEPS = Number(process.env.E2E_MAX_STEPS || 4)
const PAYLOAD_PATH = path.join(os.tmpdir(), 'mc-agent-e2e-payload.json')

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed = true
}

;(async () => {
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'sk-xxxxxxxxxxxxxxxx') {
    console.error('✘ 缺少有效的 DEEPSEEK_API_KEY：本测试需要真实调用大模型，请在 .env 中配置后重试')
    process.exit(1)
  }

  const events = []
  const emit = (type, data = {}) => {
    events.push({ type, ...data })
    const text = String(data.text || '')
    console.log(`[${type}] ${text.replace(/\n/g, ' ⏎ ').slice(0, 180)}`)
  }

  console.log(`\n>>> 用户：${QUESTION}\n`)

  let answer = ''
  try {
    answer = await runAgent(QUESTION, emit, {
      systemPrompt: getSystemPrompt('worker'),
      maxSteps: MAX_STEPS,
      trace: false
    })
  } catch (err) {
    console.error(`\n✘ runAgent 抛出异常：${err?.message || err}`)
    process.exit(1)
  }

  console.log('\n===== done 事件里的最终文本 =====\n')
  console.log(answer)

  console.log('\n----- 断言 -----')
  check('最终回复非空', typeof answer === 'string' && answer.trim() !== '')
  check('最终回复不含伪工具调用 / 特殊 token', !looksLikeToolText(String(answer)))
  check('产生了 thought / action 事件', events.some((e) => e.type === 'thought' || e.type === 'action'))
  check('调用了 query_game_knowledge', events.some((e) => e.tool === 'query_game_knowledge'))

  try {
    fs.writeFileSync(PAYLOAD_PATH, JSON.stringify({ question: QUESTION, events, answer }, null, 2), 'utf8')
    console.log(`\n（完整事件已写入 ${PAYLOAD_PATH}）`)
  } catch (err) {
    console.log(`\n（事件文件写入失败，不影响结论：${err?.message || err}）`)
  }

  // require('../src/agent/loop') 会连带加载 bot/connection（加载即拨号 + 断线重连定时器），
  // 不显式退出会挂住终端。
  process.exit(failed ? 1 : 0)
})()
