/**
 * dsh-notify-traffic · 状态派生（纯函数）
 *
 * 输入：会话事件 + 时间 → 输出：四色状态。无副作用，可单测。
 */

/**
 * 会话监视记录。
 * @typedef {Object} SessionRecord
 * @property {string} sessionId
 * @property {string} name         会话显示名（标题或 id 后缀）
 * @property {'grey'|'yellow'|'green'|'red-block'|'red-error'} color
 * @property {number} lastEventAt  最后事件时间（epoch ms）
 * @property {number|null} runningSince
 * @property {string[]} pendingApprovals  未处理审批 requestId 列表
 * @property {string[]} pendingQuestions  未处理提问 requestId 列表
 * @property {{count:number, acked:boolean, lastAt:number|null}} error
 * @property {number|null} greenUntil  绿色保持截止（epoch ms）
 * @property {boolean} pinned         手动固定，不被淘汰
 */

export const COLORS = ['red-block', 'red-error', 'yellow', 'green', 'grey']

/**
 * 创建一条初始记录。
 * @param {string} sessionId
 * @param {string} name
 * @returns {SessionRecord}
 */
export function createRecord(sessionId, name = '') {
  return {
    sessionId,
    name: name || shortName(sessionId),
    color: 'grey',
    lastEventAt: Date.now(),
    runningSince: null,
    pendingApprovals: [],
    pendingQuestions: [],
    error: { count: 0, acked: true, lastAt: null },
    greenUntil: null,
    pinned: false,
  }
}

/** 会话 id 短名：取尾部 6 位。 */
export function shortName(sessionId) {
  return String(sessionId).slice(-6)
}

/**
 * 派生一个会话的最终颜色（纯函数）。
 * 优先级：红阻塞（常亮）> 红异常（闪烁/静态）> 黄 > 绿 > 灰。
 *
 * @param {SessionRecord} r
 * @param {number} now
 * @param {Object} params
 * @param {number} params.errorFlashMaxMs
 * @returns {string}
 */
export function deriveColor(r, now, { errorFlashMaxMs }) {
  const hasBlock = r.pendingApprovals.length > 0 || r.pendingQuestions.length > 0
  if (hasBlock) return 'red-block' // 规则 3：常亮红最高优先

  const hasUnackedError = r.error.count > 0 && !r.error.acked
  if (hasUnackedError) {
    // 闪烁：刚发生且未确认且未超时；超时后转静态红（仍需确认）
    const flashing = r.error.lastAt != null && (now - r.error.lastAt) < errorFlashMaxMs
    return 'red-error' // 视觉层根据 flashing 决定闪或静态
  }

  if (r.runningSince != null) return 'yellow'
  if (r.greenUntil != null && now < r.greenUntil) return 'green'
  return 'grey'
}

/** 闪烁判定：供视觉层使用。 */
export function isFlashing(r, now, { errorFlashMaxMs }) {
  return r.error.count > 0 && !r.error.acked && r.error.lastAt != null
    && (now - r.error.lastAt) < errorFlashMaxMs
}

/**
 * 聚合口径（FR-3）：红（阻塞/异常）> 绿 > 黄 > 灰。
 * @param {SessionRecord[]} records
 * @param {number} now
 * @param {Object} params
 * @param {boolean} params.includeGreen
 * @returns {{color:string, count:number}}
 */
export function aggregate(records, now, { includeGreen }) {
  const order = includeGreen
    ? ['red-block', 'red-error', 'green', 'yellow', 'grey']
    : ['red-block', 'red-error', 'yellow', 'grey']
  for (const color of order) {
    const n = records.filter((r) => deriveColor(r, now, paramsOf(now)) === color).length
    if (n > 0) return { color, count: n }
  }
  return { color: 'grey', count: 0 }
}

// 内部：deriveColor 需要 errorFlashMaxMs；聚合时取默认即可（视觉层单独处理闪烁）
function paramsOf() {
  return { errorFlashMaxMs: 600_000 }
}

