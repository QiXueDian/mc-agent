/**
 * ============================================================================
 *  test/knowledge-baseline.js —— query_game_knowledge 输出回归基线
 * ----------------------------------------------------------------------------
 *  用途：knowledge.js 里全是硬编码的配方渲染与前端约定（「产出：ID xN」+ 3 行表格），
 *        改一个空格、换一行顺序，前端就拼不出贴图。这里用固定用例锁住输出：
 *          npm run test:knowledge        与基线逐字节比对，不一致即失败
 *          npm run test:knowledge:update 确认改动是有意的之后，重写基线
 *
 *  基线文件：test/knowledge-baseline.json（跟着仓库走，别手动改）
 *  路径基于 __dirname，因此从任何工作目录执行都一致。
 * ============================================================================
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { executeTool, toolDefinitions } = require('../src/agent/tools')

const BASELINE_PATH = path.join(__dirname, 'knowledge-baseline.json')

const CASES = [
  ['wooden_pickaxe', 'recipe'],
  ['crafting_table', 'recipe'],
  ['iron_ingot', 'recipe'],
  ['stone_pickaxe', 'recipe'],
  ['diamond_pickaxe', 'item']
]

;(async () => {
  const out = {}
  for (const [keyword, type] of CASES) {
    out[`${type}:${keyword}`] = await executeTool(null, 'query_game_knowledge', {
      query_type: type,
      keyword
    })
  }

  const payload = { cases: out, toolCount: toolDefinitions.length }
  const text = JSON.stringify(payload, null, 2)
  const hash = crypto.createHash('md5').update(text).digest('hex')

  const mode = process.argv[2] || 'compare'
  if (mode === 'save') {
    fs.writeFileSync(BASELINE_PATH, text, 'utf8')
    console.log(`已保存基线 md5=${hash}，工具数=${payload.toolCount}`)
    process.exit(0)
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`✘ 基线文件不存在：${BASELINE_PATH}（先跑 npm run test:knowledge:update）`)
    process.exit(1)
  }

  const old = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  const diffs = Object.keys(old.cases).filter((k) => old.cases[k] !== out[k])
  console.log(`工具数：${old.toolCount} → ${payload.toolCount}`)
  console.log(diffs.length === 0 ? `✔ ${CASES.length} 个用例输出逐字节一致` : `✘ 有差异：${diffs.join(', ')}`)

  if (diffs.length > 0) {
    for (const k of diffs) console.log(`\n--- ${k} ---\nOLD:\n${old.cases[k]}\nNEW:\n${out[k]}`)
    process.exit(1)
  }

  process.exit(0)
})()
