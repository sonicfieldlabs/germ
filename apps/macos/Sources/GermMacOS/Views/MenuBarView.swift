import AppKit
import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject private var store: ShellStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(store.statusLabel, systemImage: statusIcon)
            Text(store.engineLabel)
                .foregroundStyle(.secondary)

            Divider()

            Button("Open germ") {
                openWindow(id: "main")
                NSApp.activate(ignoringOtherApps: true)
            }

            Button("Open in Browser") {
                store.openDashboard()
            }
            .disabled(!store.daemonOnline)

            Button("Settings…") {
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                NSApp.activate(ignoringOtherApps: true)
            }

            Divider()

            Button("Start Daemon") {
                Task { await store.startDaemon() }
            }
            .disabled(store.daemonOnline || store.isStartingDaemon)

            Button("Stop Managed Daemon") {
                Task { await store.stopManagedDaemon() }
            }
            .disabled(!store.managedDaemonRunning)

            Divider()

            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
        }
        .padding(.vertical, 4)
        .task {
            await store.refresh()
        }
        .preferredColorScheme(store.preferredColorScheme)
    }

    private var statusIcon: String {
        if !store.daemonOnline { return "exclamationmark.triangle" }
        if store.managedDaemonRunning { return "circle.hexagongrid.fill" }
        return "circle.hexagongrid"
    }
}
