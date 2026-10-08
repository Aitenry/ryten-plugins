import logger from 'electron-log'
import { withTimeout } from '../util/deadline'
import { getMeta, loadGifts, saveGifts, setMeta, type GiftRow } from '../db/mapper'

/**
 * 官方礼物目录：**giftId → 礼物名 + 抖币价**。
 *
 * 为什么要有这一层：推送帧里的 `WebcastGiftMessage` 只带 giftId（和一份可能改版的嵌套结构），
 * 想显示「礼物的额度」就必须把 id 换成权威价格；而 `diamond_count` 这种字段号没实测过，
 * 猜错就是把错误的价格显示给用户。官方这个接口**免签名**（实测 2026-10，HTTP 200 / 3.5MB /
 * 1287 件礼物，其中 1279 件带 `diamond_count`），所以：
 *
 * - 目录（id → 名称/价格）来自接口，**权威**；
 * - 解帧时只用 giftId 查表：查不到就不显示额度（宁可没有，不给错数）；
 * - 表**落进数据库**（`douyin_link_gifts` + `douyin_link_meta` 里的抓取时间与连击档），
 *   3 天过期；拉取失败沿用库里的旧表。上一版是写 JSON 文件，这一版统一进库。
 *
 * 顺带把「连击档文案」（1 一心一意 / 10 十全十美 / 520 我爱你 …）也存下来，
 * 界面上显示「送出 小心心 ×520（我爱你）」比裸数字好读。
 */

const CATALOG_URL =
  'https://live.douyin.com/webcast/gift/list/?aid=6383&app_name=douyin_web&device_platform=web&live_id=1&language=zh-CN&cookie_enabled=true'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 目录条目（解帧时按 id 查的就是它） */
export interface GiftInfo {
  id: number
  name: string
  /** 单个礼物的抖币价（0 = 官方没给价，例如免费礼物） */
  diamonds: number
  describe: string
  icon: string
}

/** 缓存有效期（3 天；礼物价格偶尔会调，但不必天天拉） */
const TTL_MS = 3 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 25000
const META_FETCHED_AT = 'gifts.fetchedAt'
const META_COMBOS = 'gifts.combos'

class GiftCatalog {
  private gifts = new Map<number, GiftInfo>()
  private combos = new Map<number, string>()
  private fetchedAt = 0
  private loading: Promise<void> | null = null
  private ready: Promise<void> | null = null

  /** 装载期调用：把库里的旧表读进内存（没有网络也能用上次的价） */
  init(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      try {
        const rows = await loadGifts()
        for (const row of rows) this.gifts.set(row.id, row)
        this.fetchedAt = Number(await getMeta(META_FETCHED_AT)) || 0
        const combos = await getMeta(META_COMBOS)
        if (combos) {
          const parsed = JSON.parse(combos) as Record<string, string>
          for (const [count, text] of Object.entries(parsed)) this.combos.set(Number(count), String(text))
        }
        logger.info(
          `[douyin-link] 礼物目录（数据库）：${this.gifts.size} 件，抓取于 ${
            this.fetchedAt ? new Date(this.fetchedAt).toLocaleString() : '（从没拉过）'
          }`
        )
      } catch (error) {
        logger.warn('[douyin-link] 礼物目录读取失败（这次先用空表）:', describe(error))
      }
    })()
    return this.ready
  }

  /** 目录里有没有这件礼物（渲染层用它判断「这次礼物认不认得」） */
  get(id: number): GiftInfo | undefined {
    return this.gifts.get(id)
  }

  /**
   * 弹幕解码器用的窄接口（`./douyin/push` 的 `GiftResolver`）：giftId → 名称与抖币价。
   *
   * 目录没就绪、或目录里没有这件礼物时返回 undefined——礼物照样显示，只是不给额度数字
   * （宁可没有数字，也不给一个错的）。
   */
  resolve(id: number): { name: string; diamonds: number } | undefined {
    const gift = this.gifts.get(id)
    return gift ? { name: gift.name, diamonds: gift.diamonds } : undefined
  }

  get size(): number {
    return this.gifts.size
  }

  get age(): number {
    return this.fetchedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.fetchedAt
  }

  /** 连击档文案（520 → 「我爱你」） */
  comboText(count: number): string {
    return this.combos.get(count) ?? ''
  }

  /** 需要时拉一次（并发去重；失败不抛，沿用旧表） */
  async ensure(force = false): Promise<void> {
    await this.init()
    if (!force && this.gifts.size > 0 && this.age < TTL_MS) return
    if (this.loading) return this.loading
    this.loading = this.fetchCatalog().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async fetchCatalog(): Promise<void> {
    try {
      const response = await withTimeout(
        fetch(CATALOG_URL, {
          headers: {
            'user-agent': UA,
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
            referer: 'https://live.douyin.com/'
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        }),
        FETCH_TIMEOUT_MS,
        'gift.catalog'
      )
      if (!response.ok) {
        logger.warn(`[douyin-link] 礼物目录返回 HTTP ${response.status}`)
        return
      }
      const json = (await response.json()) as {
        data?: {
          gifts?: Array<Record<string, unknown>>
          gifts_info?: { gift_group_infos?: Array<{ group_count?: number; group_text?: string }> }
        }
      }
      const list = json?.data?.gifts
      if (!Array.isArray(list) || list.length === 0) {
        logger.warn('[douyin-link] 礼物目录里没有 gifts 数组')
        return
      }
      const next = new Map<number, GiftInfo>()
      for (const raw of list) {
        const id = Number(raw?.id ?? 0)
        if (!Number.isFinite(id) || id <= 0) continue
        const image = raw?.image as { url_list?: unknown } | undefined
        const urls = Array.isArray(image?.url_list) ? image.url_list : []
        next.set(id, {
          id,
          name: String(raw?.name ?? '').slice(0, 40),
          diamonds: Number(raw?.diamond_count ?? 0) || 0,
          describe: String(raw?.describe ?? '').slice(0, 60),
          icon: typeof urls[0] === 'string' ? urls[0] : ''
        })
      }
      if (next.size === 0) return
      this.gifts = next
      this.combos = new Map()
      for (const group of json?.data?.gifts_info?.gift_group_infos ?? []) {
        const count = Number(group?.group_count ?? 0)
        const text = String(group?.group_text ?? '')
        if (count > 0 && text) this.combos.set(count, text)
      }
      this.fetchedAt = Date.now()
      await this.persist()
      logger.info(`[douyin-link] 礼物目录已更新：${this.gifts.size} 件，连击档 ${this.combos.size} 条`)
    } catch (error) {
      logger.warn('[douyin-link] 礼物目录拉取失败（沿用库里旧表）:', describe(error))
    }
  }

  /** 落库：目录本体进 `douyin_link_gifts`，抓取时间与连击档进 `douyin_link_meta` */
  private async persist(): Promise<void> {
    try {
      const rows: GiftRow[] = [...this.gifts.values()]
      await saveGifts(rows)
      await setMeta(META_FETCHED_AT, String(this.fetchedAt))
      await setMeta(
        META_COMBOS,
        JSON.stringify(Object.fromEntries([...this.combos.entries()].map(([key, value]) => [String(key), value])))
      )
    } catch (error) {
      logger.warn('[douyin-link] 礼物目录落库失败:', describe(error))
    }
  }

  /** 清数据用（内存侧；库表由 purge 清） */
  reset(): void {
    this.gifts = new Map()
    this.combos = new Map()
    this.fetchedAt = 0
    this.ready = null
  }
}

export const giftCatalog = new GiftCatalog()

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}
