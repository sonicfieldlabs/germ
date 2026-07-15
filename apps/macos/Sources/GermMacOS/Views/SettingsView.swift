import AppKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: ShellStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("germ settings")
                        .font(.system(size: 18, weight: .semibold))
                    Text("Appearance and local cultivation preferences persist across launches.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                }
                .padding(.bottom, 20)

                settingsSection("Appearance") {
                    HStack(spacing: 4) {
                        appearanceButton("Light", value: "light")
                        appearanceButton("Dark", value: "dark")
                    }
                    .padding(3)
                    .background(controlWell, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Text("Accent")
                            Spacer()
                            Text(accentName)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }

                        HStack(spacing: 10) {
                            ForEach(GermAppearancePalette.accents) { accent in
                                Button {
                                    store.accentHex = accent.hex
                                } label: {
                                    Circle()
                                        .fill(GermAppearancePalette.color(accent.hex))
                                        .frame(width: 24, height: 24)
                                        .overlay {
                                            if store.accentHex == accent.hex {
                                                Circle()
                                                    .stroke(Color.primary.opacity(0.68), lineWidth: 1)
                                                    .padding(-4)
                                            }
                                        }
                                }
                                .buttonStyle(.plain)
                                .help(accent.name)
                                .accessibilityLabel("\(accent.name) accent")
                            }

                            Spacer(minLength: 8)

                            ColorPicker(
                                "Custom",
                                selection: accentColorBinding,
                                supportsOpacity: false
                            )
                            .font(.system(size: 11.5))
                            .fixedSize()
                        }
                    }
                }

                settingsDivider

                settingsSection("Daemon") {
                    LabeledContent("Base URL") {
                        TextField("http://127.0.0.1:5178", text: $store.daemonBaseURL)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 9)
                            .frame(width: 250, height: 30)
                            .background(controlSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }

                    HStack(spacing: 8) {
                        Circle()
                            .fill(store.daemonOnline ? GermAppearancePalette.color(store.accentHex) : Color.orange)
                            .frame(width: 7, height: 7)
                        Text(store.daemonOnline ? "Online" : "Offline")
                        Text(store.engineLabel)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                        Button("Refresh") {
                            Task { await store.refresh() }
                        }
                        .buttonStyle(.borderless)
                    }
                }

                settingsDivider

                settingsSection("Launch") {
                    HStack {
                        Text("Launch at login")
                        Spacer()
                        Text(store.launchAtLoginStatus)
                            .foregroundStyle(.secondary)
                    }

                    HStack(spacing: 6) {
                        Button("Enable") { store.setLaunchAtLogin(true) }
                            .disabled(!LaunchAtLoginManager.canEnable)
                        Button("Disable") { store.setLaunchAtLogin(false) }
                            .disabled(!LaunchAtLoginManager.canDisable)

                        if LaunchAtLoginManager.requiresApproval {
                            Button("Open Login Items…") {
                                LaunchAtLoginManager.openSystemSettings()
                            }
                        }
                    }
                    .buttonStyle(.borderless)

                    if LaunchAtLoginManager.isUnavailable {
                        Text("Launch at login becomes available in a signed, installed build.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                settingsDivider

                settingsSection("Daemon log") {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(store.daemonLog.suffix(40).enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                            }
                        }
                        .padding(10)
                    }
                    .frame(height: 126)
                    .background(controlWell, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                settingsDivider

                Label(
                    "The native app and browser use the same dashboard, modules, sessions, and saved appearance.",
                    systemImage: "circle.hexagongrid"
                )
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .padding(.top, 14)
            }
            .padding(22)
        }
        .background(backgroundColor)
        .preferredColorScheme(store.preferredColorScheme)
    }

    private var settingsDivider: some View {
        Divider().padding(.vertical, 17)
    }

    @ViewBuilder
    private func settingsSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(title)
                .font(.system(size: 12.5, weight: .semibold))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func appearanceButton(_ label: String, value: String) -> some View {
        Button {
            store.appearanceMode = value
        } label: {
            Text(label)
                .font(.system(size: 12.5, weight: .medium))
                .frame(maxWidth: .infinity)
                .frame(height: 27)
                .background(
                    store.appearanceMode == value ? controlSurface : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
        }
        .buttonStyle(.plain)
    }

    private var accentName: String {
        GermAppearancePalette.accents.first(where: { $0.hex == store.accentHex })?.name ?? "Custom"
    }

    private var accentColorBinding: Binding<Color> {
        Binding(
            get: { GermAppearancePalette.color(store.accentHex) },
            set: { color in
                guard let components = NSColor(color).usingColorSpace(.sRGB) else { return }
                store.accentHex = String(
                    format: "#%02x%02x%02x",
                    Int(round(components.redComponent * 255)),
                    Int(round(components.greenComponent * 255)),
                    Int(round(components.blueComponent * 255))
                )
            }
        )
    }

    private var backgroundColor: Color {
        store.appearanceMode == "dark"
            ? Color(red: 0.106, green: 0.106, blue: 0.098)
            : Color(red: 0.965, green: 0.965, blue: 0.957)
    }

    private var controlSurface: Color {
        store.appearanceMode == "dark"
            ? Color(red: 0.141, green: 0.141, blue: 0.129)
            : .white
    }

    private var controlWell: Color {
        store.appearanceMode == "dark"
            ? Color(red: 0.161, green: 0.161, blue: 0.149)
            : Color(red: 0.933, green: 0.933, blue: 0.918)
    }
}
