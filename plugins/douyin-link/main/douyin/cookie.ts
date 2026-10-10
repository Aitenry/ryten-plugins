/**
 * Cookie 合并：把**用户配置的登录态 Cookie** 叠加到 **进房拿到的匿名 Cookie**（ttwid 等）上。
 *
 * 为什么需要：**抖音只向「已登录会话」推送礼物消息**（`WebcastGiftMessage`）。匿名会话
 * （只有进房时发的 ttwid）在普通直播间基本收不到礼物——这正是「礼物检测只在聊天室能用」
 * 的原因（聊天室那条走的是点歌，不走礼物授权）。用户把自己的登录 Cookie 填进设置后，
 * 推送 ws 握手与房间接口就会带上它，普通直播间也能收到礼物。
 *
 * 合并规则（与参考项目 `LiukerSun/DouyinDanmu` 的 `mergeCookieHeaders` 一致）：
 * **配置里的同名键覆盖匿名的那份**（尤其是它自己的 ttwid/sessionid）。
 * 解析器对畸形输入宽容：认不出名字的片段直接跳过，绝不抛。
 */

/** 单个 cookie 名允许的字符（RFC 6265 token） */
const NAME_RE = /^[!#$%&'*+.^_`|~\w-]+$/

/** 从一段 cookie 头里解析 `名字 → 值`（顺序保留、后者覆盖前者） */
function parse(header: string, into: Map<string, string>): void {
  // 容忍用户直接粘贴整行 `Cookie: xxx`，也容忍首尾空白/BOM
  const text = String(header ?? '').replace(/^\uFEFF/, '').trim().replace(/^cookie\s*:\s*/i, '')
  if (!text) return
  for (const part of text.split(';')) {
    const item = part.trim()
    if (!item) continue
    const equal = item.indexOf('=')
    if (equal < 1) continue
    const name = item.slice(0, equal).trim()
    if (!NAME_RE.test(name)) continue
    // 值里不允许控制字符（粘贴错误时别把脏数据带进请求头）
    const value = item.slice(equal + 1).trim()
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(value)) continue
    into.set(name, value)
  }
}

/**
 * 把 `configured`（用户登录 Cookie）合并到 `anonymous`（进房拿到的）上，返回一行请求头值。
 * 只需其中一份时另一份传空串即可。
 */
export function mergeCookieHeaders(configured: string, anonymous: string): string {
  const map = new Map<string, string>()
  parse(anonymous, map)
  parse(configured, map) // 配置覆盖匿名
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ')
}