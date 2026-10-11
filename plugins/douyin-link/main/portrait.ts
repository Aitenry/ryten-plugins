import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { safeSend } from '@host/main/safe-send'
import { getMainLanguage } from '@host/main/i18n'
import { getProviderService } from '@host/main/provider/service'
import { getDefaultProvider, getEnabledProviders } from '@host/main/database/mapper/provider'
import type {
  AiPortrait,
  AiPortraitChunk,
  AiPortraitFailure,
  AiPortraitModel,
  AiPortraitResult,
  AiPortraitState,
  LiveSettings,
  UserDetail
} from '../shared/types'
import { parsePortraitReport, portraitFingerprint, portraitInteractions, portraitKeyOf } from '../shared/ai-portrait'
import { buildUserAnalysis } from './analysis/portrait'
import { buildPortraitPrompt, portraitProviderSetting, type PortraitPrevious } from './analysis/ai-evidence'
import {
  deleteUserPortrait,
  getUserPortrait,
  saveUserPortrait,
  userLastSeenAnyRoom,
  userPortraitExtras,
  userStatsAnyRoom,
  resolveAccountIds,
  userIdentity,
  userAnalysisData
} from './db/mapper'

/**
 * 「AI 画像」：用**宿主里配置的大模型**（与 harness 同一个 `ProviderService`）生成用户画像。
 *
 * 与 `main/analysis/portrait.ts`（确定性算法画像）的分工：
 * - 那一份**不花钱、可复现**，回答「数据里量到了什么」；
 * - 这一份**要花钱**，回答「这个人是什么样的人、该怎么维护」——事实由算法给、解读由模型给。
 *
 * 三条工程纪律：
 * 1. **模型只有一个来源**：宿主的 `ProviderService`（`@host/main/provider/service`）。插件不自己
 *    持有 api_key、不自己拼 HTTP —— 于是「harness 换模型/换供应商，这里跟着变」，
 *    而且密钥始终不离开主进程（返回给界面的模型清单里没有 key）；
 * 2. **生成一次就落库**（用户 2026-10-13：「需要保存这个画像，不然每一次都要重新生成，会很亏 token」）：
 *    缓存键 + 版本号 + 用量 + 数据指纹一起存，重开弹窗直接读；
 * 3. **同一时刻只跑一次**（按缓存键去重）：重复点按钮不会打出两份账单。
 *
 * 流式：模型逐段回话时通过 `AI_PORTRAIT_EVENT` 推给界面（界面把**已闭合的字段**边收边渲染，
 * 见 shared/ai-portrait.ts 的 `partialPortraitReport`），完成后用 `ai-portrait-generate` 的回话
 * 给出结构化结果——用户不必对着转圈等一分钟。
 */

/** 生成过程中的流式增量（主进程 → 界面） */
export const AI_PORTRAIT_EVENT = 'plugin:douyin-link:portrait'

/**
 * 一次生成的硬超时。
 *
 * 宿主那层已经关掉了 LangChain 自带的重试（`INNER_RETRIES_DISABLED`，见 provider/service.ts），
 * 所以卡住就是卡住：超过这个时间直接 abort，把失败如实报给界面（而不是让弹窗永远转圈）。
 * 3 分钟足够一份 4-7 节的画像写完（实测常在 20-60 秒）。
 */
const PORTRAIT_TIMEOUT_MS = 180_000

/** 正在跑的那一次（按缓存键去重） */
const running = new Map<string, { requestId: string; startedAt: number }>()

let seq = 0

/** 事件只发给界面窗口（与 hub.broadcast 同一约定） */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    safeSend(win.webContents, channel, payload)
  }
}

/**
 * 可选的模型清单（**不含 api_key**）。
 *
 * `getEnabledProviders()` 返回的是**解密后**的完整配置（内部要拿它建模型实例），
 * 所以这里必须**逐字段挑**地映射一遍——多带一个字段就等于把密钥发到渲染层。
 */
export async function listPortraitModels(): Promise<AiPortraitModel[]> {
  try {
    const [enabled, preferred] = await Promise.all([
      getEnabledProviders(),
      getDefaultProvider().catch(() => null)
    ])
    return enabled.map((provider) => ({
      id: provider.id,
      name: provider.name,
      model: provider.model,
      isDefault: preferred != null && preferred.id === provider.id
    }))
  } catch (error) {
    logger.warn('[douyin-link] 读取模型清单失败（用户还没配任何供应商？）:', describe(error))
    return []
  }
}

