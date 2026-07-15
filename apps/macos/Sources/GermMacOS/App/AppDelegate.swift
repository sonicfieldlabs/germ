import AppKit
import Darwin

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminationSignalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        installGracefulTerminationHandler(for: SIGTERM)
        installGracefulTerminationHandler(for: SIGINT)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Route shell/build-script termination through AppKit so
    /// `willTerminateNotification` runs and the app can stop only the daemon
    /// process it owns before exiting.
    private func installGracefulTerminationHandler(for signalNumber: Int32) {
        Darwin.signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            NSApp.terminate(nil)
        }
        source.resume()
        terminationSignalSources.append(source)
    }
}
