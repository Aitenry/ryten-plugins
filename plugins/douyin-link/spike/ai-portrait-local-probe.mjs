/**
 * 本地模型耗时探针（**不联网、不花钱**，只打本机的 Ollama）：量「这一份真材料」本地模型要跑多久。
 *
 * 为什么要它（2026-10-13 用户报「小模型会报错，本地的 ollama 模型」）：插件的生成链原来给的是
 * **180 秒墙钟硬超时**，本地 9B 模型（Q4 量化）根本写不完那份 4-7 节的画像 → 用户看到的就是
 * 「模型调用失败：This operation was aborted」（AbortController 的原文）。
 * 「会不会超时」不能靠推理：这里直接量——前置处理多久、出第一个字多久、每秒多少字、
 * 写完整份要多久，再拿这些数字去定超时口径。
 *
 * 跑法：
 *   node plugins/douyin-link/spike/ai-portrait-local-probe.mjs --model=qwen3.5-9b-32k:latest --prompt="$env:TEMP\portrait-prompt-real.txt"
 *   # 只看速度（只让它写 96 个 token，快）：
 *   node plugins/douyin-link/spike/ai-portrait-local-probe.mjs --model=... --prompt=... --max-tokens=96
 *   # 跑完整份（慢，几分钟到十几分钟）：
 *   node plugins/douyin-link/spike/ai-portrait-local-probe.mjs --model=... --prompt=... --full
 *
 * 说明：走的是 Ollama 原生 `/api/chat`（宿主那套 ChatOllama 最终也是打它），
 * 这样量出来的耗时不掺框架层；`--full` 时顺便把回话交给插件的解析器，看**本地小模型能不能
 * 按 JSON 结构回话**（那是另一半问题：模型太小时可能压根不守纪律）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

const argOf = (name) => {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}
const model = argOf('model') || 'qwen3.5-9b-32k:latest'
const promptFile = (argOf('prompt') || join(process.env.TEMP ?? '', 'portrait-prompt-real.txt')).replace(
  /^\/([A-Za-z]:)/,
  '$1'
)
const baseUrl = argOf('base') || 'http://127.0.0.1:11434'
const full = process.argv.includes('--full')
const maxTokens = Number(argOf('max-tokens')) || (full ? 0 : 96)

if (!existsSync(promptFile)) {
  console.error(`找不到提示词文件：${promptFile}（先用 DY_DUMP_PROMPT 从 ai-portrait-model-check.mjs 导出）`)
  process.exit(2)
}
const prompt = readFileSync(promptFile, 'utf8')
/** 中文按 1 token ≈ 1.5 字符粗估（只用来给个量级，真实数字看 Ollama 回的 eval_count） */
const approxPromptTokens = Math.round(prompt.length / 1.5)

const systemEnd = prompt.indexOf('\n\n### ')
const system = systemEnd > 0 ? prompt.slice(0, systemEnd) : '你是直播运营的数据分析师。'
const user = systemEnd > 0 ? prompt.slice(systemEnd + 2) : prompt

console.log(`模型：${model} · ${baseUrl}`)
console.log(`提示词：${prompt.length} 字符（粗估 ${approxPromptTokens} token）· 本次最多让它写 ${maxTokens || '不限'} token`)
console.log(full ? '模式：完整生成（走插件的解析器验结构）' : '模式：只测速度（写满就停，快）')
console.log('')

const started = Date.now()
let firstTokenAt = 0
let lastTokenAt = 0
let chunks = 0
let text = ''
/** 思考型模型（qwen3.5 / deepseek-r1 这类）把推理写在 `message.thinking` 里，**不算正文** */
let thinkingChars = 0
let firstContentAt = 0
let evalCount = 0
let promptEvalCount = 0
let doneReason = ''