/**
 * 解析这次要用哪个供应商：**设置里指定的 > 宿主默认 > 已启用的第一个**。
 *
 * 与 harness 后台任务（`memory-agent.ts` 的 `resolveProviderId`）**同一条链**——
 * 「用 harness 的模型」在这里就是字面意思：同一个 ProviderService、同一份配置、同一套回退。
 * 指定的那个可能已被禁用/删除，所以要在「已启用」里核一遍再认。
 */
async function resolveProviderId(selected: number | null): Promise<number | undefined> {
  const enabled = await getEnabledProviders().catch(() => [])
  if (selected != null && enabled.some((provider) => provider.id === selected)) return selected
  const preferred = await getDefaultProvider().catch(() => null)
  if (preferred && enabled.some((provider) => provider.id === preferred.id)) return preferred.id
  return enabled[0]?.id
}

/** ms → 画像的记录（缓存行 → 渲染层 DTO） */
function toPortrait(row: Awaited<ReturnType<typeof getUserPortrait>>): AiPortrait | null {
  if (!row) return null
  let report = null
  if (row.structured && row.report) {
    try {
      report = parseReportJson(row.report)
    } catch {
      report = null
    }
  }
  // 没标结构化（旧版/异常回话）时**再试一次**：提示词或解析器后来变强了，旧数据就能直接受益
  if (!report) report = parsePortraitReport(row.raw)
  return {
    key: row.key,
    userId: row.userId,
    version: row.version,
    providerId: row.providerId,
    providerName: row.providerName,
    model: row.model,
    report,
    raw: row.raw,
    fingerprint: row.fingerprint,
    interactions: row.interactions,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    generatedAt: row.generatedAt
  }
}

/** 库里存的是 `normalizePortraitReport` 过的 JSON，读回来还要过一次归一（防手改与旧格式） */
function parseReportJson(json: string): AiPortrait['report'] {
  return parsePortraitReport(json)
}

/** 这个人的全部账号（与画像其它查询同一份 id 集合；没绑定就是一个） */
async function accountIdsOf(userId: string): Promise<string[]> {
  const id = String(userId ?? '').trim()
  if (!id) return []
  const ids = await resolveAccountIds(id)
  return ids.length > 0 ? ids : [id]
}

/** 跨房间合计（读缓存的指纹要用它；口径与 `userProfile` 的互动统计一致） */
async function totalsOf(ids: string[]): Promise<{ totals: PortraitTotalsLite; lastSeen: number }> {
  const totals = zeroTotals()
  const [stats, lastSeen] = await Promise.all([userStatsAnyRoom(ids), userLastSeenAnyRoom(ids)])
  for (const hit of stats.values()) {
    totals.chat += hit.chat
    totals.enter += hit.enter
    totals.like += hit.like
    totals.follow += hit.follow
    totals.gift += hit.gift
    totals.diamonds += hit.diamonds
  }
  return { totals, lastSeen }
}

/** 指纹用得到的那几项（与 `shared/ai-portrait.ts` 的 `PortraitFingerprintInput` 同形） */

export interface PortraitTotalsLite {
  chat: number
  enter: number
  like: number
  follow: number
  gift: number
  diamonds: number
}

function zeroTotals(): PortraitTotalsLite {
  return { chat: 0, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 }
}

/** 打开弹窗要的全部状态（缓存 + 数据侧现状 + 模型清单 + 是否在跑） */
export async function aiPortraitState(input: {
  userId: string
  settings: Pick<LiveSettings, 'portraitProviderId'>
}): Promise<AiPortraitState> {
  const userId = String(input.userId ?? '').trim()
  const selectedProviderId = portraitProviderSetting(input.settings)
  if (!userId) {
    return {
      portrait: null,
      current: { fingerprint: '', interactions: 0 },
      running: false,
      models: await listPortraitModels(),
      selectedProviderId
    }
  }
  const [identity, models] = await Promise.all([userIdentity(userId), listPortraitModels()])
  const key = portraitKeyOf(identity.identityId, userId)
  const [row, ids] = await Promise.all([getUserPortrait(key), accountIdsOf(userId)])
  const { totals, lastSeen } = await totalsOf(ids)
  return {
    portrait: toPortrait(row),
    current: {
      fingerprint: portraitFingerprint({ ...totals, lastSeen }),
      interactions: portraitInteractions({ ...totals, lastSeen })
    },
    running: running.has(key),
    models,
    selectedProviderId
  }
}

