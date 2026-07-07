import Foundation

/// Locates the germ repository root so the shell can supervise a daemon even
/// when launched as a packaged .app from /Applications.
func findGermRepositoryRoot() -> URL? {
    let fileManager = FileManager.default
    let candidates = [
        Bundle.main.executableURL,
        Bundle.main.bundleURL,
        URL(fileURLWithPath: fileManager.currentDirectoryPath),
        // Known checkout location for packaged builds.
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("workspace/germ", isDirectory: true)
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
