import SwiftUI
import WebKit

/// Holds a weak reference to the embedded dashboard WebView.
final class WebViewHolder: ObservableObject {
    weak var webView: WKWebView?
}

/// The window IS the daemon's dashboard — the exact page a browser shows,
/// embedded, so the mac app and the web dashboard can never diverge: same
/// Chamber, same modules, same server-side sessions, one instance. The only
/// native overlay is a Start button when the daemon is offline.
struct ContentView: View {
    @EnvironmentObject private var store: ShellStore
    @StateObject private var web = WebViewHolder()

    var body: some View {
        ZStack {
            DashboardWebView(
                urlString: store.dashboardURL,
                reloadToken: store.reloadToken,
                holder: web
            )
            .id(store.dashboardURL)

            if !store.daemonOnline {
                offlineOverlay
            }
        }
        .background(Color(red: 0.984, green: 0.984, blue: 0.976))
    }

    private var offlineOverlay: some View {
        VStack(spacing: 12) {
            Text("germ daemon offline")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
            Button(store.isStartingDaemon ? "Starting…" : "Start daemon") {
                Task {
                    await store.startDaemon()
                }
            }
            .disabled(store.isStartingDaemon)
            if let message = store.errorMessage, !message.isEmpty {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 360)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(28)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct DashboardWebView: NSViewRepresentable {
    let urlString: String
    let reloadToken: Int
    let holder: WebViewHolder

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // Mark the page as running inside the native shell (available for
        // dashboard-side affordances later).
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: "window.__germNative = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        holder.webView = webView
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
        }
        context.coordinator.lastReloadToken = reloadToken
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        holder.webView = webView
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            if let url = URL(string: urlString) {
                webView.load(URLRequest(url: url))
            }
        }
    }

    final class Coordinator: NSObject, WKUIDelegate {
        var lastReloadToken = 0

        // The Chamber's hardware-record module uses getUserMedia; grant the
        // in-page prompt (the macOS microphone permission still applies).
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(type == .microphone ? .grant : .deny)
        }

        // target=_blank links (API docs, /files reveals) open in the default
        // browser so the embedded dashboard never navigates away.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}