/** 生成失败的原因分类（机器码给渲染层翻文案） */
function failure(reason: AiPortraitFailure, detail?: string): AiPortraitResult {
  return { ok: false, reason, ...(detail ? { detail: trim(detail, 400) } : {}) }
}

function trim(text: string, max: number): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 生成一版 AI 画像（流式 + 落库 + 版本递增）。
 *
 * 拒绝的三种情况先说清楚（都不花钱）：
 * - `no-data`：互动太少（< 5 条且没送过礼）——没有材料时让模型写，只会写出漂亮的废话；
 * - `busy`：同一个人已经有一次在跑（防重复点击打出两份账单）；
 * - `no-model`：宿主里一个可用的供应商都没有（提示用户先去设置里配模型）。
 *
 * `force = false` 时若已有缓存就**直接回缓存**（用户的原话：每次都重新生成会很亏 token）。
 */
export async function generateAiPortrait(input: {
  userId: string
  webRid?: string
  /** 档案（由 hub 提供：静态字段的口径与弹窗上显示的那份完全一致） */
  profile: UserDetail | null
  settings: Pick<LiveSettings, 'portraitProviderId'>
  force?: boolean
}): Promise<AiPortraitResult> {
  const userId = String(input.userId ?? '').trim()
  if (!userId) return failure('no-data')

  const [identity, ids] = await Promise.all([userIdentity(userId), accountIdsOf(userId)])
  const key = portraitKeyOf(identity.identityId, userId)
  if (running.has(key)) return failure('busy')

  const cachedRow = await getUserPortrait(key)
  if (cachedRow && input.force !== true) {
    const cached = toPortrait(cachedRow)
    if (cached) return { ok: true, portrait: cached }
  }

  // ---- 取材料（这一步不花钱，先做完再决定要不要调模型）
  const data = await userAnalysisData(ids)
  const now = Date.now()
  const analysis = buildUserAnalysis(data, now)
  if (!analysis.hasData) return failure('no-data')

  const extras = await userPortraitExtras(ids)
  const totals = {
    chat: data.chat,
    enter: data.enter,
    like: data.likes,
    follow: data.follows,
    gift: data.gift,
    diamonds: data.diamonds,
    receivedDiamonds: extras.receivedDiamonds,
    firstSeen: data.firstSeen,
    lastSeen: Math.max(extras.lastSeen, data.lastSeen)
  }
  const previous: PortraitPrevious | null = cachedRow
    ? {
        version: cachedRow.version,
        generatedAt: cachedRow.generatedAt,
        report: toPortrait(cachedRow)?.report ?? null,
        raw: cachedRow.raw
      }
    : null

  // ---- 选模型（与 harness 同一条回退链）
  const selected = portraitProviderSetting(input.settings)
  const providerId = await resolveProviderId(selected)
  if (providerId == null) return failure('no-model')

  const providerService = getProviderService()
  let model
  try {
    model = await providerService.createModel(providerId)
  } catch (error) {
    return failure('model-failed', describe(error))
  }
  const config = await providerService.getConfig(providerId).catch(() => null)
  const modelName = String(config?.model ?? '')
  const providerName = String(config?.name ?? '')

  const prompt = buildPortraitPrompt({
    anchor: { userId, name: input.profile?.nickname ?? '' },
    identity: identity.identityId > 0 ? identity : null,
    profile: input.profile,
    totals,
    activityHours: data.hours,
    analysis,
    extras,
    previous,
    language: safeLanguage(),
    now,
    version: (cachedRow?.version ?? 0) + 1
  })

  const requestId = `p${(seq += 1)}`
  running.set(key, { requestId, startedAt: now })
  logger.info(
    `[douyin-link] AI 画像开始：第 ${(cachedRow?.version ?? 0) + 1} 版 · ${providerName || providerId}/${modelName || '?'} · ` +
      `材料 ${prompt.chars.total} 字符（system ${prompt.chars.system} + user ${prompt.chars.user}）· ` +
      `互动 ${prompt.interactions} 条 · 弹幕样本 ${extras.recentChat.length} · 送礼样本 ${extras.sentGifts.length}`
  )

  try {
    const { text, inputTokens, outputTokens } = await streamPortrait(model, prompt, requestId)
    const report = parsePortraitReport(text)
    const portrait: AiPortrait = {
      key,
      userId,
      version: (cachedRow?.version ?? 0) + 1,
      providerId,
      providerName,
      model: modelName,
      report,
      raw: text,
      fingerprint: prompt.fingerprint,
      interactions: prompt.interactions,
      inputTokens,
      outputTokens,
      generatedAt: Date.now()
    }
    await saveUserPortrait({
      key,
      userId,
      identityId: identity.identityId,
      version: portrait.version,
      providerId,
      providerName,
      model: modelName,
      structured: report != null,
      report: report ? JSON.stringify(report) : '',
      raw: text,
      fingerprint: portrait.fingerprint,
      interactions: portrait.interactions,
      inputTokens,
      outputTokens,
      generatedAt: portrait.generatedAt
    })
    logger.info(
      `[douyin-link] AI 画像完成：第 ${portrait.version} 版 · ${text.length} 字符 · ` +
        `token ${inputTokens}/${outputTokens} · ${report ? '结构化成功' : '未按 JSON 回（按原文显示）'}`
    )
    return { ok: true, portrait }
  } catch (error) {
    const detail = describe(error)
    logger.warn(`[douyin-link] AI 画像失败：${detail}`)
    return failure('model-failed', detail)
  } finally {
    running.delete(key)
    broadcast(AI_PORTRAIT_EVENT, { requestId, delta: '', done: true } satisfies AiPortraitChunk)
  }
}

