/**
 * dsh-notify-traffic · Client 侧悬浮窗
 *
 * 承载：`shell.overlay`（帧级浮层，位于所有列之上、滚动容器之外）。
 * 数据：轮询宿主 `/notify-traffic/state`（1s），只做展示与交互，
 *       决策（四色派生、声音合并/去重/静默）全部在宿主完成。
 * 交互：审批 → POST /answer；提问 → POST /reply；异常已读 → POST /ack。
 *
 * 浮层默认 click-through，只有交互元素显式打开 pointer-events。
 *
 * @module dsh-notify-traffic/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify-traffic',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'notify-traffic'
    const API = '/notify-traffic'
    /** apply 时捕获，供组件调用 Client 服务（会话切换） */
    let pluginCtx = null

    /** 四色（PRD §6）。红色两档同色相：靠闪动/图标区分语义。 */
    const PALETTE = {
      'red-block': '#e5484d',
      'red-error': '#e5484d',
      yellow: '#f5a524',
      green: '#30a46c',
      grey: '#8b8d98',
    }

    const LABEL = {
      'red-block': { zh: '待处理', en: 'Needs you' },
      'red-error': { zh: '出错', en: 'Error' },
      yellow: { zh: '运行中', en: 'Running' },
      green: { zh: '已完成', en: 'Done' },
      grey: { zh: '空闲', en: 'Idle' },
    }

    const zh = {
      title: '会话状态',
      empty: '没有正在跟踪的会话',
      more: '还有 {n} 个',
      approve: '允许一次',
      reject: '拒绝',
      approval: '审批',
      question: '提问',
      error: '出错',
      running: '运行中',
      ack: '知道了',
      collapse: '收起',
      expand: '展开',
      compact: '单灯模式',
      open: '打开会话',
      flashMark: '!',
      ago: '{n} 秒前',
      agoMin: '{n} 分钟前',
      // —— 设置页 ——
      settingsTitle: '会话悬浮窗',
      settingsDesc: '四色状态灯、审批与提问卡片、声音提醒。默认只在有事时出现。',
      secOverlay: '悬浮窗位置',
      overlaySystem: '系统窗口',
      overlayInFrame: '页面内',
      overlayBoth: '两者都开',
      overlayOff: '关闭',
      overlaySystemHint: '独立原生窗口：DSH 最小化后仍浮在所有应用之上，可拖到任意位置。',
      overlayInFrameHint: '画在 DSH 界面右上角，随 DSH 一起最小化。',
      overlayUnsupported: '当前系统没有可用的原生窗口二进制（需要 macOS + Swift 工具链）。',
      secForm: '初始形态',
      formCard: '卡片',
      formBar: '胶囊',
      formCompact: '单灯',
      secSound: '声音',
      soundEnabled: '开启声音提醒',
      soundApproval: '审批',
      soundQuestion: '提问',
      soundError: '出错',
      soundCompletion: '完成',
      soundUnfocused: '仅 DSH 失焦时播完成音',
      quietHours: '静默时段',
      quietHoursHint: '例如 22:00-08:00，留空表示不静默。静默时只压完成音，审批与出错照常。',
      volume: '音量',
      mergeWindow: '完成音合并窗口（毫秒）',
      secRhythm: '节奏',
      greenHold: '完成后保持绿色（毫秒）',
      idleKeep: '空闲会话移出列表（毫秒）',
      queueCap: '列表上限',
      answerTimeout: '审批等待上限（毫秒）',
      save: '保存',
      saved: '已保存',
      savedLocal: '已生效，但写入配置文件失败：',
      saving: '保存中…',
      reloadHint: '改动会重启本插件以应用（窗口会重建一次）。',
      reasoning: '出错闪动上限（毫秒）',
    }

    const en = {
      title: 'Sessions',
      empty: 'No tracked sessions',
      more: '+{n} more',
      approve: 'Allow once',
      reject: 'Reject',
      approval: 'Approval',
      question: 'Question',
      error: 'Error',
      running: 'Running',
      ack: 'Got it',
      collapse: 'Collapse',
      expand: 'Expand',
      compact: 'Single light',
      open: 'Open session',
      flashMark: '!',
      ago: '{n}s ago',
      agoMin: '{n}m ago',
      settingsTitle: 'Session overlay',
      settingsDesc: 'Four-color lights, approval and question cards, sound alerts.',
      secOverlay: 'Overlay placement',
      overlaySystem: 'System window',
      overlayInFrame: 'In frame',
      overlayBoth: 'Both',
      overlayOff: 'Off',
      overlaySystemHint: 'A native always-on-top window: stays above every app after DSH is minimized.',
      overlayInFrameHint: 'Drawn in the DSH frame, minimizes with DSH.',
      overlayUnsupported: 'No native overlay binary for this platform (macOS + Swift toolchain required).',
      secForm: 'Initial form',
      formCard: 'Card',
      formBar: 'Pill',
      formCompact: 'Single light',
      secSound: 'Sound',
      soundEnabled: 'Enable sound alerts',
      soundApproval: 'Approval',
      soundQuestion: 'Question',
      soundError: 'Error',
      soundCompletion: 'Completion',
      soundUnfocused: 'Completion sound only when DSH is unfocused',
      quietHours: 'Quiet hours',
      quietHoursHint: 'e.g. 22:00-08:00. Empty means never silent. Blocking alerts still play.',
      volume: 'Volume',
      mergeWindow: 'Completion merge window (ms)',
      secRhythm: 'Rhythm',
      greenHold: 'Keep green after done (ms)',
      idleKeep: 'Drop idle session after (ms)',
      queueCap: 'List cap',
      answerTimeout: 'Approval timeout (ms)',
      save: 'Save',
      saved: 'Saved',
      savedLocal: 'Applied, but writing the config file failed: ',
      saving: 'Saving…',
      reloadHint: 'Saving restarts this plugin to apply (the window is recreated once).',
      reasoning: 'Error flash cap (ms)',
    }

    // ── 样式（随组件挂载/卸载）────────────────────────────
    function Styles() {
      return h('style', {
        'data-plugin-css': 'dsh-notify-traffic/panel',
        dangerouslySetInnerHTML: { __html: CSS },
      })
    }

    const CSS = `
.dnt-root{
  position:absolute; top:calc(var(--dsh-frame-overlay-top, 68px)); right:12px;
  display:flex; flex-direction:column; gap:8px; align-items:flex-end;
  z-index:40;
  font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  color:var(--dsw-alias-text-primary, #1c1c1e);
}
.dnt-root *{box-sizing:border-box}
.dnt-root .dnt-interactive{pointer-events:auto}
.dnt-card{
  width:296px; max-width:calc(100vw - 32px);
  background:var(--dsw-alias-bg-elevated, rgba(255,255,255,.86));
  -webkit-backdrop-filter:saturate(180%) blur(18px);
  backdrop-filter:saturate(180%) blur(18px);
  border:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.08));
  border-radius:12px; overflow:hidden;
  box-shadow:var(--dsw-elevation-panel, 0 8px 28px rgba(0,0,0,.16));
}
.dnt-head{
  display:flex; align-items:center; gap:8px;
  padding:9px 11px; border-bottom:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.06));
}
.dnt-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dnt-title{font-weight:600;font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dnt-btn{
  appearance:none;border:1px solid transparent;background:transparent;cursor:pointer;
  border-radius:6px;padding:3px 7px;font-size:11px;line-height:1.3;
  color:var(--dsw-alias-text-secondary, #5b5b60);
}
.dnt-btn:hover{background:var(--dsw-alias-bg-hover, rgba(0,0,0,.06))}
.dnt-btn-primary{background:var(--dsw-alias-accent, #247bbf);color:#fff}
.dnt-btn-primary:hover{filter:brightness(1.06)}
.dnt-btn-danger{background:rgba(229,72,77,.12);color:#c62b30}
.dnt-btn-danger:hover{background:rgba(229,72,77,.2)}
.dnt-list{max-height:224px;overflow-y:auto;overscroll-behavior:contain}
.dnt-row{
  display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:pointer;
  border:none;background:transparent;width:100%;text-align:left;font:inherit;color:inherit;
}
.dnt-row:hover{background:var(--dsw-alias-bg-hover, rgba(0,0,0,.05))}
.dnt-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dnt-state{font-size:10px;color:var(--dsw-alias-text-tertiary, #8b8d98);flex:none}
.dnt-flash{animation:dnt-flash 1.2s ease-in-out infinite}
@keyframes dnt-flash{0%,100%{opacity:1}50%{opacity:.4}}
.dnt-static-mark{font-size:10px;font-weight:700;color:#c62b30}
.dnt-more{padding:6px 11px;font-size:11px;color:var(--dsw-alias-text-tertiary, #8b8d98)}
.dnt-request{
  padding:10px 11px;border-top:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.06));
  display:flex;flex-direction:column;gap:7px;
}
.dnt-request:first-child{border-top:none}
.dnt-req-head{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600}
.dnt-req-name{color:var(--dsw-alias-text-secondary, #5b5b60);font-weight:500}
.dnt-req-body{
  font-size:11px;color:var(--dsw-alias-text-secondary, #5b5b60);
  word-break:break-word;max-height:66px;overflow-y:auto;
}
.dnt-q-head{font-size:10px;font-weight:600;color:var(--dsw-alias-text-tertiary, #8b8d98)}
.dnt-q-detail{
  font-size:10px;color:var(--dsw-alias-text-tertiary, #8b8d98);
  white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto;
  border-left:2px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.08));padding-left:6px;
}
.dnt-actions{display:flex;gap:6px;justify-content:flex-end}
.dnt-opt{
  text-align:left;border:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.12));
  background:transparent;border-radius:7px;padding:5px 8px;font-size:11px;cursor:pointer;
  color:inherit;font:inherit;
}
.dnt-opt:hover{background:var(--dsw-alias-bg-hover, rgba(0,0,0,.05))}
.dnt-opt-desc{display:block;font-size:10px;color:var(--dsw-alias-text-tertiary, #8b8d98);margin-top:2px}
.dnt-opt[data-selected="true"]{border-color:var(--dsw-alias-accent, #247bbf);background:rgba(36,123,191,.1)}
.dnt-bar{
  display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;
  border-radius:14px;cursor:pointer;border:1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.08));
  background:var(--dsw-alias-bg-elevated, rgba(255,255,255,.86));
  -webkit-backdrop-filter:saturate(180%) blur(18px);backdrop-filter:saturate(180%) blur(18px);
  box-shadow:var(--dsw-elevation-panel, 0 6px 20px rgba(0,0,0,.14));
  font:11px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:inherit;
}
.dnt-bar-count{font-variant-numeric:tabular-nums;font-weight:600}
.dnt-compact{
  width:12px;height:12px;border-radius:50%;cursor:pointer;border:none;
  box-shadow:0 0 0 3px rgba(255,255,255,.7), 0 2px 8px rgba(0,0,0,.25);
}
@media (prefers-reduced-motion: reduce){
  .dnt-flash{animation:none;opacity:1}
}
/* ───────── 设置页 ───────── */
.dnt-s{display:flex;flex-direction:column;gap:18px;padding:2px 0;font-size:13px;color:var(--dsw-alias-text-primary,#1c1c1e)}
.dnt-s-desc{font-size:12px;color:var(--dsw-alias-text-tertiary,#8b8d98);margin-top:-12px}
.dnt-s-sec{display:flex;flex-direction:column;gap:10px}
.dnt-s-h{font-size:12px;font-weight:600;color:var(--dsw-alias-text-secondary,#5b5b60);letter-spacing:.02em}
.dnt-s-row{display:flex;align-items:center;gap:12px;min-height:26px}
.dnt-s-label{flex:1;min-width:0}
.dnt-s-hint{display:block;font-size:11px;color:var(--dsw-alias-text-tertiary,#8b8d98);margin-top:2px}
.dnt-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));border-radius:8px;overflow:hidden}
.dnt-seg button{appearance:none;border:0;background:transparent;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;color:inherit;border-right:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08))}
.dnt-seg button:last-child{border-right:0}
.dnt-seg button[aria-pressed="true"]{background:var(--dsw-alias-accent,#247bbf);color:#fff}
.dnt-in{width:110px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.14));background:transparent;color:inherit;font:inherit;font-size:12px}
.dnt-in-wide{width:150px}
.dnt-sw{appearance:none;width:36px;height:20px;border-radius:10px;background:rgba(140,140,150,.35);position:relative;cursor:pointer;border:0;transition:background .15s}
.dnt-sw[aria-checked="true"]{background:var(--dsw-alias-accent,#247bbf)}
.dnt-sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.dnt-sw[aria-checked="true"]::after{transform:translateX(16px)}
.dnt-s-foot{display:flex;align-items:center;gap:12px;padding-top:4px}
.dnt-s-status{font-size:12px;color:var(--dsw-alias-text-tertiary,#8b8d98)}
.dnt-s-status[data-tone="ok"]{color:#30a46c}
.dnt-s-status[data-tone="warn"]{color:#c62b30}
`

    // ── 工具 ───────────────────────────────────────────────
    function isReducedMotion() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch {
        return false
      }
    }

    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
        keepalive: true,
      }).catch(() => undefined)
    }

    // ── 轮询 ───────────────────────────────────────────────
    function useTraffic() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(false)
      const intervalRef = useRef(1000)
      const aliveRef = useRef(true)

      useEffect(() => {
        aliveRef.current = true
        let timer = null

        const poll = async () => {
          try {
            const res = await fetch(API + '/state', { cache: 'no-store' })
            if (!res.ok) throw new Error(String(res.status))
            const next = await res.json()
            if (!aliveRef.current) return
            setData(next)
            setError(false)
            const ms = Number(next?.settings?.pollIntervalMs)
            if (Number.isFinite(ms) && ms >= 300) intervalRef.current = ms
          } catch {
            if (!aliveRef.current) return
            setError(true)
          } finally {
            if (aliveRef.current) timer = setTimeout(poll, intervalRef.current)
          }
        }

        void poll()
        return () => {
          aliveRef.current = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])

      return { data, error }
    }

    // ── 声音（Web Speech）──────────────────────────────────
    function useSpeech(settings) {
      const seenRef = useRef(new Set())
      const soundRef = useRef(settings)
      soundRef.current = settings

      return useCallback((sounds) => {
        if (!Array.isArray(sounds) || sounds.length === 0) return
        const cfg = soundRef.current ?? {}
        if (cfg.enabled === false) return
        let synth
        try {
          synth = window.speechSynthesis
        } catch {
          return
        }
        if (synth === undefined || synth === null) return

        for (const item of sounds) {
          if (item === null || typeof item !== 'object') continue
          const key = `${item.mergeKey ?? ''}:${item.at ?? 0}:${item.text ?? ''}`
          if (seenRef.current.has(key)) continue
          seenRef.current.add(key)
          if (seenRef.current.size > 200) {
            // 有界：丢掉最早的一半
            const arr = [...seenRef.current]
            seenRef.current = new Set(arr.slice(arr.length - 100))
          }
          const text = typeof item.text === 'string' ? item.text.trim() : ''
          if (text === '') continue
          try {
            const utter = new SpeechSynthesisUtterance(text)
            utter.lang = /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN' : 'en-US'
            const volume = Number(cfg.volume)
            utter.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.6
            utter.rate = 1.02
            synth.speak(utter)
          } catch {
            /* 语音不可用：静默降级 */
          }
        }
      }, [])
    }

    // ── 焦点上报（onlyWhenUnfocused）───────────────────────
    function useFocusReport(active) {
      useEffect(() => {
        if (!active) return
        let last = null
        const report = () => {
          const focused = document.hasFocus()
          if (focused === last) return
          last = focused
          void post('/focus', { focused })
        }
        report()
        const timer = setInterval(report, 4000)
        window.addEventListener('focus', report)
        window.addEventListener('blur', report)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', report)
          window.removeEventListener('blur', report)
        }
      }, [active])
    }

    // ── 小组件 ────────────────────────────────────────────
    function Dot({ color, flashing, still }) {
      const reduced = isReducedMotion()
      const className = flashing && !reduced ? 'dnt-dot dnt-flash' : 'dnt-dot'
      return h('span', {
        className,
        style: { background: PALETTE[color] ?? PALETTE.grey },
        'aria-hidden': true,
      })
    }

    function RequestCard({ card, t }) {
      const [selected, setSelected] = useState({})

      const isApproval = card.kind === 'approval'
      const title = isApproval ? t('approval') : t('question')

      const onApprove = () => {
        void post('/answer', { requestId: card.requestId, outcome: 'allowed-once' })
      }
      const onReject = () => {
        void post('/answer', { requestId: card.requestId, outcome: 'rejected' })
      }
      const onReply = () => {
        const answers = (card.questions ?? []).map((q) => ({
          id: q.id,
          selected: selected[q.id] ?? [],
        }))
        void post('/reply', { requestId: card.requestId, answers })
      }

      const body = isApproval
        ? h('div', { className: 'dnt-req-body' }, card.toolName ?? '', card.reason ? ' · ' + card.reason : '')
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            (card.questions ?? []).map((q) =>
              h(
                'div',
                { key: q.id, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                q.header ? h('div', { className: 'dnt-q-head' }, q.header) : null,
                h('div', { className: 'dnt-req-body' }, q.question),
                q.detail ? h('div', { className: 'dnt-q-detail' }, q.detail) : null,
                (q.options ?? []).map((o) => {
                  const on = (selected[q.id] ?? []).includes(o.label)
                  return h(
                    'button',
                    {
                      key: o.label,
                      type: 'button',
                      className: 'dnt-opt',
                      'data-selected': on ? 'true' : 'false',
                      onClick: () => {
                        setSelected((prev) => {
                          const cur = prev[q.id] ?? []
                          const next = on
                            ? cur.filter((x) => x !== o.label)
                            : q.multiSelect
                              ? [...cur, o.label]
                              : [o.label]
                          return { ...prev, [q.id]: next }
                        })
                      },
                    },
                    o.label,
                    o.description ? h('span', { className: 'dnt-opt-desc' }, o.description) : null,
                  )
                }),
              ),
            ),
          )

      return h(
        'div',
        { className: 'dnt-request' },
        h(
          'div',
          { className: 'dnt-req-head' },
          h('span', { style: { color: PALETTE['red-block'] } }, '●'),
          h('span', null, title),
          h('span', { className: 'dnt-req-name' }, card.name ?? ''),
        ),
        body,
        h(
          'div',
          { className: 'dnt-actions' },
          isApproval
            ? [
                h(
                  'button',
                  { key: 'r', type: 'button', className: 'dnt-btn dnt-btn-danger', onClick: onReject },
                  t('reject'),
                ),
                h(
                  'button',
                  { key: 'a', type: 'button', className: 'dnt-btn dnt-btn-primary', onClick: onApprove },
                  t('approve'),
                ),
              ]
            : h('button', { type: 'button', className: 'dnt-btn dnt-btn-primary', onClick: onReply }, t('ack')),
        ),
      )
    }

    function ErrorCard({ session, t }) {
      return h(
        'div',
        { className: 'dnt-request' },
        h(
          'div',
          { className: 'dnt-req-head' },
          h('span', { style: { color: PALETTE['red-error'] } }, '!'),
          h('span', null, t('error') ?? 'Error'),
          h('span', { className: 'dnt-req-name' }, session.name ?? ''),
        ),
        h(
          'div',
          { className: 'dnt-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dnt-btn',
              onClick: () => void post('/ack', { sessionId: session.sessionId }),
            },
            t('ack'),
          ),
        ),
      )
    }

    // ── 主面板 ────────────────────────────────────────────
    function Panel(props) {
      const { data, error } = useTraffic()
      const speak = useSpeech(data?.settings?.sound)
      useFocusReport(true)

      // 本地形态偏好（用户点击切换后立即生效，宿主设置作为初值）
      const [localForm, setLocalForm] = useState(null)
      const form = localForm ?? data?.settings?.form ?? 'card'
      const reduced = isReducedMotion()

      useEffect(() => {
        if (data?.sounds !== undefined) speak(data.sounds)
      }, [data?.sounds, speak])

      // 系统悬浮窗点了会话：由这里执行真正的切换（URL 路由切不了会话）
      const focusReq = data?.settings?.focusRequest ?? null
      useEffect(() => {
        if (focusReq === null || typeof focusReq.sessionId !== 'string') return
        const ws = pluginCtx?.uiWorkspace
        if (ws === undefined || typeof ws.openSession !== 'function') return
        try {
          ws.openSession(focusReq.sessionId)
          void fetch(API + '/focus-done', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: focusReq.sessionId }),
          }).catch(() => undefined)
        } catch {
          /* 会话已被归档等情况：静默忽略 */
        }
      }, [focusReq?.ts])

      const sessions = data?.sessions ?? []
      const cards = data?.cards ?? []
      const aggregate = data?.aggregate ?? { color: 'grey', count: 0 }

      const t = useCallback(
        (key, vars) => {
          const dict = props?.t ?? zh
          let text = dict[key] ?? zh[key] ?? key
          if (vars !== undefined) {
            for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v))
          }
          return text
        },
        [props?.t],
      )

      const setForm = useCallback((next) => {
        setLocalForm(next)
        void post('/mode', { form: next })
      }, [])

      if (data === null) {
        // 尚未取到首帧：不渲染任何东西，避免闪烁
        return error ? h('div', { className: 'dnt-root' }) : null
      }

      // 系统级悬浮窗接管时，页面内浮层不重复显示。
      // 但系统窗口不可用（非 macOS / 缺少 Swift 工具链）或已退出时，
      // 必须回退到页面内，否则用户什么都看不到。
      const overlayMode = data?.settings?.overlay ?? 'system'
      const systemUsable =
        data?.settings?.overlaySupported !== false && data?.settings?.overlayRunning !== false
      if (overlayMode === 'off') return null
      if (overlayMode === 'system' && systemUsable) return null

      // ── 单灯形态 ──
      if (form === 'compact') {
        return h(
          'div',
          { className: 'dnt-root' },
          h(Styles),
          h('button', {
            type: 'button',
            className: 'dnt-compact dnt-interactive',
            style: { background: PALETTE[aggregate.color] ?? PALETTE.grey },
            title: `${t('title')} · ${aggregate.count}`,
            'aria-label': `${t('title')} ${aggregate.count}`,
            onClick: () => setForm('bar'),
          }),
        )
      }

      // ── 胶囊条形态 ──
      if (form === 'bar') {
        return h(
          'div',
          { className: 'dnt-root' },
          h(Styles),
          h(
            'button',
            {
              type: 'button',
              className: 'dnt-bar dnt-interactive',
              onClick: () => setForm('card'),
              title: t('expand'),
            },
            h(Dot, { color: aggregate.color, flashing: false }),
            h('span', { className: 'dnt-bar-count' }, String(aggregate.count)),
            h(
              'span',
              { style: { color: 'var(--dsw-alias-text-tertiary, #8b8d98)' } },
              (LABEL[aggregate.color] ?? LABEL.grey).zh,
            ),
          ),
        )
      }

      // ── 卡片形态 ──
      const MAX_ROWS = 8
      const visible = sessions.slice(0, MAX_ROWS)
      const hidden = Math.max(0, sessions.length - visible.length)
      const errorSessions = sessions.filter((s) => s.color === 'red-error' && s.errorAcked !== true)
      const shownErrors = errorSessions.slice(0, 2)

      return h(
        'div',
        { className: 'dnt-root' },
        h(Styles),
        cards.length === 0 && sessions.length === 0
          ? null
          : h(
              'div',
              { className: 'dnt-card dnt-interactive' },
              h(
                'div',
                { className: 'dnt-head' },
                h(Dot, { color: aggregate.color, flashing: false }),
                h('span', { className: 'dnt-title' }, `${t('title')} · ${aggregate.count}`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dnt-btn',
                    title: t('compact'),
                    onClick: () => setForm('bar'),
                  },
                  '—',
                ),
              ),
              // 阻塞/提问卡片优先（PRD：红块最前）
              cards.map((card) =>
                h(RequestCard, { key: card.requestId, card, t }),
              ),
              shownErrors.map((s) => h(ErrorCard, { key: 'e:' + s.sessionId, session: s, t })),
              visible.length > 0
                ? h(
                    'div',
                    { className: 'dnt-list' },
                    visible.map((s) =>
                      h(
                        'button',
                        {
                          key: s.sessionId,
                          type: 'button',
                          className: 'dnt-row',
                          title: s.sessionId,
                          onClick: () => {
                            try {
                              window.location.hash = `#/session/${encodeURIComponent(s.sessionId)}`
                            } catch {
                              /* 忽略 */
                            }
                          },
                        },
                        h('span', {
                          className: 'dnt-dot',
                          style: {
                            background: PALETTE[s.color] ?? PALETTE.grey,
                            opacity: s.flashing && !reduced ? 0.55 : 1,
                          },
                        }),
                        h('span', { className: 'dnt-name' }, s.name ?? s.sessionId.slice(-6)),
                        s.color === 'red-error' && s.flashing === true && reduced
                          ? h('span', { className: 'dnt-static-mark' }, t('flashMark'))
                          : null,
                        h(
                          'span',
                          { className: 'dnt-state' },
                          (LABEL[s.color] ?? LABEL.grey).zh,
                        ),
                      ),
                    ),
                    hidden > 0
                      ? h('div', { className: 'dnt-more' }, t('more', { n: hidden }))
                      : null,
                  )
                : null,
            ),
      )
    }

    // ── 设置页 ────────────────────────────────────────────
    function Toggle({ on, onClick, label }) {
      return h('button', {
        type: 'button',
        className: 'dnt-sw',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label,
        onClick,
      })
    }

    function Segment({ value, options, onChange }) {
      return h(
        'div',
        { className: 'dnt-seg', role: 'group' },
        options.map((o) =>
          h(
            'button',
            {
              key: o.value,
              type: 'button',
              'aria-pressed': value === o.value ? 'true' : 'false',
              onClick: () => onChange(o.value),
            },
            o.label,
          ),
        ),
      )
    }

    function SettingsSection(props) {
      const [cfg, setCfg] = useState(null)
      const [draft, setDraft] = useState({})
      const [status, setStatus] = useState({ tone: '', text: '' })
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        fetch(API + '/config', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (alive && d?.config) setCfg(d.config)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      const t = useCallback(
        (key) => {
          const dict = props?.t
          if (typeof dict === 'function') {
            const v = dict(key)
            if (typeof v === 'string' && v !== key) return v
          }
          return zh[key] ?? key
        },
        [props?.t],
      )

      const set = useCallback((key, value) => {
        setDraft((prev) => ({ ...prev, [key]: value }))
        setStatus({ tone: '', text: '' })
      }, [])

      const setSound = useCallback((key, value) => {
        setDraft((prev) => ({ ...prev, sound: { ...(prev.sound ?? {}), [key]: value } }))
        setStatus({ tone: '', text: '' })
      }, [])

      const save = useCallback(async () => {
        if (Object.keys(draft).length === 0) return
        setBusy(true)
        setStatus({ tone: '', text: t('saving') })
        try {
          const res = await fetch(API + '/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: draft }),
          })
          const data = await res.json().catch(() => null)
          if (data?.config) setCfg(data.config)
          setDraft({})
          if (data?.persisted) setStatus({ tone: 'ok', text: t('saved') })
          else setStatus({ tone: 'warn', text: t('savedLocal') + String(data?.error ?? '') })
        } catch (error) {
          setStatus({ tone: 'warn', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }, [draft, t])

      if (cfg === null) {
        return h('div', { className: 'dnt-s' }, h(Styles), h('div', { className: 'dnt-s-desc' }, '…'))
      }

      const soundDraft = draft.sound ?? {}
      const val = (key) => (draft[key] !== undefined ? draft[key] : cfg[key])
      const sval = (key) => (soundDraft[key] !== undefined ? soundDraft[key] : cfg.sound[key])

      const row = (labelKey, control, hintKey) =>
        h(
          'div',
          { className: 'dnt-s-row' },
          h(
            'span',
            { className: 'dnt-s-label' },
            t(labelKey),
            hintKey ? h('span', { className: 'dnt-s-hint' }, t(hintKey)) : null,
          ),
          control,
        )

      const numInput = (key, wide) =>
        h('input', {
          className: wide ? 'dnt-in dnt-in-wide' : 'dnt-in',
          type: 'number',
          value: String(val(key) ?? ''),
          onChange: (e) => set(key, Number(e.target.value)),
        })

      return h(
        'div',
        { className: 'dnt-s' },
        h(Styles),
        h('div', { className: 'dnt-s-desc' }, t('settingsDesc')),

        h(
          'div',
          { className: 'dnt-s-sec' },
          h('div', { className: 'dnt-s-h' }, t('secOverlay')),
          row(
            '',
            h(Segment, {
              value: val('overlay'),
              options: [
                { value: 'system', label: t('overlaySystem') },
                { value: 'inframe', label: t('overlayInFrame') },
                { value: 'both', label: t('overlayBoth') },
                { value: 'off', label: t('overlayOff') },
              ],
              onChange: (v) => set('overlay', v),
            }),
          ),
          h(
            'div',
            { className: 'dnt-s-hint' },
            val('overlay') === 'inframe' ? t('overlayInFrameHint') : t('overlaySystemHint'),
          ),
        ),

        h(
          'div',
          { className: 'dnt-s-sec' },
          h('div', { className: 'dnt-s-h' }, t('secForm')),
          row(
            '',
            h(Segment, {
              value: val('form'),
              options: [
                { value: 'card', label: t('formCard') },
                { value: 'bar', label: t('formBar') },
                { value: 'compact', label: t('formCompact') },
              ],
              onChange: (v) => set('form', v),
            }),
          ),
        ),

        h(
          'div',
          { className: 'dnt-s-sec' },
          h('div', { className: 'dnt-s-h' }, t('secSound')),
          row(
            t('soundEnabled'),
            h(Toggle, { on: sval('enabled') === true, onClick: () => setSound('enabled', sval('enabled') !== true) }),
          ),
          h(
            'div',
            { className: 'dnt-s-row', style: { gap: '18px', flexWrap: 'wrap' } },
            [
              ['soundApproval', 'approval'],
              ['soundQuestion', 'question'],
              ['soundError', 'error'],
              ['soundCompletion', 'completion'],
            ].map(([labelKey, key]) =>
              h(
                'label',
                { key, style: { display: 'flex', alignItems: 'center', gap: '7px' } },
                h(Toggle, { on: sval(key) === true, onClick: () => setSound(key, sval(key) !== true) }),
                h('span', null, t(labelKey)),
              ),
            ),
          ),
          row(
            t('soundUnfocused'),
            h(Toggle, {
              on: sval('onlyWhenUnfocused') === true,
              onClick: () => setSound('onlyWhenUnfocused', sval('onlyWhenUnfocused') !== true),
            }),
          ),
          row(
            t('quietHours'),
            h('input', {
              className: 'dnt-in dnt-in-wide',
              type: 'text',
              placeholder: '22:00-08:00',
              value: String(sval('quietHours') ?? ''),
              onChange: (e) => setSound('quietHours', e.target.value),
            }),
            'quietHoursHint',
          ),
          row(
            t('volume'),
            h('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.05,
              value: String(sval('volume') ?? 0.6),
              style: { width: '150px' },
              onChange: (e) => setSound('volume', Number(e.target.value)),
            }),
          ),
          row(t('mergeWindow'), numInput('mergeWindowMs', true)),
        ),

        h(
          'div',
          { className: 'dnt-s-sec' },
          h('div', { className: 'dnt-s-h' }, t('secRhythm')),
          row(t('greenHold'), numInput('greenHoldMs', true)),
          row(t('idleKeep'), numInput('idleKeepMs', true)),
          row(t('queueCap'), numInput('queueCap')),
          row(t('answerTimeout'), numInput('answerTimeoutMs', true)),
          row(t('reasoning'), numInput('errorFlashMaxMs', true)),
        ),

        h(
          'div',
          { className: 'dnt-s-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'dnt-btn dnt-btn-primary',
              disabled: busy || Object.keys(draft).length === 0,
              onClick: save,
            },
            t('save'),
          ),
          h('span', { className: 'dnt-s-status', 'data-tone': status.tone }, status.text),
          h('span', { className: 'dnt-s-hint' }, t('reloadHint')),
        ),
      )
    }

    // ── 插件入口 ──────────────────────────────────────────
    function apply(ctx) {
      pluginCtx = ctx
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'notify-traffic: dictionaries',
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'notify-traffic.panel',
            order: 40,
            locale: NS,
          },
          Panel,
        ),
      )

      // 设置页里的一个区块（侧栏「设置」→ 会话悬浮窗）
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'notify-traffic',
            order: 45,
            label: () => {
              try {
                return ctx.locale.bind(NS)('settingsTitle')
              } catch {
                return zh.settingsTitle
              }
            },
            locale: NS,
          },
          SettingsSection,
        ),
      )
    }

    return { inject: ['slots', 'locale', 'uiWorkspace'], apply }
  },
})