/**
 * 事件 → 记录的归约（PRD 附录 A）。
 * 返回新记录；无变化返回原引用。
 * @param {SessionRecord} r
 * @param {Object} ev
 * @param {Object} params
 * @returns {SessionRecord}
 */
export function reduce(r, ev, params = {}) {
  const { greenHoldMs = 60_000 } = params
  const now = ev.ts ?? Date.now()
  let next = r

  switch (ev.kind) {
    case 'status-running':
      next = { ...r, color: 'yellow', runningSince: r.runningSince ?? now, lastEventAt: now, greenUntil: null }
      break
    case 'status-idle':
      // 正常结束/用户停止 → 绿 + greenUntil
      next = {
        ...r,
        color: 'green',
        runningSince: null,
        greenUntil: now + greenHoldMs,
        lastEventAt: now,
      }
      break
    case 'error':
      next = {
        ...r,
        error: { count: r.error.count + 1, acked: false, lastAt: now },
        runningSince: null,
        color: 'red-error',
        lastEventAt: now,
      }
      break
    case 'approval':
      if (r.pendingApprovals.includes(ev.requestId)) break
      next = { ...r, pendingApprovals: [...r.pendingApprovals, ev.requestId], color: 'red-block', lastEventAt: now }
      break
    case 'question':
      if (r.pendingQuestions.includes(ev.requestId)) break
      next = { ...r, pendingQuestions: [...r.pendingQuestions, ev.requestId], color: 'red-block', lastEventAt: now }
      break
    case 'request-handled': {
      const pa = r.pendingApprovals.filter((x) => x !== ev.requestId)
      const pq = r.pendingQuestions.filter((x) => x !== ev.requestId)
      next = { ...r, pendingApprovals: pa, pendingQuestions: pq, lastEventAt: now }
      break
    }
    case 'error-acked':
      next = { ...r, error: { ...r.error, acked: true }, greenUntil: now + greenHoldMs, lastEventAt: now }
      break
    case 'error-timeout':
      // 超时停闪：acked 仍 false，颜色保持 red-error（视觉层转静态）
      next = { ...r, lastEventAt: now }
      break
    case 'tick':
      // 单一 tick 推进 green→grey
      if (r.greenUntil != null && now >= r.greenUntil && r.color === 'green') {
        next = { ...r, greenUntil: null, color: 'grey' }
      }
      break
    default:
      break
  }

  // 颜色始终以派生为准（单一事实源）
  if (next !== r) {
    next = { ...next, color: deriveColor(next, now, { errorFlashMaxMs: params.errorFlashMaxMs ?? 600_000 }) }
  }

  return next === r ? r : next
}

/**
 * 是否可被淘汰（FR-1）：
 * - 固定 → 否
 * - 有未处理请求 → 否
 * - running → 否
 * - 异常未确认 → 否
 * - 其余：超过 idleKeepMs 无事件 → 可淘汰
 */
export function isEvictable(r, now, { idleKeepMs }) {
  if (r.pinned) return false
  if (r.pendingApprovals.length || r.pendingQuestions.length) return false
  if (r.runningSince != null) return false
  if (r.error.count > 0 && !r.error.acked) return false
  if (now - r.lastEventAt >= idleKeepMs) return true
  return false
}

/** 排序：红阻塞 > 红异常 > 黄 > 绿 > 灰；同组按最后事件时间倒序。 */
export function sortRecords(records, now, params) {
  const weight = { 'red-block': 0, 'red-error': 1, yellow: 2, green: 3, grey: 4 }
  return [...records].sort((a, b) => {
    const wa = weight[deriveColor(a, now, params)]
    const wb = weight[deriveColor(b, now, params)]
    if (wa !== wb) return wa - wb
    return b.lastEventAt - a.lastEventAt
  })
}
