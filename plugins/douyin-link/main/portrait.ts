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
  AiPortraitRole,
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
  userHostSignal,
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
 * 一次生成的**时间预算**（2026-10-13 用户报「小模型会报错，本地的 ollama 模型」之后改的口径）。
 *
 * 原来是「180 秒墙钟硬超时」，对本地模型是错的：本机实测 qwen3.5-9b-32k（Q4_K_M，Ollama 本机）
 * **21.6 token/s**、前置处理 2~20 秒，而这条供应商的输出上限是 4000 token
 * ⇒ 4000 / 21.6 ≈ 185 秒，**刚好越过 180 秒**：模型还在正常出字，先被我掐了
 * （用户看到的就是「模型调用失败：This operation was aborted」——AbortController 的原文）。
 *
 * 所以改成两个口径：
 * - `stallMs`：**多久没有任何输出**才算卡住。思考型模型会静默好几分钟——LangChain 的 Ollama
 *   只转发 `content`、`thinking` 帧被丢掉（见 @langchain/ollama 的 `convertOllamaStream`），
 *   所以「安静」不等于「死了」，静默门槛必须给宽；
 * - `totalMs`：一次生成的墙钟上限，给得很宽（本地小模型就是慢），界面随时可以点「停止」。
 *
 * 工装可以把这两个数调小来验超时与取消路径（`ai-portrait-model-check.mjs` 就是这么做的）。
 */
export const PORTRAIT_BUDGETS = {
  /** 静默多久算卡住：本地模型可能长时间思考，给到 5 分钟 */
  stallMs: 5 * 60_000,
  /** 一次生成的总上限：30 分钟（配合界面上的「停止」按钮） */
  totalMs: 30 * 60_000
}

/** 一次生成的任务句柄（去重 + 看门狗 + 停止都靠它） */
interface PortraitJob {
  requestId: string
  startedAt: number
  controller: AbortController
  /** 用户点了「停止」 */
  cancelled: boolean
  /** 已经被写出来的正文字符数（失败/停止时如实报给日志与用户） */
  writtenChars?: number
  /** 我们主动中止时的原因（比 AbortError 的原文有用得多） */
  abortReason?: string
}

/** 正在跑的那一次（按缓存键去重；「停止」靠这里的 controller 真正掐断底层请求） */
const running = new Map<string, PortraitJob>()

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
    role: row.role === 'host' ? 'host' : 'viewer',
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

/* --------------------------------------------------------------- 角色（观众 / 主播） */

/** 「收到这么多条礼物」才够说明他是主播（观众被回礼一两次不算） */
const HOST_GIFT_HITS = 2

/** 外部传进来的角色参数：只有明确说 `host` / `viewer` 才信，其它（含 `null`）= 自动判定 */
export function portraitRoleArg(value: unknown): AiPortraitRole | null {
  return value === 'host' || value === 'viewer' ? value : null
}

/**
 * 判定该按哪个角色分析（用户 2026-10-13：「应该是分析主播（个播、房间播有好多主播的）和用户，两者分开」）。
 *
 * 三条证据，从硬到软：
 * 1. **本场正在麦上 / 是本房间主播**（调用方从 `recorder` 拿的运行态信号，最硬）；
 * 2. **历史上在麦位表或房间主播里出现过**（`douyin_link_users.on_mic`，粘性列）——
 *    这一条能救「现在没开播但过去当过主播」的人；
 * 3. **礼物方向**：收到过 ≥2 条礼物、且收的抖币比送的多——主播靠收礼，观众靠送礼。
 *    要求「收比送多」是因为观众也会被回礼，只看「收过礼」会把大方的老观众误判成主播。
 *
 * 判定**只用来定默认值**：弹窗上用户可以随时切成另一个角色（两种身份都当过的人很常见），
 * 而且两侧的画像各存各的，切回去不用重新花钱。
 */
