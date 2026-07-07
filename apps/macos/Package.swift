// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "GermMacOS",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "germ-macos", targets: ["GermMacOS"])
    ],
    targets: [
        .executableTarget(
            name: "GermMacOS",
            path: "Sources/GermMacOS"
        )
    ]
)
