import logger from 'electron-log'
import { getMeta, setMeta } from '../db/mapper'

/**
 * 官方礼物目录：**礼物 id → 礼物名 + 抖币价**（`giftId` 是推送帧里唯一稳定的礼物标识）。
 *
 * 为什么必须有这一层（用户 2026-10-08 实测反馈「都没有看到送了什么礼物，是什么价格……
 * 只有谁送了礼物，就叫礼物而已」）：
 * 推送帧里点歌那类只给**礼物 id**（`WebcastLinkmicOrderSingMessage` 的 `6.5.1.5`）和一个
 * 场景标签（`6.5.1.10` = 「点唱礼物」），**没有礼物名**；同一个房间里不同的人点歌用的是
 * 不同的礼物（截图里就有独角兽、跑车两种图标）。所以「送了什么、值多少」只能按 id 查权威目录，
 * 不能靠猜、也不能把「点唱礼物」这种场景标签当礼物名显示。
 *
 * 目录来源：`webcast/gift/list/`（**免签名**，实测 HTTP 200 / 1282 件，其中带 `diamond_count` 的
 * 就是价格）。三条纪律沿用上一版：
 * - 目录**权威**：只按 id 查表，查不到就不显示名字/价格（宁可没有，不给错数）；
 * - 目录**落库缓存**（`douyin_link_meta` 里的两行 JSON，3 天有效）：重启与离线时沿用上次那份，
 *   不必每次开应用都拉 3.5MB；
 * - 拉取失败**不抛**：整条监听照常跑，只是这一轮没有名字可显示。
 *
 * 顺带一个自检（`noteFramePrice`）：帧里自带的抖币价与目录对不上时写一条 warn——
 * 那种时候说明我们对该字段的读法错了（第一次核对是在 2026-10-08：(3200, 99) 与目录里
 * 「爱的纸鹤 = 99」一致），日志里能第一时间发现。
 */

const CATALOG_URL =
  'https://live.douyin.com/webcast/gift/list/?aid=6383&app_name=douyin_web&device_platform=web&live_id=1&language=zh-CN&cookie_enabled=true'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 目录条目（解码时按 id 查的就是它） */
export interface GiftInfo {
  id: number
  name: string
  /** 单个礼物的抖币价（0 = 官方没给价，例如免费礼物） */
  diamonds: number
}

/**
 * 解码器要的窄接口：**只认这一个方法**。
 *
 * 这样 `douyin/proto-messages.ts` 与 `douyin/json.ts` 仍然是纯函数（依赖由调用方注入），
 * 可以离线单测；没有目录时传 `undefined`，解出来的就是「没有名字/没有价格」。
 */
export interface GiftResolver {
  resolve(id: number): { name: string; diamonds: number } | undefined
  /**
   * 按**礼物名**反查（可选）：真礼物帧的结构我们还没吃透时，只要帧里出现了某个礼物名
   * （目录里有 1000 多个名字），就能确认是这件礼物、并拿到它的价。
   * 同名多件且价格不一致时返回 undefined——宁可没有，不给错价。
   */
  resolveByName?(name: string): { name: string; diamonds: number } | undefined
  /** 运行时自检（可选）：帧里自带的抖币价与目录对不上时记一笔 */
  noteFramePrice?(id: number, framePrice: number): void
}

/** 缓存有效期（3 天；礼物价格偶尔会调，但不必天天拉） */
const TTL_MS = 3 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 25000
const META_FETCHED_AT = 'gifts.fetchedAt'
const META_CATALOG = 'gifts.catalog'
/** 目录里我们真的会用的字段：id → [名字, 抖币价]（存 JSON 比建表省事，一份 ~40KB） */
type CatalogJson = Record<string, [string, number]>

class GiftCatalog implements GiftResolver {
  private gifts = new Map<number, GiftInfo>()
  /** 名字 → 候选礼物（反查用；同名多件时看价格是否一致） */
  private byName = new Map<string, GiftInfo[]>()
  private fetchedAt = 0
  private loading: Promise<void> | null = null
  private ready: Promise<void> | null = null
  /** 已经警告过「帧里的价与目录不符」的礼物 id（同一条只吵一次） */
  private readonly warned = new Set<number>()

