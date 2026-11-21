/**
 * dsh-notify-traffic · 声音决策引擎（FR-6）
 *
 * 宿主侧纯决策：合并、去抖、优先级、静默时段、类型开关。
 * 输出"播报指令"（要播什么），实际播放由面板进程执行。
 */

// 优先级：阻塞 > 异常 > 完成
const PRIORITY = { approval: 3, question: 3, error: 2, completion: 1 }

/** 阻塞类：抢占播放，只用一个很短的合并窗口（吸收同一瞬间的多条）。 */
const BLOCKING = new Set(['approval', 'question', 'error'])
const BLOCKING_WINDOW_MS = 400

export class SoundEngine {
  /**
   * @param {Object} config 已合并配置（sound.* 子对象展平）
   * @param {Function} [onSpeak] 播报产出回调 (item) => void
   */
  constructor(config = {}, onSpeak) {
    this.config = config
    this.onSpeak = onSpeak
    /** 合并窗口缓冲：kind → { count, firstAt, sessionIds:Set } */
    this.pending = new Map()
    /** 去抖：sessionId:kind → lastPlayedAt */
    this.lastPlayed = new Map()
    /** 定时器 */
    this.flushTimer = null
  }

  /**
   * 事件进来，决定是否/何时播报。
   * @param {Object} ev { kind: 'approval'|'question'|'error'|'completion', sessionId, name, ts }
   * @param {Object} state { unfocused:boolean }
   * @returns {Array<{priority:number, text:string, at:number, mergeKey:string}>} 排定播报
   */
  push(ev, state = {}) {
    const cfg = this.config
    const now = ev.ts ?? Date.now()

    // 总开关
    if (!cfg.enabled) return []

    // 类型开关
    const typeKey = { approval: 'approval', question: 'question', error: 'error', completion: 'completion' }[ev.kind]
    if (!cfg[typeKey]) return []

    // 静默时段：完成音静默；阻塞/异常仍播（验收 9）
    if (ev.kind === 'completion' && this.inQuietHours(now)) return []

    // onlyWhenUnfocused：完成音只在 DSH 失焦时播报（避免自己工作时被"任务完成"吵到）；
    // 阻塞（审批/提问/异常）始终播报——需要用户立即注意
    const blocking = ev.kind === 'approval' || ev.kind === 'question' || ev.kind === 'error'
    if (cfg.onlyWhenUnfocused && !blocking && state.unfocused !== true) return []

    // 去抖：同一会话同一类型 dedupeMs 内只播一次
    const dedupeKey = `${ev.sessionId}:${ev.kind}`
    const last = this.lastPlayed.get(dedupeKey)
    if (last != null && (now - last) < cfg.dedupeMs) return []

    // 合并：阻塞类抢占（短窗口），完成类用完整窗口（验收 7/8）
    const windowMs = BLOCKING.has(ev.kind)
      ? Math.min(cfg.mergeWindowMs, BLOCKING_WINDOW_MS)
      : cfg.mergeWindowMs
    const buf = this.pending.get(ev.kind)
    if (buf) {
      buf.count += 1
      buf.sessionIds.add(ev.sessionId)
      buf.lastAt = now
      if (!buf.firstName && ev.name) buf.firstName = ev.name
      // 到窗口尾触发 flush
      if (!buf.timer) {
        buf.timer = setTimeout(() => this.flush(ev.kind, now + windowMs), windowMs)
        if (buf.timer.unref) buf.timer.unref()
      }
      return []
    }

    const nb = {
      kind: ev.kind,
      count: 1,
      firstAt: now,
      lastAt: now,
      sessionIds: new Set([ev.sessionId]),
      firstName: ev.name ?? '',
      timer: null,
    }
    this.pending.set(ev.kind, nb)
    nb.timer = setTimeout(() => this.flush(ev.kind, now + windowMs), windowMs)
    if (nb.timer.unref) nb.timer.unref()
    return []
  }

  /** 窗口到点，把缓冲合并为一条播报。 */
  flush(kind, at) {
    const buf = this.pending.get(kind)
    if (!buf) return []
    this.pending.delete(kind)
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null }

    const text = this.template(kind, buf)
    // 记录去抖（合并条目里的每个会话都算播过）
    for (const sid of buf.sessionIds) {
      this.lastPlayed.set(`${sid}:${kind}`, at)
    }
    return [{
      priority: PRIORITY[kind] ?? 0,
      text,
      at,
      mergeKey: kind,
    }].map((item) => {
      this.onSpeak?.(item)
      return item
    })
  }

  /** 模板（FR-6）：可自定义文案，不可自定义结构。 */
  template(kind, buf) {
    const { t = {} } = this.config
    const n = buf.count
    const speakName = this.config.speakSessionName !== false
    const firstName = speakName ? (buf.firstName ?? '') : ''
    switch (kind) {
      case 'approval':
        return n === 1 ? t.approval?.replace('{name}', firstName) ?? `会话「${firstName}」需要你审批` : `${n} 个会话需要审批`
      case 'question':
        return n === 1 ? t.question?.replace('{name}', firstName) ?? `会话「${firstName}」有一个问题` : `${n} 个会话有问题`
      case 'error':
        return n === 1 ? t.error?.replace('{name}', firstName) ?? `会话「${firstName}」出错` : `${n} 个会话出错`
      case 'completion':
        return n === 1 ? t.completion ?? `任务完成` : `${n} 个任务完成`
      default:
        return ''
    }
  }

  /** 静默时段：'HH:MM-HH:MM' 或空。跨午夜支持。 */
  inQuietHours(now) {
    const q = this.config.quietHours
    if (!q || typeof q !== 'string') return false
    const m = q.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
    if (!m) return false
    const d = new Date(now)
    const cur = d.getHours() * 60 + d.getMinutes()
    const s = +m[1] * 60 + +m[2]
    const e = +m[3] * 60 + +m[4]
    if (s <= e) return cur >= s && cur < e
    return cur >= s || cur < e // 跨午夜
  }

  /** 立即清空缓冲（会话结束/禁用时） */
  clear() {
    for (const buf of this.pending.values()) {
      if (buf.timer) clearTimeout(buf.timer)
    }
    this.pending.clear()
  }
}
