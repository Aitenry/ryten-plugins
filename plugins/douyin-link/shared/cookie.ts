/**
 * 登录态 Cookie 的**解析 / 上限 / 体检**（主进程与渲染层**共用同一份**）。
 *
 * 为什么要有这一份：这个 cookie 原先在两处各写各的常数——`renderer/api.ts` 与
 * `main/monitor/hub.ts` 都把它**静默切到 4096 字符**。而真实的一份登录态 cookie 有 6 KB 上下
 * （2026-10-10 实测用户粘贴的那份：**6071 字符 / 70 个字段**），被切掉的恰好是**尾巴上的字段**：
 * `ttwid` / `odin_tt` / `x_tt_token` / `bd_ticket_guard_client_data` /
 * `__security_mc_1_s_sdk_*` 全在尾巴上。于是界面上看着「cookie 已经填好」，
 * 实际发出去的那一行已经不是用户粘贴的那一行（`sessionid` 还在、绑定的 `ttwid` 却没了），
 * 抖音按无效会话处理 → 弹幕/礼物一条都拉不到。
 *
 * 三条纪律（照这个插件一贯的口径）：
 * - 上限**只有一个数**（`COOKIE_MAX_LENGTH`），两边同源，别再各自写一个 4096；
 * - 上限必须**远高于真实 cookie**，只在「粘贴了一大坨别的东西」时才生效；
 * - 真的截断了**要能被上层看见**（返回 `truncated`，设置页据此给一行提示），**不许静默**。
 */

/** 单份 cookie 的上限：12 KiB（真实登录态 cookie 约 6 KB，留一倍余量） */
export const COOKIE_MAX_LENGTH = 12 * 1024

/** 单个 cookie 名允许的字符（RFC 6265 token） */
const NAME_RE = /^[!#$%&'*+.^_`|~\w-]+$/

/**
 * 去壳：用户很可能连着整行 `Cookie: xxx` 一起复制，也可能带上首尾空白/BOM。
 * 这三样在**解析**和**存盘**时都得先去掉，否则第一段的键名就带上了 `Cookie:`。
 */
export function stripCookiePrefix(raw: unknown): string {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
}

/** 上限检查的结果：`length` 是**截断前**的长度（设置页要拿它说人话） */
export interface ClampedCookie {
  value: string
  truncated: boolean
  /** 截断前的字符数 */
  length: number
}

/**
 * 收口 Cookie 的**唯一入口**（渲染层归一化与主进程存盘都走它）。
 *
 * 注意 `truncated`：调用方**必须**把这件事说出来（主进程写一行 warn、设置页给一行提示）。
 * 这个 bug 之所以能藏那么久，就是因为截断是无声的——用户看到的输入框里是完整的，
 * 存下去的却是前半截。
 */
export function clampCookie(raw: unknown): ClampedCookie {
  const text = stripCookiePrefix(raw)
  return {
    value: text.slice(0, COOKIE_MAX_LENGTH),
    truncated: text.length > COOKIE_MAX_LENGTH,
    length: text.length
  }
}

/**
 * 从一行 cookie 里解析 `名字 → 值`（顺序保留、**后者覆盖前者**）。
 *
 * 宽容解析：认不出名字的片段直接跳过，绝不抛——用户粘贴的可能是整行 `Cookie:`、
 * 可能多带了引号或换行，这里不该因为一段脏数据就把整份 cookie 丢掉。
 * 值里不允许控制字符（粘贴错误时别把脏数据带进请求头）。
 */
export function parseCookiePairs(header: unknown): Array<[string, string]> {
  const text = stripCookiePrefix(header)
  if (!text) return []
  const map = new Map<string, string>()
  for (const part of text.split(';')) {
    const item = part.trim()
    if (!item) continue
    const equal = item.indexOf('=')
    if (equal < 1) continue
    const name = item.slice(0, equal).trim()
    if (!NAME_RE.test(name)) continue
    const value = item.slice(equal + 1).trim()
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(value)) continue
    map.set(name, value)
  }
  return [...map]
}

/** cookie 体检：设置页据此判断「这份 cookie 到底是不是登录态的」 */
export interface CookieHealth {
  /** 认出来的字段数 */
  fields: number
  /** 有 `sessionid` / `sessionid_ss`（登录态的标志） */
  hasSession: boolean
  /** 有 `ttwid`（匿名也要它；接口没有它会返回 200 空 body） */
  hasTtwid: boolean
  /** 缺的关键字段名（给界面拼提示用；都在 = 空数组） */
  missing: string[]
}

/**
 * 体检。**只报事实，不猜**：`sessionid` 在 = 登录态；`ttwid` 在 = 至少能当匿名会话用。
 * 两个都没有的 cookie（例如从「未登录」的页面复制来的那份）抖音会当空会话，
 * 界面上应该直说，而不是让用户对着「填了却没内容」发呆。
 */
export function cookieHealth(raw: unknown): CookieHealth {
  const names = new Set(parseCookiePairs(raw).map(([name]) => name))
  const hasSession = names.has('sessionid') || names.has('sessionid_ss')
  const hasTtwid = names.has('ttwid')
  const missing: string[] = []
  if (!hasSession) missing.push('sessionid')
  if (!hasTtwid) missing.push('ttwid')
  return { fields: names.size, hasSession, hasTtwid, missing }
}