/** 界面语言（拿不到就按中文：插件自己的界面词条里中文是主语言） */
function safeLanguage(): string {
  try {
    return getMainLanguage() || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

/**
 * 跑一次流式生成。
 *
 * 两个细节：
 * - **逐段推给界面**：增量经 `AI_PORTRAIT_EVENT` 发出（界面自己按 requestId 配对，
 *   并只渲染「已闭合的字段」，所以看到的是画像一节节长出来，而不是半截 JSON）；
 * - **用量能拿多少拿多少**：不是所有供应商都在流式里回 usage（OpenAI 系要带 include_usage），
 *   所以取到 0 就如实写 0，不编数字。
 */
async function streamPortrait(
  model: BaseChatModel,
  prompt: { system: string; user: string },
  requestId: string
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { SystemMessage, HumanMessage } = await import('@langchain/core/messages')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PORTRAIT_TIMEOUT_MS)
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  try {
    const stream = await model.stream(
      [new SystemMessage(prompt.system), new HumanMessage(prompt.user)],
      { signal: controller.signal }
    )
    for await (const chunk of stream) {
      const delta = chunkText(chunk)
      const usage = (chunk as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata
      if (usage) {
        inputTokens = Math.max(inputTokens, Math.round(Number(usage.input_tokens) || 0))
        outputTokens = Math.max(outputTokens, Math.round(Number(usage.output_tokens) || 0))
      }
      if (!delta) continue
      text += delta
      broadcast(AI_PORTRAIT_EVENT, { requestId, delta, done: false } satisfies AiPortraitChunk)
    }
  } finally {
    clearTimeout(timer)
  }
  if (!text.trim()) throw new Error('模型没有返回任何内容')
  if (controller.signal.aborted) throw new Error(`模型超过 ${Math.round(PORTRAIT_TIMEOUT_MS / 1000)} 秒没有写完，已中止`)
  return { text, inputTokens, outputTokens }
}

/** 增量文本：`content` 可能是字符串，也可能是分片数组（多模态格式） */
function chunkText(chunk: unknown): string {
  const content = (chunk as { content?: unknown })?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        const text = (part as { text?: unknown })?.text
        return typeof text === 'string' ? text : ''
      })
      .join('')
  }
  return ''
}

/** 清掉某个人的 AI 画像（设置页/工装用；界面上的「重新生成」是覆盖写，不走这里） */
export async function clearAiPortrait(userId: string): Promise<number> {
  const identity = await userIdentity(String(userId ?? '').trim())
  return deleteUserPortrait(portraitKeyOf(identity.identityId, userId))
}

/** 插件停用时收摊（当前没有可取消的句柄，留个钩子给将来加「取消生成」） */
export function disposePortrait(): void {
  running.clear()
}
