import AppKit
import SwiftUI

/// Keeps the full-size dashboard window movable after its visual titlebar is
/// removed. The leading padding is supplied by `ContentView` so this never
/// covers the standard traffic-light controls.
struct WindowDragRegion: View {
    @ViewBuilder
    var body: some View {
        if #available(macOS 15.0, *) {
            Color.clear
                .contentShape(Rectangle())
                .gesture(WindowDragGesture())
                .allowsWindowActivationEvents(true)
        } else {
            LegacyWindowDragRegion()
        }
    }
}

private struct LegacyWindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        DraggableNSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private final class DraggableNSView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}
