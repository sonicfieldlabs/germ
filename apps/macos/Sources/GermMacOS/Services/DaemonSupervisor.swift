import Foundation

enum DaemonSupervisorError: LocalizedError {
    case repositoryRootNotFound
    case alreadyRunning
    case launchFailed(String)

    var errorDescription: String? {
        switch self {
        case .repositoryRootNotFound:
            return "Could not locate the germ repository root."
        case .alreadyRunning:
            return "A managed daemon process is already running."
        case .launchFailed(let detail):
            return "Could not start daemon: \(detail)"
        }
    }
}

/// Owns at most one germ daemon process. A daemon already running outside the
/// shell is only observed over HTTP and never owned; the shell stops only the
/// process it started itself. Managed stdout/stderr are pipes into the app, so
/// an orphan would die on its next log write even if the shell crashed.
final class DaemonSupervisor {
    private var process: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?

    var onLogLine: ((String) -> Void)?
    var onExit: ((Int32) -> Void)?

    var isManagedRunning: Bool {
        process?.isRunning == true
    }

    func start(host: String = "127.0.0.1", port: Int = 5178) throws {
        guard process?.isRunning != true else {
            throw DaemonSupervisorError.alreadyRunning
        }
        guard let root = findGermRepositoryRoot() else {
            throw DaemonSupervisorError.repositoryRootNotFound
        }

        let helper = root
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("macos", isDirectory: true)
            .appendingPathComponent("script", isDirectory: true)
            .appendingPathComponent("managed_daemon.py", isDirectory: false)
        guard FileManager.default.isReadableFile(atPath: helper.path) else {
            throw DaemonSupervisorError.launchFailed("Missing \(helper.path)")
        }

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let proc = Process()
        let helperArguments = [
            "-u",
            helper.path,
            "--parent-pid",
            "\(ProcessInfo.processInfo.processIdentifier)",
            "server.main:app",
            "--host",
            host,
            "--port",
            "\(port)"
        ]
        let venvPython = root
            .appendingPathComponent(".venv", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
            .appendingPathComponent("python3", isDirectory: false)
        if FileManager.default.isExecutableFile(atPath: venvPython.path) {
            proc.executableURL = venvPython
            proc.arguments = helperArguments
        } else {
            // Bootstrap through uv only when no synced environment exists. The
            // helper still watches the app PID and tears down its whole
            // uvicorn process group if the app disappears.
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["uv", "run", "--frozen", "python"] + helperArguments
        }
        proc.currentDirectoryURL = root
        proc.standardOutput = outputPipe
        proc.standardError = errorPipe
        proc.environment = mergedEnvironment(host: host, port: port)

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.emitLines(from: handle.availableData)
        }
        errorPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.emitLines(from: handle.availableData)
        }
        proc.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                self?.onExit?(process.terminationStatus)
                self?.cleanup()
            }
        }

        do {
            try proc.run()
        } catch {
            cleanup()
            throw DaemonSupervisorError.launchFailed(error.localizedDescription)
        }

        process = proc
        self.outputPipe = outputPipe
        self.errorPipe = errorPipe
        onLogLine?("Started germ daemon from \(root.path)")
    }

    func stop() {
        guard let process else { return }
        process.terminate()
        cleanup()
        onLogLine?("Stopped managed daemon")
    }

    private func cleanup() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        errorPipe = nil
        process = nil
    }

    private func emitLines(from data: Data) {
        guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            for line in lines {
                self?.onLogLine?(line)
            }
        }
    }

    /// GUI-launched apps have a minimal PATH; append the common developer
    /// locations so `uv` resolves, and export Homebrew dylib paths for the
    /// audio toolchain (soundfile, rubberband).
    private func mergedEnvironment(host: String, port: Int) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let existingPath = environment["PATH"] ?? ""
        let homeLocalBin = "\(NSHomeDirectory())/.local/bin"
        let devPath = "\(homeLocalBin):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = existingPath.isEmpty ? devPath : "\(devPath):\(existingPath)"
        let homebrewLibPaths = ["/opt/homebrew/lib", "/usr/local/lib"]
            .filter { FileManager.default.fileExists(atPath: $0) }
        if !homebrewLibPaths.isEmpty {
            let existingDylibPath = environment["DYLD_LIBRARY_PATH"] ?? ""
            environment["DYLD_LIBRARY_PATH"] = existingDylibPath.isEmpty
                ? homebrewLibPaths.joined(separator: ":")
                : "\(homebrewLibPaths.joined(separator: ":")):\(existingDylibPath)"
        }
        if environment["GERM_HOST"] == nil, environment["GERMINATOR_HOST"] == nil {
            environment["GERM_HOST"] = host
        }
        if environment["GERM_PORT"] == nil, environment["GERMINATOR_PORT"] == nil {
            environment["GERM_PORT"] = "\(port)"
        }
        return environment
    }
}
