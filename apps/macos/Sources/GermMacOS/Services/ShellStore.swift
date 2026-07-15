import AppKit
import Foundation
import SwiftUI

struct HealthModel: Decodable {
    let status: String
    let server: String?
    let activeProvider: String?
    let device: String?
    let modelsLoaded: [String]?

    enum CodingKeys: String, CodingKey {
        case status
        case server
        case activeProvider = "active_provider"
        case device
        case modelsLoaded = "models_loaded"
    }
}

/// The shell's entire state. Deliberately thin: the daemon is the single
/// source of truth (graph, sessions, library, providers) and the embedded
/// dashboard renders all of it — the store only supervises the process,
/// watches /health, and opens surfaces.
@MainActor
final class ShellStore: ObservableObject {
    @Published var appearanceMode: String {
        didSet {
            UserDefaults.standard.set(appearanceMode == "dark" ? "dark" : "light", forKey: "germAppearanceMode")
        }
    }
    @Published var accentHex: String {
        didSet {
            UserDefaults.standard.set(
                GermAppearancePalette.normalizedAccent(accentHex),
                forKey: "germAccentHex"
            )
        }
    }
    @Published var daemonBaseURL: String {
        didSet {
            let trimmed = daemonBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            UserDefaults.standard.set(trimmed, forKey: "germDaemonBaseURL")
        }
    }
    @Published var daemonOnline = false
    @Published var health: HealthModel?
    @Published var isStartingDaemon = false
    @Published var managedDaemonRunning = false
    @Published var launchAtLoginStatus = LaunchAtLoginManager.statusLabel
    @Published var errorMessage: String?
    @Published var daemonLog: [String] = []
    /// Incremented to ask the WebView to reload (menu command / daemon
    /// recovery).
    @Published var reloadToken = 0

    private let supervisor = DaemonSupervisor()
    private var pollingTask: Task<Void, Never>?
    private var hasBootstrapped = false

    init() {
        appearanceMode = UserDefaults.standard.string(forKey: "germAppearanceMode") == "dark"
            ? "dark"
            : "light"
        accentHex = GermAppearancePalette.normalizedAccent(
            UserDefaults.standard.string(forKey: "germAccentHex")
        )
        let stored = UserDefaults.standard.string(forKey: "germDaemonBaseURL")
        daemonBaseURL = (stored?.isEmpty == false ? stored! : "http://127.0.0.1:5178")
        // Quit stops only the daemon this shell started; externally started
        // daemons are observed, never owned. The managed process helper also
        // watches this app's PID so an unexpected exit cannot orphan uvicorn.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.supervisor.stop()
            }
        }
        supervisor.onLogLine = { [weak self] line in
            Task { @MainActor [weak self] in
                self?.appendDaemonLog(line)
            }
        }
        supervisor.onExit = { [weak self] status in
            Task { @MainActor [weak self] in
                self?.appendDaemonLog("Managed daemon exited with status \(status)")
                self?.managedDaemonRunning = false
                await self?.refresh()
            }
        }
    }

    var dashboardURL: String {
        let base = daemonBaseURL.hasSuffix("/") ? String(daemonBaseURL.dropLast()) : daemonBaseURL
        return "\(base)/dashboard"
    }

    var preferredColorScheme: ColorScheme {
        appearanceMode == "dark" ? .dark : .light
    }

    var dashboardAppearance: DashboardAppearance {
        DashboardAppearance(
            theme: appearanceMode == "dark" ? "dark" : "light",
            accent: GermAppearancePalette.normalizedAccent(accentHex)
        )
    }

    var statusLabel: String {
        if !daemonOnline { return "Daemon offline" }
        return health?.server ?? "germ online"
    }

    var engineLabel: String {
        guard let health else { return "—" }
        let provider = health.activeProvider ?? "?"
        let device = health.device ?? "?"
        let models = health.modelsLoaded?.isEmpty == false ? health.modelsLoaded!.joined(separator: ", ") : "no model loaded"
        return "\(provider) · \(device) · \(models)"
    }

    /// One-time startup: begin health polling and start a daemon when none is
    /// reachable, so opening the app IS opening germ — the same instance any
    /// browser tab talks to.
    func bootstrap() async {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        startPolling()
        await refresh()
        if !daemonOnline {
            await startDaemon()
        }
    }

    func startPolling() {
        guard pollingTask == nil else { return }
        pollingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    func refresh() async {
        guard let url = URL(string: "\(daemonBaseURL)/health") else {
            daemonOnline = false
            return
        }
        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 3
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let wasOffline = !daemonOnline
            health = try JSONDecoder().decode(HealthModel.self, from: data)
            daemonOnline = true
            errorMessage = nil
            if wasOffline { reloadToken += 1 }
        } catch {
            daemonOnline = false
            health = nil
        }
        managedDaemonRunning = supervisor.isManagedRunning
        launchAtLoginStatus = LaunchAtLoginManager.statusLabel
    }

    func startDaemon() async {
        guard !daemonOnline else {
            appendDaemonLog("Daemon is already reachable at \(daemonBaseURL)")
            return
        }
        guard !isStartingDaemon else { return }
        isStartingDaemon = true
        defer { isStartingDaemon = false }
        do {
            let port = URL(string: daemonBaseURL)?.port ?? 5178
            try supervisor.start(port: port)
            managedDaemonRunning = true
            // uvicorn needs a moment before /health responds.
            for _ in 0..<10 {
                try? await Task.sleep(nanoseconds: 700_000_000)
                await refresh()
                if daemonOnline { break }
            }
        } catch {
            errorMessage = error.localizedDescription
            appendDaemonLog(error.localizedDescription)
        }
    }

    func stopManagedDaemon() async {
        supervisor.stop()
        managedDaemonRunning = false
        try? await Task.sleep(nanoseconds: 500_000_000)
        await refresh()
    }

    func openDashboard() {
        guard let url = URL(string: dashboardURL) else { return }
        NSWorkspace.shared.open(url)
    }

    func requestReload() {
        reloadToken += 1
    }

    func updateAppearance(theme: String?, accent: String?) {
        if let theme {
            appearanceMode = theme == "dark" ? "dark" : "light"
        }
        if let accent {
            accentHex = GermAppearancePalette.normalizedAccent(accent)
        }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            try LaunchAtLoginManager.setEnabled(enabled)
            launchAtLoginStatus = LaunchAtLoginManager.statusLabel
            errorMessage = nil
        } catch {
            launchAtLoginStatus = LaunchAtLoginManager.statusLabel
            errorMessage = error.localizedDescription
        }
    }

    func appendDaemonLog(_ line: String) {
        daemonLog.append(line)
        if daemonLog.count > 200 {
            daemonLog.removeFirst(daemonLog.count - 200)
        }
    }

    /// The shell stops only daemons it started itself; an externally started
    /// daemon keeps running when the app quits.
    nonisolated func shutdown() {
        Task { @MainActor [weak self] in
            self?.supervisor.stop()
        }
    }

    deinit {
        pollingTask?.cancel()
    }
}
