import AppKit
import SwiftUI

@main
struct GermMacOSApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = ShellStore()

    var body: some Scene {
        WindowGroup("germ", id: "main") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 980, minHeight: 640)
                .task {
                    await store.bootstrap()
                }
        }
        .commands {
            CommandMenu("germ") {
                Button("Open Dashboard in Browser") {
                    store.openDashboard()
                }
                .keyboardShortcut("d", modifiers: [.command, .option])

                Button("Reload Dashboard") {
                    store.requestReload()
                }
                .keyboardShortcut("r", modifiers: [.command])

                Divider()

                Button("Start Daemon") {
                    Task { await store.startDaemon() }
                }
                .disabled(store.daemonOnline || store.isStartingDaemon)

                Button("Stop Managed Daemon") {
                    Task { await store.stopManagedDaemon() }
                }
                .disabled(!store.managedDaemonRunning)
            }
        }

        Settings {
            SettingsView()
                .environmentObject(store)
                .frame(width: 480)
                .padding()
        }

        MenuBarExtra("germ", systemImage: "circle.hexagongrid") {
            MenuBarView()
                .environmentObject(store)
        }
    }
}
