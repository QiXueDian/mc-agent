/**
 * ============================================================================
 *  src/brain.js —— 命令行入口（薄壳，只做“跑一次任务并打印”）
 * ----------------------------------------------------------------------------
 *  重构前：本文件里有 300 行 ReAct 循环，和 server.js 里的循环几乎一模一样（严重重复）。
 *  重构后：循环只在 agent/loop.js 里存在一份，这里只是给 runAgent 传一个
 *          “往终端打印”的 sendSSE 实现 —— 同一套大脑，两种输出通道。
 *
 *  用法：
 *    npm run cli                              # 用默认指令
 *    USER_INSTRUCTION="帮我做个木镐" npm run cli
 * ============================================================================
 */

require('dotenv').config()

const { runAgent } = require('./agent/loop')
const { waitForSpawn, disconnect } = require('./bot/connection')
const { log, describeError } = require('./agent/utils')

// 终端模式下的用户指令（可用环境变量覆盖）
const USER_INSTRUCTION = process.env.USER_INSTRUCTION || '帮我挖个木头，然后告诉我你在哪里'

/**
 * 终端版 sendSSE：把 Agent 的每一步打印成 `[TAG] 文本`。
 * 与 Web 版共用同一个 runAgent，只是输出通道不同。
 */
function terminalEmitter(type, data = {}) {
  const text = data.text || ''
  switch (type) {
    case 'step':
      log('LOOP', text)
      break
    case 'done':
      break // done 由 main 统一打印，避免重复
    default:
      log(type.toUpperCase(), text)
  }
}

async function main() {
  try {
    // 等机器人 spawn（connection.js 在 require 时已开始连接）
    await waitForSpawn()
    log('CLI', `开始执行指令：${USER_INSTRUCTION}`)

    // trace:false —— 终端已经由 terminalEmitter 逐条打印，关掉 loop 内部的重复日志
    const answer = await runAgent(USER_INSTRUCTION, terminalEmitter, { trace: false })

    console.log('\n================ 最终回复 ================')
    console.log(answer)
    console.log('=========================================\n')
  } catch (err) {
    log('ERROR', `任务执行失败：${describeError(err)}`)
    if (err?.stack) console.error(err.stack)
  } finally {
    disconnect('CLI 任务结束')
    // 给日志 flush 一点时间再退出
    setTimeout(() => process.exit(0), 300)
  }
}

main()
