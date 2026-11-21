/**
 * dsh-notify-traffic · 监视队列（store）
 *
 * 状态派生后的宿主侧内存队列。单一 tick（1s）驱动时间推进。
 * 事件驱动、默认安静；空闲不刷新。
 */
import { createRecord, isEvictable, sortRecords, reduce, deriveColor, isFlashing } from './state.js'

export class MonitorStore {
  /**
   * @param {Object} config 已合并的配置
   */
  constructor(config = {}) {
    /** @type {Map<string, import('./state.js').SessionRecord>} */
    this.records = new Map()
    this.config = config
    this.tickTimer = null
  }

  /** 会话是否在监视范围 */
  has(sessionId) {
    return this.records.has(sessionId)
  }

  /** 取记录；不存在则建（从未运行过的新会话不主动入队由调用方保证，这里兜底） */
  get(sessionId, name) {
    let r = this.records.get(sessionId)
    if (!r) {
      r = createRecord(sessionId, name)
      this.records.set(sessionId, r)
    }
    return r
  }

  /**
   * 应用事件归约。running 事件自动入队（FR-1）。
   * @returns {boolean} 是否有实际变化（供快照节流）
   */
  apply(ev) {
    const { sessionId, kind } = ev
    if (!sessionId) return false

    if (kind === 'status-running' && !this.records.has(sessionId)) {
      // 自动加入（FR-1）
      this.records.set(sessionId, createRecord(sessionId, ev.name))
    }

    const r = this.records.get(sessionId)
    if (!r) return false

    // 先改名
    if (ev.name && ev.name !== r.name) {
      r.name = ev.name
    }

    const next = reduce(r, ev, this.config)
    if (next === r) return false
    this.records.set(sessionId, next)
    return true
  }

  /** 手动固定/取消固定 */
  setPinned(sessionId, pinned) {
    const r = this.records.get(sessionId)
    if (!r) return false
    r.pinned = pinned
    return true
  }

  /** 队列当前长度 */
  get size() {
    return this.records.size
  }

  /**
   * 单 tick（1s）：推进 green→grey、异常超时停闪、执行淘汰与容量限制。
   * 返回本次 tick 是否有状态变化。
   */
  tick(now = Date.now()) {
    let changed = false

    for (const r of this.records.values()) {
      // 异常超时（未确认超过 errorFlashMaxMs）→ 停闪转静态红（仅置标记一次）
      if (r.error.count > 0 && !r.error.acked && r.error.lastAt != null
        && (now - r.error.lastAt) >= this.config.errorFlashMaxMs
        && !r._flashTimedOut) {
        r._flashTimedOut = true
        r.lastEventAt = now
        changed = true
        continue
      }
      const next = reduce(r, { kind: 'tick', ts: now }, this.config)
      if (next !== r) {
        this.records.set(r.sessionId, next)
        changed = true
      }
    }

    // 淘汰（FR-1）
    const evictable = [...this.records.values()].filter((r) => isEvictable(r, now, this.config))
    if (this.records.size > this.config.queueCap) {
      // 超额：按最后事件时间淘汰最旧的灰项
      evictable.sort((a, b) => a.lastEventAt - b.lastEventAt)
      const excess = this.records.size - this.config.queueCap
      for (const r of evictable.slice(0, excess)) {
        this.records.delete(r.sessionId)
        changed = true
      }
    } else if (evictable.length) {
      // 未超额：只淘汰到期的灰项
      for (const r of evictable) {
        this.records.delete(r.sessionId)
        changed = true
      }
    }

    return changed
  }

  /** 移除记录（agent/disposed 或手动） */
  remove(sessionId) {
    return this.records.delete(sessionId)
  }

  /** 导出排序后的快照（不含内部字段） */
  snapshot(now = Date.now()) {
    return sortRecords([...this.records.values()], now, this.config).map((r) => ({
      sessionId: r.sessionId,
      name: r.name,
      color: deriveColor(r, now, this.config),
      flashing: isFlashing(r, now, this.config),
      pinned: r.pinned,
      pendingApprovals: r.pendingApprovals.length,
      pendingQuestions: r.pendingQuestions.length,
      errorCount: r.error.count,
      errorAcked: r.error.acked,
    }))
  }

  startTicker(onTick, intervalMs = 1000) {
    this.stopTicker()
    this.tickTimer = setInterval(() => {
      const changed = this.tick()
      if (changed) onTick?.()
    }, intervalMs)
    if (this.tickTimer.unref) this.tickTimer.unref()
  }

  stopTicker() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }
}