const response = await fetch(`${baseUrl}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    stream: true,
    // 思考型模型（qwen3.5 等）：`think: false` 关掉推理——本地小模型把预算全烧在思考上时，
    // 正文一个字都写不出来（宿主那套 ChatOllama 也认这个参数，走供应商高级参数 extra_config）
    ...(process.argv.includes('--no-think') ? { think: false } : {}),
    // 与宿主那套一致：不下发采样参数（留空 = 供应商最佳默认）
    ...(maxTokens > 0 ? { options: { num_predict: maxTokens } } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })
})
if (!response.ok) {
  console.error(`Ollama 回 ${response.status}：${(await response.text()).slice(0, 300)}`)
  process.exit(1)
}

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    const delta = frame.message?.content ?? ''
    const thinking = frame.message?.thinking ?? ''
    if (thinking) {
      const now = Date.now()
      if (!firstTokenAt) firstTokenAt = now
      lastTokenAt = now
      thinkingChars += thinking.length
    }
    if (delta) {
      const now = Date.now()
      if (!firstTokenAt) firstTokenAt = now
      if (!firstContentAt) firstContentAt = now
      lastTokenAt = now
      chunks += 1
      text += delta
      if (chunks % 40 === 0) {
        process.stdout.write(`\r  已写 ${text.length} 字符 · 用时 ${((now - started) / 1000).toFixed(0)}s`)
      }
    }
    if (frame.done) {
      evalCount = frame.eval_count ?? 0
      promptEvalCount = frame.prompt_eval_count ?? 0
      doneReason = frame.done_reason ?? ''
    }
  }
}
process.stdout.write('\r')

const elapsed = Date.now() - started
const prefillMs = firstTokenAt ? firstTokenAt - started : elapsed
const genMs = lastTokenAt && firstTokenAt ? lastTokenAt - firstTokenAt : 0
const tokensPerSecond = evalCount > 0 && genMs > 0 ? (evalCount / genMs) * 1000 : 0

console.log('=== 实测 ===')
console.log(`  前置处理（读提示词 + 出第一个 token）  ${(prefillMs / 1000).toFixed(1)}s（Ollama 报 prompt_eval_count=${promptEvalCount || '?'}）`)
console.log(`  出字阶段                          ${(genMs / 1000).toFixed(1)}s · 正文分片 ${chunks} 个`)
console.log(`  生成 token / 速度                 ${evalCount || '?'} token · ${tokensPerSecond.toFixed(1)} token/s（含思考）`)
console.log(`  思考内容                          ${thinkingChars} 字符${thinkingChars > 0 ? '  ← 这是个**思考型模型**：推理也算在生成预算里' : ''}`)
console.log(`  正文首字时刻                      ${firstContentAt ? `${((firstContentAt - started) / 1000).toFixed(1)}s` : '（这次没写出正文）'}`)
console.log(`  总耗时                            ${(elapsed / 1000).toFixed(1)}s${doneReason ? `（done_reason=${doneReason}）` : ''}`)
console.log(`  正文长度                          ${text.length} 字符`)

/* 拿实测速度推算「写完整份画像」要多久：真跑那次 DeepSeek 输出了 7200-9200 token */
if (tokensPerSecond > 0) {
  for (const target of [3000, 5000, 9200]) {
    const seconds = prefillMs / 1000 + target / tokensPerSecond
    const flag = seconds > 180 ? '  ← 超过原来的 180s 硬超时（会报 This operation was aborted）' : ''
    console.log(`  推算写满 ${target} token：${(seconds / 60).toFixed(1)} 分钟${flag}`)
  }
}

/* 完整生成时顺带验结构：本地小模型能不能按 JSON 纪律回话 */
if (full) {
  const workDir = mkdtempSync(join(tmpdir(), 'douyin-local-probe-'))
  writeFileSync(join(workDir, 'entry.ts'), `export { parsePortraitReport } from ${JSON.stringify(join(PLUGIN, 'shared/ai-portrait.ts'))}\n`, 'utf8')
  const outfile = join(workDir, 'pure.mjs')
  await build({ entryPoints: [join(workDir, 'entry.ts')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' })
  const { parsePortraitReport } = await import(pathToFileURL(outfile).href)
  const report = parsePortraitReport(text)
  console.log('')
  console.log('=== 结构（本地小模型守不守纪律）===')
  console.log(`  解析成结构化报告：${report ? '成功' : '**失败**（界面会按原文显示）'}`)
  if (report) {
    console.log(`  类型名：${report.persona}`)
    console.log(`  一句话：${report.headline}`)
    console.log(`  分节 ${report.sections.length} 节 · 证据 ${report.evidence.length} 条 · 建议 ${report.suggestions.length} 条 · 局限 ${report.caveats.length} 条`)
  } else {
    console.log(`  回话开头：${text.slice(0, 200).replace(/\n/g, ' ')}`)
  }
  rmSync(workDir, { recursive: true, force: true })
}