  /** 装载期调用：把库里的旧目录读进内存（没有网络也能用上次的价） */
  init(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      try {
        const raw = await getMeta(META_CATALOG)
        if (raw) {
          const parsed = JSON.parse(raw) as CatalogJson
          for (const [id, entry] of Object.entries(parsed)) {
            const giftId = Number(id)
            if (!Number.isFinite(giftId) || giftId <= 0) continue
            this.gifts.set(giftId, { id: giftId, name: String(entry?.[0] ?? ''), diamonds: Number(entry?.[1] ?? 0) || 0 })
          }
        }
        this.reindex()
        this.fetchedAt = Number(await getMeta(META_FETCHED_AT)) || 0
        logger.info(
          `[douyin-link] 礼物目录（库里缓存）：${this.gifts.size} 件，抓取于 ${
            this.fetchedAt ? new Date(this.fetchedAt).toLocaleString() : '（从没拉过）'
          }`
        )
      } catch (error) {
        logger.warn('[douyin-link] 礼物目录读取失败（这次先用空表）:', describe(error))
      }
    })()
    return this.ready
  }

  /** 目录里有没有这件礼物（拿不到名字/价格时解码器就用帧里自带的字段兜底） */
  resolve(id: number): { name: string; diamonds: number } | undefined {
    const hit = this.gifts.get(id)
    return hit ? { name: hit.name, diamonds: hit.diamonds } : undefined
  }

  /** 按名字反查（真礼物帧里出现了某个目录礼物名时用它确认礼物与价格） */
  resolveByName(name: string): { name: string; diamonds: number } | undefined {
    const hits = this.byName.get(name.trim())
    if (!hits || hits.length === 0) return undefined
    const first = hits[0]
    // 同名多件且价格不一致：认不出来就是认不出来（不给错价）
    if (hits.some((gift) => gift.diamonds !== first.diamonds)) return undefined
    return { name: first.name, diamonds: first.diamonds }
  }

  get size(): number {
    return this.gifts.size
  }

  get age(): number {
    return this.fetchedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.fetchedAt
  }

  /** 需要时拉一次（并发去重；失败不抛，沿用库里旧表） */
  async ensure(force = false): Promise<void> {
    await this.init()
    if (!force && this.gifts.size > 0 && this.age < TTL_MS) return
    if (this.loading) return this.loading
    this.loading = this.fetchCatalog().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /**
   * 帧里自带的抖币价 → 与目录对不上就警告一次。
   *
   * 这是**运行时自检**：点歌帧的「5 = 礼物 id、6 = 抖币价」这个读法只做过一次交叉核对
   * （2026-10-08），真出现不符就是读错了，日志里立刻能看见。
   */
  noteFramePrice(id: number, framePrice: number): void {
    if (id <= 0 || framePrice <= 0) return
    const hit = this.gifts.get(id)
    if (!hit || hit.diamonds <= 0 || this.warned.has(id)) return
    if (hit.diamonds === framePrice) return
    this.warned.add(id)
    logger.warn(
      `[douyin-link] 礼物 ${id}：帧里的价格 ${framePrice} 与官方目录的 ${hit.diamonds}（${hit.name}）不一致——` +
        '点歌帧「5 = 礼物 id、6 = 抖币价」这个读法需要重新核对'
    )
  }

  /** 建「名字 → 候选礼物」索引（目录换了之后重建一次） */
  private reindex(): void {
    this.byName.clear()
    for (const gift of this.gifts.values()) {
      if (!gift.name) continue
      const list = this.byName.get(gift.name)
      if (list) list.push(gift)
      else this.byName.set(gift.name, [gift])
    }
  }

  private async fetchCatalog(): Promise<void> {
    try {
      const response = await fetch(CATALOG_URL, {
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: 'https://live.douyin.com/'
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) {
        logger.warn(`[douyin-link] 礼物目录返回 HTTP ${response.status}（沿用库里旧表）`)
        return
      }
      const json = (await response.json()) as { data?: { gifts?: Array<Record<string, unknown>> } }
      const list = json?.data?.gifts
      if (!Array.isArray(list) || list.length === 0) {
        logger.warn('[douyin-link] 礼物目录里没有 gifts 数组（沿用库里旧表）')
        return
      }
      const next = new Map<number, GiftInfo>()
      for (const raw of list) {
        const id = Number(raw?.id ?? 0)
        if (!Number.isFinite(id) || id <= 0) continue
        next.set(id, {
          id,
          name: String(raw?.name ?? '').slice(0, 40),
          diamonds: Number(raw?.diamond_count ?? 0) || 0
        })
      }
      if (next.size === 0) return
      // 整份替换：价格是会变的，只补缺会让旧价永远留着
      this.gifts = next
      this.reindex()
      this.fetchedAt = Date.now()
      this.warned.clear()
      logger.info(`[douyin-link] 礼物目录已更新：${next.size} 件（带价格 ${countPriced(next)} 件）`)
      await this.persist()
    } catch (error) {
      logger.warn('[douyin-link] 礼物目录拉取失败（沿用库里旧表）:', describe(error))
    }
  }

  /** 落库：整份目录压成一行 JSON 进 `douyin_link_meta`（不建表，卸载/清数据时随 meta 一起走） */
  private async persist(): Promise<void> {
    try {
      const payload: CatalogJson = {}
      for (const [id, gift] of this.gifts) payload[String(id)] = [gift.name, gift.diamonds]
      await setMeta(META_CATALOG, JSON.stringify(payload))
      await setMeta(META_FETCHED_AT, String(this.fetchedAt))
    } catch (error) {
      logger.warn('[douyin-link] 礼物目录落库失败:', describe(error))
    }
  }
}

function countPriced(gifts: Map<number, GiftInfo>): number {
  let count = 0
  for (const gift of gifts.values()) if (gift.diamonds > 0) count += 1
  return count
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
}

/** 单例：主进程里只有一份目录（两个采集通道共用） */
export const giftCatalog = new GiftCatalog()
