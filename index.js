/**
 * dsh-notify-traffic · 宿主侧
 *
 * 职责：
 *  - 订阅 agent/status、agent/error、agent/disposed → 维护每会话四色状态
 *  - 在 agent 作用域以 prepend 抢占 approval/request、user-questions/request，
 *    把请求交给悬浮窗决定；超时则 next() 放行给宿主默认 answerer（内置 UI）
 *  - 声音决策（合并窗口 / 去重 / 优先级 / 静默时段）→ 待播队列
 *  - /notify-traffic/* HTTP 路由：状态快照、审批/提问决定、异常已读、形态与焦点
 *
 * 为什么审批只在宿主侧答：内置 dsh-client-ui-approval 的 PendingApproval 没有任何
 * RPC，审批只能由持有瀑布链的一端结算。若宿主与客户端同时订阅，就是 PRD R4 的
 * 双答竞态。这里让宿主成为唯一消费者，面板经 HTTP 下决定，天然幂等。
 *
 * @module dsh-notify-traffic
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MonitorStore } from './lib/store.js'
import { SoundEngine } from './lib/sound.js'
import { aggregate } from './lib/state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 本模块被加载时读到的版本。磁盘上变了说明有更新，但内存里还是这版。 */
const RUNNING_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
})()

/** 磁盘上现在的版本 */
function diskVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

/** Cordis 插件名 */
export const name = 'notify-traffic'

/** 悬浮窗数据面只需要 webServer */
export const inject = ['webServer']

/** 路由前缀 */
const PREFIX = '/notify-traffic'

/** 待播声音队列上限 */
const MAX_PENDING_SOUNDS = 20

