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

            VStack(spacing: 0) {
                WindowDragRegion()
                    .frame(height: 32)
                    .padding(.leading, 80)
                Spacer(minLength: 0)
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
        Coordinator(dashboardURL: URL(string: urlString))
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
        webView.underPageBackgroundColor = NSColor(
            red: 0.984,
            green: 0.984,
            blue: 0.976,
            alpha: 1
        )
        webView.uiDelegate = context.coordinator
        webView.navigationDelegate = context.coordinator
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

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
        var lastReloadToken = 0
        private let dashboardURL: URL?
        private var downloadDestinations: [ObjectIdentifier: URL] = [:]

        init(dashboardURL: URL?) {
            self.dashboardURL = dashboardURL
        }

        // The Chamber's hardware-record module uses getUserMedia; grant the
        // in-page prompt (the macOS microphone permission still applies).
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            let isDashboard = matchesDashboardOrigin(
                scheme: origin.protocol,
                host: origin.host,
                port: origin.port
            )
            decisionHandler(type == .microphone && isDashboard ? .grant : .deny)
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

        // Preserve the browser dashboard's download behavior. Without a
        // navigation/download delegate, WKWebView may navigate to generated
        // WAV/JSON/GWT data instead of saving it.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.shouldPerformDownload {
                decisionHandler(.download)
                return
            }
            if navigationAction.targetFrame?.isMainFrame == true,
               let url = navigationAction.request.url,
               !matchesDashboardOrigin(url) {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
        }

        func webView(
            _ webView: WKWebView,
            navigationAction: WKNavigationAction,
            didBecome download: WKDownload
        ) {
            download.delegate = self
        }

        func webView(
            _ webView: WKWebView,
            navigationResponse: WKNavigationResponse,
            didBecome download: WKDownload
        ) {
            download.delegate = self
        }

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String,
            completionHandler: @escaping (URL?) -> Void
        ) {
            guard let destination = availableDownloadURL(for: suggestedFilename) else {
                completionHandler(nil)
                return
            }
            downloadDestinations[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        }

        func downloadDidFinish(_ download: WKDownload) {
            downloadDestinations[ObjectIdentifier(download)] = nil
        }

        func download(
            _ download: WKDownload,
            didFailWithError error: Error,
            resumeData: Data?
        ) {
            downloadDestinations[ObjectIdentifier(download)] = nil
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        private func availableDownloadURL(for suggestedFilename: String) -> URL? {
            let fileManager = FileManager.default
            guard let downloads = fileManager.urls(
                for: .downloadsDirectory,
                in: .userDomainMask
            ).first else {
                return nil
            }

            let safeName = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            let initialName = safeName.isEmpty ? "germ-download" : safeName
            var candidate = downloads.appendingPathComponent(initialName, isDirectory: false)
            guard fileManager.fileExists(atPath: candidate.path) else { return candidate }

            let source = URL(fileURLWithPath: initialName)
            let fileExtension = source.pathExtension
            let stem = source.deletingPathExtension().lastPathComponent
            for suffix in 2...10_000 {
                let numberedName = fileExtension.isEmpty
                    ? "\(stem) (\(suffix))"
                    : "\(stem) (\(suffix)).\(fileExtension)"
                candidate = downloads.appendingPathComponent(numberedName, isDirectory: false)
                if !fileManager.fileExists(atPath: candidate.path) {
                    return candidate
                }
            }
            return nil
        }

        private func matchesDashboardOrigin(_ url: URL) -> Bool {
            guard let scheme = url.scheme, let host = url.host else { return false }
            return matchesDashboardOrigin(
                scheme: scheme,
                host: host,
                port: url.port ?? defaultPort(for: scheme)
            )
        }

        private func matchesDashboardOrigin(scheme: String, host: String, port: Int) -> Bool {
            guard let dashboardURL,
                  let dashboardScheme = dashboardURL.scheme,
                  let dashboardHost = dashboardURL.host else {
                return false
            }
            let dashboardPort = dashboardURL.port ?? defaultPort(for: dashboardScheme)
            let originPort = port == 0 ? defaultPort(for: scheme) : port
            return scheme.caseInsensitiveCompare(dashboardScheme) == .orderedSame
                && host.caseInsensitiveCompare(dashboardHost) == .orderedSame
                && originPort == dashboardPort
        }

        private func defaultPort(for scheme: String) -> Int {
            scheme.caseInsensitiveCompare("https") == .orderedSame ? 443 : 80
        }
    }
}
