import Foundation

/// Locates the germ repository root so the shell can supervise its daemon.
func findGermRepositoryRoot() -> URL? {
    let fileManager = FileManager.default
    let candidates = [
        ProcessInfo.processInfo.environment["GERM_REPOSITORY_ROOT"].map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true)
        },
        Bundle.main.executableURL,
        Bundle.main.bundleURL,
        URL(fileURLWithPath: fileManager.currentDirectoryPath)
    ].compactMap { $0 }

    for candidate in candidates {
        var current = candidate.hasDirectoryPath ? candidate : candidate.deletingLastPathComponent()
        for _ in 0..<12 {
            let pyproject = current.appendingPathComponent("pyproject.toml").path
            let server = current.appendingPathComponent("server/main.py").path
            if fileManager.fileExists(atPath: pyproject), fileManager.fileExists(atPath: server) {
                return current
            }
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path { break }
            current = parent
        }
    }

    return nil
}