/** 默认配置（对齐 PRD §9） */
const DEFAULTS = {
  mode: 'standard',
  form: 'card',
  /**
   * 悬浮窗落点：
   *  - system  ：独立原生窗口（DSH 最小化后仍悬浮在所有应用之上）
   *  - inframe ：DSH 界面内的帧浮层
   *  - both    ：两者都开
   *  - off     ：都不显示（只保留数据面）
   */
  overlay: 'system',
  greenHoldMs: 60_000,
  idleKeepMs: 300_000,
  queueCap: 20,
  aggregateIncludeGreen: true,
  errorFlashMaxMs: 600_000,
  answerTimeoutMs: 120_000,
  pollIntervalMs: 1000,
  sound: {
    enabled: true,
    approval: true,
    question: true,
    error: true,
    completion: true,
    onlyWhenUnfocused: true,
    quietHours: '',
    volume: 0.6,
    speakSessionName: true,
    mergeWindowMs: 3000,
    dedupeMs: 60_000,
    voice: 'default',
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = mergeConfig(config ?? {})
  const logger = ctx.logger?.('notify-traffic') ?? console

  const store = new MonitorStore(cfg)
  const pendingSounds = []
  const sound = new SoundEngine(cfg.sound, (item) => {
    pendingSounds.push(item)
    while (pendingSounds.length > MAX_PENDING_SOUNDS) pendingSounds.shift()
  })

  /** sessionId → 会话名 */
  const names = new Map()
  /** requestId → { sessionId, kind, promise 控制块 } */
  const pending = new Map()
  /** requestId → 卡片载荷（交给面板渲染） */
  const cards = new Map()
  /** 已消费过的 requestId（幂等，防重复提交） */
  const consumed = new Set()
  /** Client 上报的窗口焦点 */
  let dshFocused = true
  let form = cfg.form
  let disposed = false
  /** 系统级悬浮窗子进程（null = 未运行） */
  let systemOverlay = null
  let overlayOrigin = ''
  /** 悬浮窗点会话后，等 DSH 页面的 Client 执行真正的会话切换 */
  let pendingFocus = null
  /** 诊断计数：窗口里的点击有没有打到路由 */
  const hits = { focusSession: 0, focusDone: 0, answer: 0, reply: 0, ack: 0, config: 0 }

  // ── 会话名 ──────────────────────────────────────────────
  function sessionName(agent) {
    const sid = String(agent?.id ?? agent?.session?.id ?? '')
    if (sid === '') return ''
    const cached = names.get(sid)
    if (cached !== undefined) return cached
    let name = ''
    try {
      const title = ctx.get('sessionTitle')
      if (title !== undefined && agent?.session !== undefined) {
        const snap = title.get?.(agent.session)
        if (snap?.title) name = String(snap.title)
      }
    } catch {
      /* sessionTitle 未就绪 */
    }
    if (name === '') name = sid.slice(-6)
    // 统一截断：列表用 CSS 省略，语音只念短名
    name = truncateName(name)
    names.set(sid, name)
    return name
  }

  // ── 卡片与请求的生命周期 ────────────────────────────────
  function openRequest({ requestId, sessionId, kind, name, payload }) {
    // 同上：请求可能先于任何状态事件到达
    store.get(sessionId, name)
    cards.set(requestId, {
      requestId,
      sessionId,
      kind, // approval | question
      name,
      at: Date.now(),
      ...payload,
    })
    store.apply({ sessionId, name, kind, requestId })
  }

  function closeRequest(requestId) {
    cards.delete(requestId)
    const rec = findRecordByRequestId(requestId)
    if (rec !== undefined) {
      store.apply({ sessionId: rec.sessionId, kind: 'request-handled', requestId })
    }
  }

  function findRecordByRequestId(requestId) {
    for (const r of store.records.values()) {
      if (r.pendingApprovals.includes(requestId) || r.pendingQuestions.includes(requestId)) return r
    }
    return undefined
  }

  /** 面板下决定：批准/拒绝/回答。幂等：同一 requestId 只生效一次。 */
  function settle(requestId, outcome) {
    if (consumed.has(requestId)) return { ok: true, already: true }
    const entry = pending.get(requestId)
    if (entry === undefined) return { ok: false, error: 'unknown request' }
    consumed.add(requestId)
    pending.delete(requestId)
    clearTimeout(entry.timer)
    closeRequest(requestId)
    entry.resolve(outcome)
    return { ok: true }
  }

  /** 异常已读 */
  function ackError(sessionId) {
    if (sessionId === '') return
    store.apply({ sessionId, kind: 'error-acked' })
  }

  // ── UI 版本 ─────────────────────────────────────────────
  /** 悬浮窗页面的版本：HTML 的 mtime。改 HTML 后窗口会自行 reload。 */
  function overlayRevision() {
    try {
      return statSync(join(__dirname, 'bin', 'overlay.html')).mtimeMs
    } catch {
      return 0
    }
  }

  // ── 快照 ────────────────────────────────────────────────
  function buildState(now = Date.now()) {
    const sessions = store.snapshot(now)
    const { color, count } = aggregate(
      [...store.records.values()],
      now,
      { includeGreen: cfg.aggregateIncludeGreen },
    )
    const sounds = pendingSounds.splice(0, pendingSounds.length)
    return {
      ok: true,
      now,
      sessions,
      aggregate: { color, count },
      cards: [...cards.values()],
      sounds,
      focus: dshFocused,
      uiRev: overlayRevision(),
      version: RUNNING_VERSION,
      diskVersion: diskVersion(),
      settings: {
        mode: cfg.mode,
        form,
        overlay: cfg.overlay,
        overlayRunning: systemOverlay !== null,
        overlaySupported: overlayBinary() !== null,
        focusRequest:
          pendingFocus !== null && Date.now() - pendingFocus.ts < 30_000
            ? { sessionId: pendingFocus.sessionId, ts: pendingFocus.ts }
            : null,
        hits: { ...hits },
        greenHoldMs: cfg.greenHoldMs,
        idleKeepMs: cfg.idleKeepMs,
        queueCap: cfg.queueCap,
        errorFlashMaxMs: cfg.errorFlashMaxMs,
        pollIntervalMs: cfg.pollIntervalMs,
        sound: cfg.sound,
      },
    }
  }

  // ── 系统级悬浮窗（原生子进程）──────────────────────────
  // DSH 的宿主插件跑在 ELECTRON_RUN_AS_NODE 的 Node 子进程里，拿不到 Electron
  // 主进程的窗口 API。要做出「DSH 最小化后仍浮在所有应用之上」的窗口，只能
  // spawn 一个自己的原生窗口进程（bin/ntf-overlay，AppKit + WKWebView）。
  const OVERLAY_BIN = join(__dirname, 'bin', 'ntf-overlay')
  const OVERLAY_SRC = join(__dirname, 'bin', 'overlay.swift')

  /** 二进制是否需要重编：缺失，或源码比产物新（升级后旧二进制不该继续跑） */
  function overlayStale() {
    if (!existsSync(OVERLAY_BIN)) return true
    try {
      const src = statSync(OVERLAY_SRC)
      const bin = statSync(OVERLAY_BIN)
      return src.mtimeMs > bin.mtimeMs
    } catch {
      return true
    }
  }

  /** 二进制路径；缺失或源码更新时用 swiftc 现场编译一次 */
  function overlayBinary() {
    if (process.platform !== 'darwin') return null
    if (!existsSync(OVERLAY_SRC)) return existsSync(OVERLAY_BIN) ? OVERLAY_BIN : null
    if (!overlayStale()) return OVERLAY_BIN
    try {
      const result = spawnSyncCompile()
      if (result) return OVERLAY_BIN
    } catch (error) {
      logger.warn?.(`notify-traffic: overlay build failed: ${error?.message ?? error}`)
    }
    // 编译失败但旧二进制还在：继续用旧的，别把窗口搞没
    return existsSync(OVERLAY_BIN) ? OVERLAY_BIN : null
  }

  function spawnSyncCompile() {
    // 同步编译：只在首次缺二进制时跑一次，避免异步竞态
    execFileSync('swiftc', ['-O', '-o', OVERLAY_BIN, OVERLAY_SRC], {
      stdio: 'ignore',
      timeout: 120_000,
    })
    return existsSync(OVERLAY_BIN)
  }

  function startSystemOverlay() {
    if (disposed) return
    if (systemOverlay !== null && systemOverlay.exitCode === null) return
    if (cfg.overlay !== 'system' && cfg.overlay !== 'both') return
    const bin = overlayBinary()
    if (bin === null) {
      logger.warn?.('notify-traffic: 系统悬浮窗不可用（缺少二进制且无法编译）')
      return
    }
    if (overlayOrigin === '') {
      try {
        overlayOrigin = ctx.webServer.getOrigin()
      } catch {
        overlayOrigin = ''
      }
    }
    if (overlayOrigin === '') return

    const url = `${overlayOrigin}${PREFIX}/overlay`
    try {
      // 只传 URL：初始尺寸由二进制决定（332×300），页面随后按内容自适应
      const child = spawn(bin, ['--url', url], {
        stdio: 'ignore',
        detached: false,
      })
      systemOverlay = child
      child.on('exit', (code) => {
        if (systemOverlay === child) systemOverlay = null
        if (!disposed && code !== 0) {
          logger.warn?.(`notify-traffic: 系统悬浮窗退出（code ${code}）`)
        }
      })
      child.on('error', (error) => {
        if (systemOverlay === child) systemOverlay = null
        logger.warn?.(`notify-traffic: 无法启动系统悬浮窗: ${error?.message ?? error}`)
      })
      logger.info?.(`notify-traffic: 系统悬浮窗已启动（${url}）`)
    } catch (error) {
      systemOverlay = null
      logger.warn?.(`notify-traffic: 系统悬浮窗启动失败: ${error?.message ?? error}`)
    }
  }

  function stopSystemOverlay() {
    const child = systemOverlay
    systemOverlay = null
    if (child === null) return
    try {
      if (child.exitCode === null) child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }

  // ── 设置读写 ───────────────────────────────────────────
  /** 交给设置页的可编辑配置 */
  function publicConfig() {
    return {
      overlay: cfg.overlay,
      form,
      greenHoldMs: cfg.greenHoldMs,
      idleKeepMs: cfg.idleKeepMs,
      queueCap: cfg.queueCap,
      aggregateIncludeGreen: cfg.aggregateIncludeGreen,
      errorFlashMaxMs: cfg.errorFlashMaxMs,
      answerTimeoutMs: cfg.answerTimeoutMs,
      pollIntervalMs: cfg.pollIntervalMs,
      sound: { ...cfg.sound },
    }
  }

  /** 白名单清洗：只接受已知字段与类型 */
  function sanitizeConfig(patch) {
    const out = {}
    const num = (v, lo, hi) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return undefined
      return Math.min(hi, Math.max(lo, Math.round(n)))
    }
    if (patch.overlay === 'system' || patch.overlay === 'inframe' || patch.overlay === 'both' || patch.overlay === 'off') {
      out.overlay = patch.overlay
    }
    if (patch.form === 'card' || patch.form === 'bar' || patch.form === 'compact') out.form = patch.form
    for (const [key, lo, hi] of [
      ['greenHoldMs', 0, 3_600_000],
      ['idleKeepMs', 30_000, 86_400_000],
      ['queueCap', 1, 200],
      ['errorFlashMaxMs', 0, 3_600_000],
      ['answerTimeoutMs', 10_000, 1_800_000],
      ['pollIntervalMs', 300, 60_000],
    ]) {
      const v = num(patch[key], lo, hi)
      if (v !== undefined) out[key] = v
    }
    if (typeof patch.aggregateIncludeGreen === 'boolean') {
      out.aggregateIncludeGreen = patch.aggregateIncludeGreen
    }
    if (patch.sound !== null && typeof patch.sound === 'object') {
      const s = {}
      for (const key of ['enabled', 'approval', 'question', 'error', 'completion', 'onlyWhenUnfocused', 'speakSessionName']) {
        if (typeof patch.sound[key] === 'boolean') s[key] = patch.sound[key]
      }
      if (typeof patch.sound.quietHours === 'string') {
        const raw = patch.sound.quietHours.trim()
        s.quietHours = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(raw) ? raw : ''
      }
      const vol = Number(patch.sound.volume)
      if (Number.isFinite(vol)) s.volume = Math.min(1, Math.max(0, vol))
      for (const key of ['mergeWindowMs', 'dedupeMs']) {
        const v = num(patch.sound[key], 0, 600_000)
        if (v !== undefined) s[key] = v
      }
      if (Object.keys(s).length > 0) out.sound = s
    }
    return out
  }

  /** 写回 profile 配置；同时立即更新内存，让当前进程的行为马上一致 */
  async function saveConfig(patch) {
    const clean = sanitizeConfig(patch)
    if (Object.keys(clean).length === 0) return { ok: false, error: '没有可保存的字段' }

    // 内存先生效（系统窗口 / 声音等即时可见）。
    // 注意保留 cfg.sound 的对象引用：SoundEngine 构造时持有它，
    // 替换对象会让已构造的引擎继续读旧值。
    const soundRef = cfg.sound
    const nextCfg = mergeConfig({ ...cfg, ...clean, sound: { ...soundRef, ...(clean.sound ?? {}) } })
    Object.assign(cfg, nextCfg)
    Object.assign(soundRef, cfg.sound)
    cfg.sound = soundRef
    if (clean.form !== undefined) form = clean.form
    if (clean.overlay !== undefined) {
      if (clean.overlay === 'system' || clean.overlay === 'both') startSystemOverlay()
      else stopSystemOverlay()
    }

    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) {
      return { ok: true, persisted: false, error: '当前 profile 无法持久化配置', config: publicConfig() }
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...clean, sound: { ...(current?.sound ?? {}), ...(clean.sound ?? {}) } }))
      return { ok: true, persisted: true, config: publicConfig() }
    } catch (error) {
      return {
        ok: true,
        persisted: false,
        error: `保存被拒绝：${error?.message ?? error}`,
        config: publicConfig(),
      }
    }
  }

  /** 把 DSH 窗口调到前台 */
  function activateDsh() {
    try {
      spawn('/usr/bin/open', ['-a', 'DeepSeek Harness'], { stdio: 'ignore', detached: true }).unref?.()
    } catch (error) {
      logger.warn?.(`notify-traffic: 激活 DSH 失败: ${error?.message ?? error}`)
    }
  }

  /**
   * 悬浮窗点会话：会话切换不走 URL 路由（是 Web 端内部状态），
   * 所以这里只登记请求，由页面里的 Client 用 uiWorkspace.openSession() 执行。
   */
  function requestFocusSession(sessionId) {
    pendingFocus = { sessionId, ts: Date.now() }
    activateDsh()
  }

  // ── HTTP ───────────────────────────────────────────────
  function sendJson(res, status, payload) {
    if (res.writableEnded || res.destroyed) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function readJson(req, cap = 64 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > cap) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim() === '') return resolve({})
        try {
          resolve(JSON.parse(raw))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  async function handler(req, res) {
    if (disposed) {
      sendJson(res, 503, { ok: false, error: 'disposed' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname.startsWith(PREFIX)
      ? url.pathname.slice(PREFIX.length) || '/'
      : url.pathname
    const method = req.method ?? 'GET'

    try {
      if (pathname === '/state' && method === 'GET') {
        sendJson(res, 200, buildState())
        return
      }

      if (pathname === '/answer' && method === 'POST') {
        const body = await readJson(req)
        const requestId = typeof body?.requestId === 'string' ? body.requestId : ''
        const outcome = body?.outcome
        if (requestId === '') {
          sendJson(res, 400, { ok: false, error: 'requestId required' })
          return
        }
        if (outcome !== 'allowed-once' && outcome !== 'rejected') {
          sendJson(res, 400, { ok: false, error: 'outcome must be allowed-once or rejected' })
          return
        }
        hits.answer += 1
        sendJson(res, 200, settle(requestId, outcome))
        return
      }

      if (pathname === '/reply' && method === 'POST') {
        const body = await readJson(req)
        const requestId = typeof body?.requestId === 'string' ? body.requestId : ''
        if (requestId === '') {
          sendJson(res, 400, { ok: false, error: 'requestId required' })
          return
        }
        const answers = Array.isArray(body?.answers) ? body.answers : []
        hits.reply += 1
        sendJson(res, 200, settle(requestId, { answers }))
        return
      }

      if (pathname === '/ack' && method === 'POST') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        hits.ack += 1
        ackError(sessionId)
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/mode' && method === 'POST') {
        const body = await readJson(req)
        const nextMode = body?.mode
        const nextForm = body?.form
        if (nextMode === 'standard' || nextMode === 'compact') cfg.mode = nextMode
        if (nextForm === 'card' || nextForm === 'bar' || nextForm === 'compact') form = nextForm
        sendJson(res, 200, { ok: true, mode: cfg.mode, form })
        return
      }

      if (pathname === '/focus' && method === 'POST') {
        const body = await readJson(req)
        if (typeof body?.focused === 'boolean') dshFocused = body.focused
        sendJson(res, 200, { ok: true, focus: dshFocused })
        return
      }

      if (pathname === '/pin' && method === 'POST') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId !== '') store.setPinned(sessionId, body?.pinned === true)
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/dismiss' && method === 'POST') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId !== '') store.remove(sessionId)
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/overlay' && method === 'GET') {
        // 系统悬浮窗的页面：由宿主同源提供，页面里的 fetch 不受跨域限制
        try {
          const html = readFileSync(join(__dirname, 'bin', 'overlay.html'), 'utf8')
          if (res.writableEnded || res.destroyed) return
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(html),
          })
          res.end(html)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: `overlay page missing: ${error?.message ?? error}` })
        }
        return
      }

      if (pathname === '/overlay/revision' && method === 'GET') {
        sendJson(res, 200, { ok: true, rev: overlayRevision() })
        return
      }

      if (pathname === '/focus-session' && method === 'POST') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: 'sessionId required' })
          return
        }
        hits.focusSession += 1
        requestFocusSession(sessionId)
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/focus-done' && method === 'POST') {
        // Client 已把会话切过去的回执（用于验证闭环）
        hits.focusDone += 1
        pendingFocus = null
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/focus-app' && method === 'POST') {
        activateDsh()
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/config' && method === 'GET') {
        hits.config += 1
        sendJson(res, 200, { ok: true, config: publicConfig() })
        return
      }

      if (pathname === '/config' && method === 'POST') {
        const body = await readJson(req)
        const patch = body?.config
        if (patch === null || typeof patch !== 'object') {
          sendJson(res, 400, { ok: false, error: 'config object required' })
          return
        }
        const saved = await saveConfig(patch)
        sendJson(res, 200, saved)
        return
      }

      if (pathname === '/overlay/restart' && method === 'POST') {
        stopSystemOverlay()
        setTimeout(() => startSystemOverlay(), 250)
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { ok: false, error: `unknown route ${method} ${pathname}` })
    } catch (error) {
      logger.warn?.(`notify-traffic route failed: ${error?.message ?? error}`)
      try {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      } catch {
        try {
          res.destroy()
        } catch {
          /* socket 已断开 */
        }
      }
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'notify-traffic: http surface')

  // ── 状态事件 ────────────────────────────────────────────
  ctx.on('agent/status', (ev) => {
    const sid = String(ev.agent?.id ?? ev.agent ?? '')
    if (sid === '') return
    const nm = sessionName(ev.agent)
    store.apply({
      sessionId: sid,
      name: nm,
      kind: ev.status === 'running' ? 'status-running' : 'status-idle',
    })
    if (ev.status !== 'running') {
      sound.push(
        { kind: 'completion', sessionId: sid, name: nm, ts: Date.now() },
        { unfocused: !dshFocused },
      )
    }
  })

  ctx.on('agent/error', (ev) => {
    const sid = String(ev.agent?.id ?? ev.agent ?? '')
    if (sid === '') return
    if (!isTerminalError(ev)) return
    const nm = sessionName(ev.agent)
    // 记录可能还不存在（会话没经过 running 就直接失败）：先建再标记
    store.get(sid, nm)
    store.apply({ sessionId: sid, name: nm, kind: 'error' })
    sound.push(
      { kind: 'error', sessionId: sid, name: nm, ts: Date.now() },
      { unfocused: !dshFocused },
    )
  })

  ctx.on('agent/disposed', (ev) => {
    const sid = String(ev.agent?.id ?? ev.agent ?? '')
    if (sid === '') return
    names.delete(sid)
    store.remove(sid)
    for (const [rid, card] of [...cards]) {
      if (card.sessionId === sid) {
        cards.delete(rid)
        const entry = pending.get(rid)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          pending.delete(rid)
          entry.resolve('cancelled')
        }
      }
    }
  })

  // ── 审批 / 提问：宿主唯一消费者 ─────────────────────────
  ctx.on('agent/created', (ev) => {
    const agent = ev.agent
    if (agent?.ctx === undefined) return

    agent.ctx.on('approval/request', async (req, next) => {
      const sid = String(req.agent?.id ?? agent.id ?? '')
      const nm = sessionName(req.agent ?? agent)
      const requestId = `a:${sid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
      const reason = req.reason ?? req.displayReason?.en ?? ''

      openRequest({
        requestId,
        sessionId: sid,
        kind: 'approval',
        name: nm,
        payload: { toolName: req.toolName ?? '', reason },
      })
      sound.push(
        { kind: 'approval', sessionId: sid, name: nm, ts: Date.now() },
        { unfocused: !dshFocused, blocking: true },
      )

      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (consumed.has(requestId)) return
          consumed.add(requestId)
          pending.delete(requestId)
          closeRequest(requestId)
          // 超时放行：交给宿主默认 answerer（内置 UI）
          next().then(resolve, () => resolve('unavailable'))
        }, cfg.answerTimeoutMs)
        if (timer.unref) timer.unref()
        pending.set(requestId, { sessionId: sid, resolve, timer })
      })
    }, { prepend: true })

    agent.ctx.on('user-questions/request', async (request, next) => {
      const sid = String(request.agent?.id ?? agent.id ?? '')
      const nm = sessionName(request.agent ?? agent)
      const requestId = `q:${sid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`

      const questions = (request.questions ?? []).map((q) => ({
        id: q.id,
        question: q.question ?? q.header ?? '',
        header: q.header ?? '',
        detail: q.detail ?? '',
        multiSelect: q.multiSelect === true,
        // 展示意图只影响呈现（approval / plan-review），答案编码不变
        intent: q.intent?.kind ?? '',
        options: (q.options ?? []).map((o) => ({
          label: o.label ?? '',
          description: o.description ?? '',
        })),
      }))

      openRequest({
        requestId,
        sessionId: sid,
        kind: 'question',
        name: nm,
        payload: { questions },
      })
      sound.push(
        { kind: 'question', sessionId: sid, name: nm, ts: Date.now() },
        { unfocused: !dshFocused, blocking: true },
      )

      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (consumed.has(requestId)) return
          consumed.add(requestId)
          pending.delete(requestId)
          closeRequest(requestId)
          next().then(resolve, () => resolve(undefined))
        }, cfg.answerTimeoutMs)
        if (timer.unref) timer.unref()
        pending.set(requestId, { sessionId: sid, resolve, timer })
      })
    }, { prepend: true })
  })

  // ── 启动补种：插件启用时已经存在的会话 ───────────────────
  // `agent/status` 只在状态变化时触发，因此插件后加载会看不到已有会话。
  // 用 `agents.list()` 枚举，再用 `agents.turnBoundaryOf()` 判断是否有一轮未结束。
  function seedExistingAgents() {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    if (agents === undefined || typeof agents?.list !== 'function') return
    let list = []
    try {
      list = agents.list()
    } catch {
      return
    }
    for (const agent of list) {
      const sid = String(agent?.id ?? '')
      if (sid === '') continue
      const nm = sessionName(agent)
      let running = false
      try {
        const session = sessions?.get?.(agent.id) ?? agent.session
        if (session !== undefined && typeof agents.turnBoundaryOf === 'function') {
          running = agents.turnBoundaryOf(session)?.openTurnStartSeq != null
        }
      } catch {
        /* 读不到就算空闲 */
      }
      if (running) {
        store.apply({ sessionId: sid, name: nm, kind: 'status-running' })
      }
      // 空闲会话不补种：它们会在下一次运行/完成时自然出现。
      // 一上来把几十个常驻会话铺成灰色，既吵又会在 idleKeepMs 后集体消失。
    }
  }

  // ── 生命周期 ───────────────────────────────────────────
  store.startTicker(() => {
    /* tick 只推进 green→grey；面板轮询取快照 */
  })

  try {
    seedExistingAgents()
  } catch (error) {
    logger.warn?.(`notify-traffic seed failed: ${error?.message ?? error}`)
  }

  ctx.on('dispose', () => {
    disposed = true
    store.stopTicker()
    sound.clear()
    pendingSounds.length = 0
    names.clear()
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    cards.clear()
    consumed.clear()
  })

  // 系统级悬浮窗：effect 保证「启动 ↔ 清理」成对执行，
  // 插件被禁用/重载时窗口一定退出，不留孤儿进程。
  ctx.effect(() => {
    try {
      startSystemOverlay()
    } catch (error) {
      logger.warn?.(`notify-traffic: 系统悬浮窗启动异常: ${error?.message ?? error}`)
    }
    return () => stopSystemOverlay()
  }, 'notify-traffic: system overlay')

  logger.info?.('notify-traffic ready · 状态悬浮窗数据面已挂载')
}

/** 会话名截断：列表与语音共用一个短名 */
function truncateName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim()
  if (s === '') return '未命名'
  return s.length > 20 ? s.slice(0, 20) + '…' : s
}

/** 终止型错误判定 */function isTerminalError(ev) {
  const err = ev?.error
  if (err == null) return false
  if (err.kind === 'terminal' || err.kind === 'turn' || err.kind === 'fatal') return true
  if (err.terminal === true || err.fatal === true) return true
  if (ev.turn != null && ev.turn > 0) return true
  return false
}

/** 深合并 sound */
function mergeConfig(user) {
  const cfg = { ...DEFAULTS, ...user }
  cfg.sound = { ...DEFAULTS.sound, ...(user.sound ?? {}) }
  return cfg
}
