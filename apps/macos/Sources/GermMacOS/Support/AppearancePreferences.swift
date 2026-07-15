import SwiftUI

struct GermAccentOption: Identifiable, Hashable {
    let name: String
    let hex: String

    var id: String { hex }
}

enum GermAppearancePalette {
    static let defaultAccent = "#476f5d"

    static let accents = [
        GermAccentOption(name: "Leaf", hex: "#476f5d"),
        GermAccentOption(name: "Tide", hex: "#426b8a"),
        GermAccentOption(name: "Iris", hex: "#6d5a8d"),
        GermAccentOption(name: "Rose", hex: "#9a5964"),
        GermAccentOption(name: "Amber", hex: "#a06e35"),
        GermAccentOption(name: "Lagoon", hex: "#397679"),
        GermAccentOption(name: "Graphite", hex: "#6d6d68"),
    ]

    static func normalizedAccent(_ value: String?) -> String {
        guard let value else { return defaultAccent }
        let candidate = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let digits = candidate.dropFirst()
        let isHex = candidate.first == "#"
            && digits.count == 6
            && digits.allSatisfy { $0.isHexDigit }
        return isHex ? candidate : defaultAccent
    }

    static func color(_ hex: String) -> Color {
        let normalized = normalizedAccent(hex)
        let raw = UInt64(normalized.dropFirst(), radix: 16) ?? 0x476f5d
        return Color(
            red: Double((raw >> 16) & 0xff) / 255,
            green: Double((raw >> 8) & 0xff) / 255,
            blue: Double(raw & 0xff) / 255
        )
    }
}

struct DashboardAppearance: Equatable, Codable {
    let theme: String
    let accent: String
}
