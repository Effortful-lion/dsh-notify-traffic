// dsh-notify-traffic · 系统级置顶悬浮窗（macOS / AppKit + WKWebView）
//
// 为什么是独立进程：DSH 的宿主插件跑在 ELECTRON_RUN_AS_NODE 的 Node 子进程里，
// 拿不到 Electron 主进程的 BrowserWindow。要做出「DSH 最小化后仍浮在所有应用之上」
// 的窗口，只能由插件 spawn 一个自己的原生窗口进程。
//
// 窗口：无边框、透明、可拖动、NSWindow.level = .floating、
//      collectionBehavior 含 canJoinAllSpaces + fullScreenAuxiliary，
//      因此切换桌面空间、DSH 最小化都不影响它。
import Cocoa
import WebKit

enum Cfg {
    static var url: URL = URL(string: "about:blank")!
    static var width: Double = 320
    static var height: Double = 300
}

let args = CommandLine.arguments
func argValue(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

if let urlString = argValue("--url"), let parsed = URL(string: urlString) {
    Cfg.url = parsed
} else {
    FileHandle.standardError.write(Data("ntf-overlay: --url required\n".utf8))
    exit(2)
}
Cfg.width = Double(argValue("--width") ?? "320") ?? 320
Cfg.height = Double(argValue("--height") ?? "300") ?? 300

final class PanelWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// 应用未激活时，第一次点击会被系统用于激活而不是送达网页；
    /// 先激活再继续分发，保证「一次点击就生效」。
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown && !NSApp.isActive {
            NSApp.activate(ignoringOtherApps: false)
        }
        super.sendEvent(event)
    }
}

/// 未聚焦的悬浮窗，第一次点击必须直接送达网页（否则只激活窗口、按钮没反应）。
final class PanelWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: PanelWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        let frame = NSRect(x: 0, y: 0, width: Cfg.width, height: Cfg.height)

        window = PanelWindow(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isOpaque = false
        window.backgroundColor = .clear
        // 关掉系统窗口阴影：窗口矩形比面板多出 6px 内边距，
        // 系统阴影会贴着窗口边缘画成一个硬方框。柔和投影交给面板自己的 CSS。
        window.hasShadow = false

        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false
        webView = PanelWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]

        window.contentView = webView
        restorePosition(frame: frame)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()

        // 两条消息通道必须先就位再 load：高度上报、窗口动作（关闭）
        webView.configuration.userContentController.add(self, name: "ntfSize")
        webView.configuration.userContentController.add(self, name: "ntfAction")

        webView.load(URLRequest(url: Cfg.url))

    }

    func restorePosition(frame: NSRect) {
        let d = UserDefaults.standard
        var origin: NSPoint
        if let x = d.object(forKey: "ntf.x") as? Double, let y = d.object(forKey: "ntf.y") as? Double {
            origin = NSPoint(x: x, y: y)
        } else if let screen = NSScreen.main {
            let v = screen.visibleFrame
            origin = NSPoint(x: v.maxX - frame.width - 20, y: v.maxY - frame.height - 16)
        } else {
            origin = frame.origin
        }
        // 记住的位置可能越界（换过显示器、窗口被拖到边缘）——夹回可见区
        if let screen = NSScreen.main ?? NSScreen.screens.first {
            let v = screen.visibleFrame
            origin.x = min(max(origin.x, v.minX), max(v.minX, v.maxX - frame.width))
            origin.y = min(max(origin.y, v.minY), max(v.minY, v.maxY - frame.height))
        }
        window.setFrameOrigin(origin)
        NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: window, queue: .main
        ) { _ in
            let o = self.window.frame.origin
            UserDefaults.standard.set(Double(o.x), forKey: "ntf.x")
            UserDefaults.standard.set(Double(o.y), forKey: "ntf.y")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.documentElement.innerHTML.length") { _, _ in }
    }

    // ── 拖动：靠轮询鼠标位置移动窗口 ──────────────────────
    // WKWebView 不实现 -webkit-app-region，覆盖视图又被 WebKit 的子视图层级挡住，
    // 合成拖动事件也进不了窗口事件循环。轮询 mouseLocation 最可靠。
    private var dragTimer: Timer?
    private var dragStartMouse = NSPoint.zero
    private var dragStartOrigin = NSPoint.zero

    func beginDrag() {
        guard let win = window else { return }
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = win.frame.origin
        dragTimer?.invalidate()
        dragTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            guard let self, let win = self.window else { return }
            let now = NSEvent.mouseLocation
            win.setFrameOrigin(NSPoint(
                x: self.dragStartOrigin.x + (now.x - self.dragStartMouse.x),
                y: self.dragStartOrigin.y + (now.y - self.dragStartMouse.y)
            ))
            // 左键松开即结束
            if CGEventSource.buttonState(.combinedSessionState, button: .left) == false {
                self.endDrag()
            }
        }
    }

    func endDrag() {
        dragTimer?.invalidate()
        dragTimer = nil
        guard let win = window else { return }
        UserDefaults.standard.set(Double(win.frame.origin.x), forKey: "ntf.x")
        UserDefaults.standard.set(Double(win.frame.origin.y), forKey: "ntf.y")
        UserDefaults.standard.synchronize()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

extension AppDelegate: WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "ntfAction" {
            switch message.body as? String {
            case "close": NSApp.terminate(nil)
            case "dragStart": beginDrag()
            case "dragEnd": endDrag()
            default: break
            }
            return
        }
        guard message.name == "ntfSize", let raw = message.body as? String else { return }
        // 格式 "宽x高"：让窗口贴合内容，单灯形态才不会拖着一个 320pt 的透明条
        let parts = raw.split(separator: "x")
        guard parts.count == 2,
              let w = Double(parts[0]), let h = Double(parts[1]) else { return }
        let newW = min(max(w, 24), 480)
        let newH = min(max(h, 24), 900)
        var f = window.frame
        let top = f.maxY
        let right = f.maxX
        f.size = NSSize(width: newW, height: newH)
        f.origin.y = top - newH
        f.origin.x = right - newW      // 右上角固定，向左向下伸缩
        window.setFrame(f, display: true, animate: false)
    }
}

// 单实例：无论被 spawn 几次，系统里只允许一个悬浮窗。
// flock 随进程退出自动释放，崩溃也不会留下死锁。
let lockPath = NSTemporaryDirectory() + "dsh-notify-traffic-overlay.lock"
let lockFd = open(lockPath, O_CREAT | O_RDWR, 0o600)
if lockFd >= 0 {
    if flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
        // 已有实例在跑：直接退出，让它继续服务
        exit(0)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
