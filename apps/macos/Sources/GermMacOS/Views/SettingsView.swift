import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: ShellStore

    var body: some View {
        Form {
            Section("Daemon") {
                TextField("Base URL", text: $store.daemonBaseURL)
                    .textFieldStyle(.roundedBorder)

                HStack {
                    Text(store.daemonOnline ? "Online" : "Offline")
                        .foregroundStyle(store.daemonOnline ? Color.primary : Color.orange)
                    Text(store.engineLabel)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Button("Refresh") {
                        Task { await store.refresh() }
                    }
                }
            }

            Section("Launch") {
                HStack {
                    Text("Launch at login")
                    Spacer()
                    Text(store.launchAtLoginStatus)
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Button("Enable") {
                        store.setLaunchAtLogin(true)
                    }
                    .disabled(!LaunchAtLoginManager.canEnable)

                    Button("Disable") {
                        store.setLaunchAtLogin(false)
                    }
                    .disabled(!LaunchAtLoginManager.canDisable)

                    if LaunchAtLoginManager.requiresApproval {
                        Button("Open Login Items…") {
                            LaunchAtLoginManager.openSystemSettings()
                        }
                    }
                }

                if LaunchAtLoginManager.isUnavailable {
                    Text("Launch at login becomes available in a signed, installed build.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Daemon Log") {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(store.daemonLog.suffix(40).enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .frame(height: 120)
            }

            Section {
                Label(
                    "The app embeds the same dashboard a browser opens at the daemon URL — one instance, shared modules and sessions.",
                    systemImage: "circle.hexagongrid"
                )
                .font(.caption)
            }
            .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }
}