export async function detectPortraitRole(input: {
  /** 这个人的全部账号 id（与材料同一份集合） */
  ids: string[]
  /** 运行态：此刻他在麦上、或他就是本房间主播 */
  liveHost?: boolean
}): Promise<AiPortraitRole> {
  if (input.liveHost === true) return 'host'
  if (input.ids.length === 0) return 'viewer'
  const signal = await userHostSignal(input.ids).catch(() => null)
  if (!signal) return 'viewer'
  if (signal.onMic) return 'host'
  if (signal.receivedGifts >= HOST_GIFT_HITS && signal.receivedDiamonds > signal.sentDiamonds) return 'host'
  return 'viewer'
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
  /** 想看的角色（`null`/未给 = 用自动判定的那个） */
  role?: AiPortraitRole | null
  /** 运行态信号：此刻他在麦上、或他就是本房间主播 */
  liveHost?: boolean
  settings: Pick<LiveSettings, 'portraitProviderId' | 'portraitDisableThinking'>
}): Promise<AiPortraitState> {
  const userId = String(input.userId ?? '').trim()
  const selectedProviderId = portraitProviderSetting(input.settings)
  if (!userId) {
    return {
      portrait: null,
      role: 'viewer',
      detectedRole: 'viewer',
      current: { fingerprint: '', interactions: 0 },
      running: false,
      models: await listPortraitModels(),
      selectedProviderId
    }
  }
  const [identity, ids, models] = await Promise.all([userIdentity(userId), accountIdsOf(userId), listPortraitModels()])
  const detectedRole = await detectPortraitRole({ ids, liveHost: input.liveHost })
  const role = input.role ?? detectedRole
  const key = portraitKeyOf(identity.identityId, userId, role)
  const row = await getUserPortrait(key)
  const { totals, lastSeen } = await totalsOf(ids)
  return {
    portrait: toPortrait(row),
    role,
    detectedRole,
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
  /** 要生成哪个角色的那一版（`null`/未给 = 用自动判定的那个） */
  role?: AiPortraitRole | null
  /** 运行态信号：此刻他在麦上、或他就是本房间主播 */
  liveHost?: boolean
  /** 档案（由 hub 提供：静态字段的口径与弹窗上显示的那份完全一致） */
  profile: UserDetail | null
  settings: Pick<LiveSettings, 'portraitProviderId' | 'portraitDisableThinking'>
  force?: boolean
}): Promise<AiPortraitResult> {
  const userId = String(input.userId ?? '').trim()
  if (!userId) return failure('no-data')

  const [identity, ids] = await Promise.all([userIdentity(userId), accountIdsOf(userId)])
  const detectedRole = await detectPortraitRole({ ids, liveHost: input.liveHost })
  const role: AiPortraitRole = input.role ?? detectedRole
  const key = portraitKeyOf(identity.identityId, userId, role)
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
  /**
   * 「关掉本地模型的思考」（设置页开关，默认关）：只对**支持 `think` 的模型**生效
   * （`@langchain/ollama` 建出来的实例上有这个属性；别的供应商没有 → 原样不动）。
   *
   * 为什么不默认关：`think` 是 Ollama 的原生参数，关掉等于**改了模型的行为**，
   * 而且老版本 Ollama / 非思考型模型遇到它会不会报错我们没法在本机全部验到——
   * 所以做成用户显式打开，并把实测数字写在设置页说明里。
   */
  const disableThinking = input.settings.portraitDisableThinking === true
  const thinkingHolder = model as unknown as { think?: boolean }
  if (disableThinking && 'think' in thinkingHolder && thinkingHolder.think !== false) {
    thinkingHolder.think = false
    logger.info(`[douyin-link] AI 画像：按设置下发 think=false（关掉本地模型的思考）`)
  }

  const prompt = buildPortraitPrompt({
    anchor: { userId, name: input.profile?.nickname ?? '' },
    role,
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
  const controller = new AbortController()
  const job: PortraitJob = { requestId, startedAt: now, controller, cancelled: false }
  running.set(key, job)
  logger.info(
    `[douyin-link] AI 画像开始：${role === 'host' ? '主播' : '观众'} · 第 ${(cachedRow?.version ?? 0) + 1} 版 · ` +
      `${providerName || providerId}/${modelName || '?'} · ` +
      `材料 ${prompt.chars.total} 字符（system ${prompt.chars.system} + user ${prompt.chars.user}）· ` +
      `互动 ${prompt.interactions} 条 · 弹幕样本 ${extras.recentChat.length} · 送礼样本 ${extras.sentGifts.length} · ` +
      `静默上限 ${Math.round(PORTRAIT_BUDGETS.stallMs / 1000)}s / 总上限 ${Math.round(PORTRAIT_BUDGETS.totalMs / 60000)}min`
  )

  try {
    const { text, inputTokens, outputTokens } = await streamPortrait(model, prompt, requestId, job)
    const report = parsePortraitReport(text)
    const portrait: AiPortrait = {
      key,
      userId,
      role,
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
      role,
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
      `[douyin-link] AI 画像完成：${role === 'host' ? '主播' : '观众'} · 第 ${portrait.version} 版 · ${text.length} 字符 · ` +
        `token ${inputTokens}/${outputTokens} · ${report ? '结构化成功' : '未按 JSON 回（按原文显示）'}`
    )
    return { ok: true, portrait }
  } catch (error) {
    /**
     * 失败如实分三类（用户 2026-10-13 报的就是第一类，原文只有一句
     * 「This operation was aborted」，谁也看不出为什么）：
     * - **用户点了「停止」** → `cancelled`（界面用一行中性文案，不当错误吓人）；
     * - **静默超时 / 总超时** → 带上真实秒数、已经写了多少字，以及本地模型的成因提示；
     * - 其它 → 模型/网络原话。
     */
    if (job.cancelled) {
      logger.info(`[douyin-link] AI 画像已被用户停止（已写 ${job.writtenChars ?? 0} 字符）`)
      return failure('cancelled')
    }
    const elapsedSec = Math.round((Date.now() - job.startedAt) / 1000)
    const detail = job.abortReason ?? describe(error)
    logger.warn(`[douyin-link] AI 画像失败（${elapsedSec}s）：${detail}`)
    return failure('model-failed', detail)
  } finally {
    running.delete(key)
    broadcast(AI_PORTRAIT_EVENT, { requestId, delta: '', done: true } satisfies AiPortraitChunk)
  }
}

/**
 * 停止某个人的生成（界面上的「停止」按钮）→ 掐断底层请求。
 *
 * 为什么需要它：本地小模型一次可能跑十几分钟（实测 9B/Q4 约 21.6 token/s，4000 token 上限就是
 * 3 分钟起步；更慢的机器上更久），没有停止按钮的话用户只能干等。返回 `true` = 确实掐了一次。
 *
 * 为什么不收角色参数（0.15.32 起角色进了缓存键）：界面上的「停止」要**永远有效**，
 * 而按人物前缀扫一遍运行中的任务既不用界面记住「我点的是哪一版」，也顺手覆盖了
 * 「切到主播那一版之后忘了先停观众那一版」这种情况。
 */
export async function cancelAiPortrait(userId: string): Promise<boolean> {
  const id = String(userId ?? '').trim()
  if (!id) return false
  // 与 generate 同一套缓存键口径：优先按画像 id 找（多账号的人几个号共用一次生成）
  const identity = await userIdentity(id).catch(() => null)
  const identityId = identity?.identityId ?? 0
  const prefix = identityId > 0 ? `identity:${identityId}:` : `user:${id}:`
  let stopped = false
  for (const [key, job] of running) {
    if (!key.startsWith(prefix) || job.cancelled) continue
    job.cancelled = true
    job.controller.abort()
    stopped = true
    logger.info(`[douyin-link] AI 画像收到停止请求（key=${key}，已写 ${job.writtenChars ?? 0} 字符）`)
  }
  return stopped
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
  requestId: string,
  job: PortraitJob
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { SystemMessage, HumanMessage } = await import('@langchain/core/messages')
  const controller = job.controller
  /**
   * 看门狗（**替代原来的 180 秒墙钟硬超时**，见 `PORTRAIT_BUDGETS` 的注释）：
   * 每收到一段就重新计时，所以「模型只是慢 / 在长时间思考」不会被误杀，
   * 只有**真的不再吐字**才中止；总墙上限另算，给得很宽。
   */
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      job.abortReason =
        `模型已经 ${Math.max(1, Math.round(PORTRAIT_BUDGETS.stallMs / 1000))} 秒没有任何输出（已写 ${job.writtenChars ?? 0} 字符），已中止` +
        `。本地模型长时间思考、或输出上限太大时常见；可换更快的模型，或在供应商高级参数里关掉思考（think: false）`
      controller.abort()
    }, PORTRAIT_BUDGETS.stallMs)
  }
  armStall()
  const totalTimer = setTimeout(() => {
    job.abortReason = `模型 ${Math.round(PORTRAIT_BUDGETS.totalMs / 60000)} 分钟还没写完，已中止`
    controller.abort()
  }, PORTRAIT_BUDGETS.totalMs)
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  try {
    const stream = await model.stream(
      [new SystemMessage(prompt.system), new HumanMessage(prompt.user)],
      { signal: controller.signal }
    )
    for await (const chunk of stream) {
      // 收到分片 = 「还活着」（思考型模型的 thinking 帧会被 LangChain 丢掉，所以真卡住时连帧都没有）
      armStall()
      const delta = chunkText(chunk)
      const usage = (chunk as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata
      if (usage) {
        inputTokens = Math.max(inputTokens, Math.round(Number(usage.input_tokens) || 0))
        outputTokens = Math.max(outputTokens, Math.round(Number(usage.output_tokens) || 0))
      }
      if (!delta) continue
      text += delta
      job.writtenChars = text.length
      broadcast(AI_PORTRAIT_EVENT, { requestId, delta, done: false } satisfies AiPortraitChunk)
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    clearTimeout(totalTimer)
  }
  if (job.cancelled) throw new Error('已停止')
  if (controller.signal.aborted) {
    throw new Error(job.abortReason ?? `模型在 ${Math.round((Date.now() - job.startedAt) / 1000)} 秒后中止`)
  }
  if (!text.trim()) {
    /**
     * **一个字正文都没有**：2026-10-13 实测本机 Ollama 的 qwen3.5-9b-32k 正是这样——
     * 4000 token 的输出预算全烧在推理上（15,890 字思考），正文为空，花了 190 秒。
     * 有 token 消耗 ⇒ 这几乎一定就是思考吃掉了预算，所以把「怎么救」直接写进失败原因，
     * 不要只说一句「模型没有返回任何内容」让用户去猜。
     */
    throw new Error(
      outputTokens > 0
        ? `模型输出了 ${outputTokens} 个 token，但**正文一个字都没有**：思考型模型（qwen3 这类）把输出预算全用在推理上了。` +
          `到「设置 → 抖音直播分析器 → 关掉本地模型的思考」打开开关即可（同一份材料实测：190 秒 0 字 → 52 秒 2114 字）`
        : '模型没有返回任何内容'
    )
  }
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

/**
 * 清掉某个人的 AI 画像（设置页/工装用；界面上的「重新生成」是覆盖写，不走这里）。
 *
 * 两个角色各有一版（缓存键里带角色），所以这里**两份都清**，返回清掉的行数——
 * 只清一半会留下一个界面读得到、用户以为已经删了的旧版本。
 */
export async function clearAiPortrait(userId: string): Promise<number> {
  const id = String(userId ?? '').trim()
  const identity = await userIdentity(id)
  const keys = [
    portraitKeyOf(identity.identityId, id, 'viewer'),
    portraitKeyOf(identity.identityId, id, 'host')
  ]
  let removed = 0
  for (const key of keys) removed += await deleteUserPortrait(key)
  return removed
}

/** 插件停用时收摊（当前没有可取消的句柄，留个钩子给将来加「取消生成」） */
export function disposePortrait(): void {
  running.clear()
}
