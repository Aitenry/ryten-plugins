/**
 * 「今日消费」的进程内账本（跨全部直播间、按**本地自然日**）。
 *
 * 为什么要有它：实时列表每一行的行首都要显示「今日 N」，而按需查询是**每秒一批 id**
 * （界面按可见行 + 新到的消息批攒 id）——每次都 `sum(diamonds) group by user_id`，
 * 在永久保存、越跑越大的库上迟早把宿主的 PGlite 拖住（这条线踩过：监控一开助手输出就卡）。
 *
 * 两个入口（都在 `AnalyzerHub` 里接）：
 * - `seed(...)`：进程刚起来 / 刚换天时，从库里把今天的礼物行按人求和**补种**一次；
 * - `note(...)`：每次落库把那批礼物行的抖币**加**进来（`flush()` 里调）。
 *
 * 分天口径与库里的「每日记录」**同一套**（本地 00:00，见 `hub.localDayStart`）：
 * 界面上的「今天」与这里的「今日消费」必须是同一天，不然跨零点那会儿数字会对不上。
 */
export class TodaySpend {
  private day = ''
  private ready = false
  private byUser = new Map<string, number>()

  /** 换天就清空（调用方每次读写前先 `roll` 一下即可，不需要定时器） */
  roll(dayKey: string): boolean {
    if (dayKey === this.day) return false
    this.day = dayKey
    this.ready = false
    this.byUser.clear()
    return true
  }

  /** 库里的值是否已经补种过（没补种时 `get` 只会给到本次进程看到的增量） */
  get seeded(): boolean {
    return this.ready
  }

  /**
   * 用库里的合计补种。
   *
   * **set 而不是累加**：库是权威（它已经包含本次落库的那几批），而这里的增量可能也含同样的行
   * ——累加就会把同一份礼物算两次。
   */
  seed(values: Map<string, number>): void {
    for (const [userId, coins] of values) this.byUser.set(userId, coins)
    this.ready = true
  }

  /** 落库之后把这一批的礼物抖币加进来（只有 `gift` 且价格 > 0 的行算数） */
  note(rows: Array<{ kind: string; userId: string; diamonds: number }>): void {
    for (const row of rows) {
      if (row.kind !== 'gift' || !row.userId || !(row.diamonds > 0)) continue
      this.byUser.set(row.userId, (this.byUser.get(row.userId) ?? 0) + row.diamonds)
    }
  }

  get(userId: string): number {
    return this.byUser.get(userId) ?? 0
  }
}
