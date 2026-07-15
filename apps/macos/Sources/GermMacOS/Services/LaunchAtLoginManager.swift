import Foundation
import ServiceManagement

enum LaunchAtLoginManager {
    private static var status: SMAppService.Status {
        SMAppService.mainApp.status
    }

    static var statusLabel: String {
        switch status {
        case .enabled:
            return "Enabled"
        case .notRegistered:
            return "Disabled"
        case .requiresApproval:
            return "Requires approval"
        case .notFound:
            return "Requires signed install"
        @unknown default:
            return "Unknown"
        }
    }

    static var isEnabled: Bool {
        status == .enabled
    }

    static var canEnable: Bool {
        status == .notRegistered
    }

    static var canDisable: Bool {
        status == .enabled || status == .requiresApproval
    }

    static var requiresApproval: Bool {
        status == .requiresApproval
    }

    static var isUnavailable: Bool {
        status == .notFound
    }

    static func setEnabled(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }

    static func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
