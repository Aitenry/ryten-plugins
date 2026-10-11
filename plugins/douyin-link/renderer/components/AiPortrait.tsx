import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Tag } from 'antd'
import { RiFileTextLine, RiQuillPenLine, RiRefreshLine, RiStopCircleLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type {
  AiPortrait,
  AiPortraitFailure,
  AiPortraitReport,
  AiPortraitState
} from '../../shared/types'
import { partialPortraitReport } from '../../shared/ai-portrait'
import api from '../api'
import { ScrollStyle, formModalProps, usePluginPalette, type PluginPalette } from './ui'
import { MODAL_Z } from './modal-z'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 「AI 画像」弹窗：**用大模型**（宿主里配置的那份，与 harness 同一个）写一份全面画像。
 *
 * 与档案右栏那个「分析用户」（确定性算法画像）刻意分开：
 * - 那一份窄、快、免费、可复现——回答「数据里量到了什么」；
 * - 这一份宽、慢、要花 token——回答「这是个什么样的人、为什么留在这里、该怎么维护」。
 *
 * 三条产品决定：
 * 1. **结果落库**（用户 2026-10-13：「需要保存这个画像，不然每一次都要重新生成，会很亏 token」）：
 *    打开弹窗只读缓存、**不自动生成**——没生成过就显示一个说明 + 一枚「生成画像」按钮，
 *    把「会花钱」这件事说在点下去之前（模型名与互动条数都写出来）；
 * 2. **生成过程可见**：流式增量到了就**边收边解析已闭合的字段**（`partialPortraitReport`），
 *    画像一节一节省出来，而不是贴半截 JSON、也不是对着转圈等一分钟；
 * 3. **数据变了要说**：生成时的互动量记在画像里，之后又攒了新数据就提示「可重新生成」，
 *    不装作画像永远新鲜；「重新生成」会把上一版喂回模型做**迭代**（版本号 +1）。
 */
export function AiPortraitModal(props: {
  /** 档案静态字段按房间取（与弹窗上显示的那份口径一致）；大屏模式传空串 */
  webRid: string
  userId: string
  /** 显示名（弹窗标题与没生成时的说明里用） */
  name: string
  onClose: () => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [state, setState] = useState<AiPortraitState | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  /** 流式收到的原文（主进程逐段推来；界面只渲染其中**已闭合**的字段） */
  const [streamed, setStreamed] = useState('')
  const [failure, setFailure] = useState<{ reason: AiPortraitFailure | 'bridge'; detail?: string } | null>(null)
  /** 看模型原文（结构化成功时也能看：它是这次生成的原始证据） */
  const [showRaw, setShowRaw] = useState(false)
  /**
   * 只认「这一次生成」的增量。
   *
   * 主进程自己生成 requestId，界面事先不知道，所以：开始生成时打开闸门，**第一条增量**到了
   * 就把它的 id 记下来，之后只认这个 id（切人 / 重新生成时迟到的旧增量直接丢）。
   */
  const requestRef = useRef('')
  const acceptingRef = useRef(false)

  /**
   * 拉一次状态。
   *
   * 主进程说「正在生成」时**把闸门打开**：别的窗口发起的那一次，我们接着看它的流
   * （`done` 到了会再调一次这个函数拿最终结果）；否则把生成态收掉。
   */
  const load = useCallback(async (): Promise<void> => {
    const next = await api.aiPortrait(props.userId)
    setState(next)
    acceptingRef.current = next.running
    setGenerating(next.running)
  }, [props.userId])

  useEffect(() => {
    let alive = true
    setFailure(null)
    setStreamed('')
    setShowRaw(false)
    requestRef.current = ''
    acceptingRef.current = false
    /**
     * 没开（`userId` 为空）就**什么都不查**：弹窗是常驻挂载的（antd 只在第一次 open 后保留节点），
     * 空 id 也去问一次主进程，白跑一趟查询、还会在别的弹窗开着时留下一次无意义的通道调用
     * （工装 `ai-portrait-render-check.mjs` 第 1 段就是钉这件事）。
     */
    if (!props.userId) {
      setLoading(false)
      setGenerating(false)
      return () => {
        alive = false
      }
    }
    setLoading(true)
    void api
      .aiPortrait(props.userId)
      .then((next) => {
        if (!alive) return
        setState(next)
        if (next.running) {
          acceptingRef.current = true
          setGenerating(true)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [props.userId])

  /** 流式增量：先认 id，再累积；`done` 到了就把最终结果拉一次 */
  useEffect(() => {
    const off = api.onAiPortrait((chunk) => {
      if (!acceptingRef.current) return
      if (!requestRef.current) requestRef.current = chunk.requestId
      if (chunk.requestId !== requestRef.current) return
      if (chunk.delta) setStreamed((text) => text + chunk.delta)
      if (chunk.done) {
        acceptingRef.current = false
        void load()
      }
    })
    return off
  }, [load])

  const generate = useCallback(
    (force: boolean): void => {
      setGenerating(true)
      setFailure(null)
      setStreamed('')
      setShowRaw(false)
      requestRef.current = ''
      acceptingRef.current = true
      void api
        .aiPortraitGenerate(props.webRid, props.userId, force)
        .then((result) => {
          acceptingRef.current = false
          if (!result.ok) {
            setFailure({ reason: result.reason ?? 'model-failed', detail: result.detail })
            return
          }
          void load()
        })
        .catch(() => setFailure({ reason: 'bridge' }))
        .finally(() => setGenerating(false))
    },
    [load, props.userId, props.webRid]
  )

  /**
   * 「停止」：掐断正在跑的那一次（本地小模型一次可能跑十几分钟，光等不行）。
   *
   * 不做乐观更新：主进程那次生成会以 `cancelled` 收尾，`generate()` 的回话拿到它就置失败行——
   * 于是界面上「正在生成」的转圈与文案都由**同一条真回话**驱动，不会出现两边说法不一致。
   */
  const stop = useCallback((): void => {
    void api.aiPortraitCancel(props.userId).catch(() => undefined)
  }, [props.userId])

  const portrait = state?.portrait ?? null
  // 生成中优先显示流里的半成品（它才是最“新”的），否则显示缓存/刚拿到的成品
  const partial = generating && streamed ? partialPortraitReport(streamed) : null
  const report = partial ?? portrait?.report ?? null
  /**
   * 模型标签：`供应商名 · 模型名`；**两者相同时只写一遍**——本地 Ollama 的供应商常常就用模型名
   * 命名（用户 2026-10-13 的截图里那行是 `qwen3.5-9b-32k:latest · qwen3.5-9b-32k:latest`）。
   */
  const modelTextOf = (name: string, model: string): string => {
    const left = String(name ?? '').trim()
    const right = String(model ?? '').trim()
    if (left && right) return left === right ? right : `${left} · ${right}`
    return left || right
  }
  const modelLabel = ((): string => {
    if (!state) return ''
    if (portrait && portrait.model) return modelTextOf(portrait.providerName, portrait.model)
    const selected = state.models.find((entry) => entry.id === state.selectedProviderId)
    const fallback = selected ?? state.models.find((entry) => entry.isDefault) ?? state.models[0]
    if (!fallback) return ''
    return modelTextOf(fallback.name, fallback.model)
  })()
  const gained = portrait ? Math.max(0, (state?.current.interactions ?? 0) - portrait.interactions) : 0

  return (
    <Modal
      {...formModalProps}
      open={Boolean(props.userId)}
      title={t('douyin-link.users.aiTitle')}
      onCancel={props.onClose}
      footer={null}
      /* 叠在用户档案（1000）与礼物日历（1100）之上：它从档案里开出来，不能被档案盖住 */
      zIndex={MODAL_Z.portrait}
      width={760}
    >
      {/*
        关着的时候**不渲染正文**（连滚动条样式一起）：这份画像可能很长（几节 + 证据 + 建议），
        弹窗节点在 antd 里是常驻的（第一次打开后不再销毁），留着旧正文既浪费内存、
        也会让「关掉档案之后它还挂着」变成看不见的状态（工装 `ai-portrait-render-check.mjs`
        用「正文有没有」来判断开关，比 jsdom 里量 display 可靠）。
      */}
      {props.userId ? (
        <div className="flex flex-col gap-3">
          <ScrollStyle />
          {/* 头部：谁、哪个模型、哪一版、什么时候生成的——全是可核对的事实 */}
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="min-w-0 truncate text-sm font-semibold">
                {props.name || t('douyin-link.page.unknownUser')}
              </span>
              <span className="min-w-0 text-[11px] leading-4 opacity-60">
                {t('douyin-link.users.aiScopeHint')}
                {modelLabel ? ` · ${t('douyin-link.users.aiModel')} ${modelLabel}` : ''}
                {portrait && portrait.version > 0
                  ? ` · ${t('douyin-link.users.aiVersion', { n: portrait.version })}`
                  : ''}
                {portrait && portrait.generatedAt > 0
                  ? ` · ${t('douyin-link.users.aiGeneratedAt')} ${stamp(portrait.generatedAt)}`
                  : ''}
                {portrait
                  ? ` · ${t('douyin-link.users.aiBasedOn', { n: formatNumber(portrait.interactions) })}`
                  : ''}
                {portrait && portrait.outputTokens > 0
                  ? ` · ${t('douyin-link.users.aiTokens', {
                      input: formatNumber(portrait.inputTokens),
                      output: formatNumber(portrait.outputTokens)
                    })}`
                  : ''}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              {/* 生成中：只能「停止」（本地小模型一次可能跑十几分钟，光等不行）；
                  生成结束后：才是「看原文 / 重新生成」 */}
              {generating ? (
                <Button size="small" icon={<RiStopCircleLine size={13} />} onClick={stop}>
                  {t('douyin-link.users.aiStop')}
                </Button>
              ) : (
                <>
                  {portrait ? (
                    <Button
                      size="small"
                      icon={<RiFileTextLine size={13} />}
                      onClick={() => setShowRaw((open) => !open)}
                    >
                      {showRaw ? t('douyin-link.users.aiHideRaw') : t('douyin-link.users.aiShowRaw')}
                    </Button>
                  ) : null}
                  {portrait ? (
                    <Button size="small" icon={<RiRefreshLine size={13} />} onClick={() => generate(true)}>
                      {t('douyin-link.users.aiRegenerate')}
                    </Button>
                  ) : null}
                </>
              )}
            </span>
          </div>

          {/* 数据涨了就如实说：生成时记下的互动量 vs 现在的互动量 */}
          {portrait && !generating && gained > 0 ? (
            <span className="text-[11px] leading-4" style={{ color: palette.warn }}>
              {t('douyin-link.users.aiDataGrew', { n: formatNumber(gained) })}
            </span>
          ) : null}

          {/* 失败 / 已停止：**停止不算错误**，用中性文案与中性色，别把用户的主动操作涂成红的 */}
          {failure ? (
            <span
              className="text-xs leading-5"
              style={{ color: failure.reason === 'cancelled' ? palette.axis : palette.down }}
            >
              {failureText(t, failure.reason, failure.detail)}
            </span>
          ) : null}

          {loading ? (
            <span className="text-xs opacity-60">{t('douyin-link.users.aiLoading')}</span>
          ) : (
            <>
              {generating ? <GeneratingLine t={t} chars={streamed.length} palette={palette} /> : null}
              {report ? (
                <ReportView report={report} palette={palette} t={t} />
              ) : generating ? null : portrait && portrait.raw ? (
                /* 结构化失败（模型没按 JSON 回）：**不丢内容**，按原文显示 */
                <>
                  <span className="text-[11px] leading-4 opacity-60">{t('douyin-link.users.aiUnstructured')}</span>
                  <pre
                    className="m-0 whitespace-pre-wrap break-words rounded-md px-2.5 py-2 text-xs leading-5"
                    style={{ backgroundColor: palette.soft }}
                  >
                    {portrait.raw}
                  </pre>
                </>
              ) : (
                <EmptyState
                  t={t}
                  modelLabel={modelLabel}
                  hasModel={Boolean(modelLabel)}
                  onClick={() => generate(false)}
                />
              )}
            </>
          )}

          {/* 「看原文」：结构化的那一份也留了模型原文，方便核对它到底写了什么 */}
          {showRaw && portrait && portrait.raw && report ? (
            <pre
              className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md px-2.5 py-2 text-[11px] leading-5 opacity-80"
              style={{ backgroundColor: palette.soft }}
              data-rb-scroll=""
            >
              {portrait.raw}
            </pre>
          ) : null}

          <span className="text-[10px] leading-4 opacity-50">{t('douyin-link.users.aiFooter')}</span>
        </div>
      ) : null}
    </Modal>
  )
}

/** 还没生成过：把「会花 token、用哪个模型」说在点按钮之前 */
function EmptyState(props: {
  t: Translate
  modelLabel: string
  hasModel: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs leading-5 opacity-75">{props.t('douyin-link.users.aiIntro')}</span>
      <span className="text-[11px] leading-4 opacity-60">
        {props.hasModel
          ? props.t('douyin-link.users.aiWillUse', { model: props.modelLabel })
          : props.t('douyin-link.users.aiNoModel')}
      </span>
      <span>
        <Button
          type="primary"
          size="small"
          disabled={!props.hasModel}
          icon={<RiQuillPenLine size={14} />}
          onClick={props.onClick}
        >
          {props.t('douyin-link.users.aiGenerate')}
        </Button>
      </span>
    </div>
  )
}

/** 生成中（还解析不出任何完整字段时）：一行状态，别让用户对着空白等 */
function GeneratingLine(props: { t: Translate; chars: number; palette: PluginPalette }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2 text-xs opacity-70">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: props.palette.accent }} />
      {props.chars > 0
        ? props.t('douyin-link.users.aiWriting', { n: formatNumber(props.chars) })
        : props.t('douyin-link.users.aiThinking')}
    </span>
  )
}

/**
 * 报告正文：**模型是唯一作者**，这里只做版式（不自造、不改写内容）。
 *
 * 版式沿插件既有的编辑部风格：小标题是纯文本标签（不带装饰圆点），条目用一枚强调色圆点，
 * 证据成对（原话 + 它说明什么），局限压到最淡——信息密度靠**层级**，不靠色块与边框。
 */
function ReportView(props: {
  report: AiPortraitReport
  palette: PluginPalette
  t: Translate
}): React.JSX.Element {
  const { report, palette, t } = props
  return (
    <div className="flex flex-col gap-3">
      {report.persona || report.headline ? (
        <div className="flex flex-col gap-1">
          {report.persona ? (
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-base font-semibold" style={{ color: palette.accent }}>
                {report.persona}
              </span>
              {report.tags.map((tag) => (
                <Tag key={tag} style={{ marginInlineEnd: 0 }}>
                  {tag}
                </Tag>
              ))}
            </span>
          ) : null}
          {report.headline ? (
            <span className="text-xs leading-5 opacity-80">{report.headline}</span>
          ) : null}
        </div>
      ) : null}

      {report.overview ? (
        <span className="text-xs leading-5 opacity-80">{report.overview}</span>
      ) : null}

      {report.sections.map((section, index) => (
        <div key={`${section.title}-${index}`} className="flex flex-col gap-1">
          <span className="text-xs font-medium">{section.title}</span>
          {section.items.map((item, itemIndex) => (
            <span key={itemIndex} className="flex items-start gap-1 text-[11px] leading-4 opacity-80">
              <span style={{ color: palette.accent }}>•</span>
              <span className="min-w-0 flex-1">{item}</span>
            </span>
          ))}
        </div>
      ))}

      {report.evidence.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t('douyin-link.users.aiEvidenceTitle')}</span>
          {report.evidence.map((item, index) => (
            <span key={index} className="text-[11px] leading-4 opacity-80">
              {item.quote ? <span style={{ color: palette.accent }}>「{item.quote}」</span> : null}
              {item.note ? <span className="opacity-70">{item.quote ? ` —— ${item.note}` : item.note}</span> : null}
            </span>
          ))}
        </div>
      ) : null}

      {report.suggestions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t('douyin-link.users.aiSuggestionsTitle')}</span>
          {report.suggestions.map((item, index) => (
            <span key={index} className="flex items-start gap-1 text-[11px] leading-4 opacity-80">
              <span className="tabular-nums opacity-60">{index + 1}.</span>
              <span className="min-w-0 flex-1">{item}</span>
            </span>
          ))}
        </div>
      ) : null}

      {report.caveats.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t('douyin-link.users.aiCaveatsTitle')}</span>
          {report.caveats.map((item, index) => (
            <span key={index} className="text-[11px] leading-4 opacity-60">
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 失败文案：机器码在主进程、文案在这里（翻不到就退回通用句 + 明细） */
function failureText(t: Translate, reason: AiPortraitFailure | 'bridge', detail?: string): string {
  const key = `douyin-link.users.aiError${reason.charAt(0).toUpperCase()}${reason.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()).slice(1)}`
  const text = t(key, { detail: detail ?? '' })
  if (!text.startsWith('douyin-link.')) return text
  return t('douyin-link.users.aiErrorGeneric', { detail: detail ?? '' })
}
