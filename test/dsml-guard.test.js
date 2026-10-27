/**
 * ============================================================================
 *  test/dsml-guard.test.js —— DSML / 伪工具调用「空白容忍」回归测试
 * ----------------------------------------------------------------------------
 *  覆盖的线上故障：
 *    模型把工具方言写成 `< | | calls>`、`<| |invoke>`、`< | |tool_calls>`
 *    （竖线被空格拆开），旧正则 `<\|{0,3}` 全部匹配不到 →
 *      ① 洗不掉，脏文本直接进 done 事件；
 *      ② 检测不到，所以没有格式告警；
 *      ③ 抢救门禁被短路，craft_item 根本没执行。
 *
 *  运行：npm test  （或 node test/dsml-guard.test.js）
 * ============================================================================
 */

const assert = require('node:assert')

const { cleanContent, hasSpecialToken } = require('../src/agent/utils')
const { parsePseudoToolCalls, looksLikeToolText } = require('../src/agent/loop')

let passed = 0
const failures = []

function caseRun(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✔ ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  ✘ ${name}\n      ${err.message.split('\n').join('\n      ')}`)
  }
}

// ---------------------------------------------------------------- 1. 变体检测
console.log('\n[1] 带空格 / 全角竖线的变体必须命中（检测 + 清洗）')

const SPACED_VARIANTS = [
  '< | | calls>',
  '<| |invoke>',
  '< | | tool_calls>',
  '< | |tool_calls>',
  '<｜ ｜calls>',
  '<  ||  invoke>',
  '<||calls>' // 零空格老写法，不能回归
]

for (const variant of SPACED_VARIANTS) {
  caseRun(`检测命中 ${JSON.stringify(variant)}`, () => {
    assert.strictEqual(looksLikeToolText(variant), true, 'looksLikeToolText 应为 true')
    assert.strictEqual(hasSpecialToken(variant), true, 'hasSpecialToken 应为 true')
    assert.strictEqual(cleanContent(variant), '', 'cleanContent 应清空')
  })
}

caseRun('文本中夹带变体时只删标签、保留正文', () => {
  assert.strictEqual(cleanContent('老大，我先看看背包 < | | calls>'), '老大，我先看看背包')
})

// ------------------------------------------------------- 2. 整块标签必须删干净
console.log('\n[2] 成对标签块必须整段删除（技能名/参数值不能残留）')

const SPACED_BLOCK =
  '< | | invoke name="craft_item">' +
  '< | | parameter name="item_name">crafting_table< | | /parameter>' +
  '< | | parameter name="count">4< | | /parameter>' +
  '< | | /invoke>'

caseRun('带空格变体的 invoke 块：正文只剩人话', () => {
  assert.strictEqual(cleanContent(`老大，我先做工作台。${SPACED_BLOCK}`), '老大，我先做工作台。')
})

caseRun('带空格变体的 invoke 块：一个标签都不许残留', () => {
  const cleaned = cleanContent(SPACED_BLOCK)
  assert.strictEqual(cleaned, '', `应全部删除，实际残留：${JSON.stringify(cleaned)}`)
})

caseRun('截断（未闭合）的 invoke 块：删到结尾，不留半截参数', () => {
  const truncated = '< | | invoke name="craft_item">< | | parameter name="item_name">oak_log'
  assert.strictEqual(cleanContent(`好的${truncated}`), '好的')
})

// ---------------------------------------------------------------- 3. 抢救解析
console.log('\n[3] 抢救逻辑：带空格的变体必须能解析成可执行调用')

caseRun('带空格 invoke + parameter → craft_item 参数正确', () => {
  const calls = parsePseudoToolCalls(SPACED_BLOCK)
  assert.deepStrictEqual(calls, [{ name: 'craft_item', args: { item_name: 'crafting_table', count: 4 } }])
})

caseRun('<| |invoke> 无参数工具 → get_status', () => {
  assert.deepStrictEqual(parsePseudoToolCalls('<| |invoke name="get_status">'), [
    { name: 'get_status', args: {} }
  ])
})

caseRun('单引号 + 未闭合的截断输出 → 仍按原参数解析', () => {
  assert.deepStrictEqual(parsePseudoToolCalls("<| |invoke name='get_status'>"), [
    { name: 'get_status', args: {} }
  ])
})

caseRun('白名单外的工具名 → 整段丢弃', () => {
  assert.deepStrictEqual(parsePseudoToolCalls('< | | invoke name="hack_server">< | | /invoke>'), [])
})

caseRun('必填参数缺失 → 抢救失败（返回空数组）', () => {
  assert.deepStrictEqual(parsePseudoToolCalls('< | | invoke name="craft_item">< | | /invoke>'), [])
})

// -------------------------------------------------------------- 4. 不误伤正常内容
console.log('\n[4] 不误伤：正常文本 / 普通 JSON 数据展示不能被执行或删改')

caseRun('普通中文文本：不检测、不清洗', () => {
  const text = '木头已经采集完了，背包里有 5 个橡木原木。'
  assert.strictEqual(looksLikeToolText(text), false)
  assert.strictEqual(hasSpecialToken(text), false)
  assert.strictEqual(cleanContent(text), text)
})

caseRun('普通 HTML 片段：不清洗', () => {
  assert.strictEqual(cleanContent('<b>任务完成</b>'), '<b>任务完成</b>')
})

caseRun('Markdown JSON 合法调用 → 仍可抢救', () => {
  const text = '```json\n{"name":"collect_resource","arguments":{"block_name":"oak_log","count":5}}\n```'
  assert.strictEqual(hasSpecialToken(text), false, 'JSON 不算特殊 token')
  assert.deepStrictEqual(parsePseudoToolCalls(text), [
    { name: 'collect_resource', args: { block_name: 'oak_log', count: 5 } }
  ])
})

caseRun('Markdown JSON 纯数据（无参数载荷）→ 不执行', () => {
  assert.deepStrictEqual(parsePseudoToolCalls('```json\n{"player":"Steve","health":20}\n```'), [])
})

caseRun('Markdown JSON 编造工具 → 丢弃', () => {
  assert.deepStrictEqual(parsePseudoToolCalls('```json\n{"name":"delete_world","arguments":{}}\n```'), [])
})

// ---------------------------------------------------------------------- 汇总
console.log('\n' + '-'.repeat(64))
if (failures.length > 0) {
  console.log(`✘ 失败 ${failures.length} 个 / 通过 ${passed} 个`)
  for (const name of failures) console.log(`   - ${name}`)
} else {
  console.log(`✔ 全部通过：${passed} 个用例`)
}

// ---------------------------------------------------------------------- 退出
/**
 * 必须显式退出，不能让 Node 自己“自然结束”。
 *
 * 原因：本文件 require('../src/agent/loop')，而 loop.js 顶部 require 了
 * ../bot/connection —— 那个模块**加载即拨号**（connection.js 的 module.exports
 * 里 `bot: getBot()`），并且断线后会一直 setTimeout 重连。
 * 这些句柄/定时器不会自己消失，事件循环永远有活儿，进程就挂住终端不还提示符。
 *
 * 这里只测纯函数，没有需要优雅收尾的资源；直接按断言结果给出退出码。
 */
process.exit(failures.length > 0 ? 1 : 0)
