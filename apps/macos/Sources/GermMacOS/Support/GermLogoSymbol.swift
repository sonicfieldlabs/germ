import AppKit

/// Template-safe "centered culture" mark used in compact macOS chrome.
/// Oída's outer listening arc is mirrored so this culture opens lower-right;
/// three centered cells turn that motion into cultivation and division.
enum GermLogoSymbol {
    static func image(size: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let scale = min(rect.width, rect.height) / 18
            let origin = NSPoint(x: rect.midX - 9 * scale, y: rect.midY - 9 * scale)

            NSGraphicsContext.current?.shouldAntialias = true

            strokeArc(
                center: point(9.60, 8.51, origin, scale),
                radius: 6.57 * scale,
                width: 0.85 * scale,
                opacity: 0.62,
                startAngle: -125,
                endAngle: 35
            )

            fillCell(
                center: point(9.60, 10.14, origin, scale),
                radius: 1.41 * scale,
                opacity: 1
            )
            fillCell(
                center: point(7.49, 7.58, origin, scale),
                radius: 0.90 * scale,
                opacity: 0.78
            )
            fillCell(
                center: point(11.78, 7.79, origin, scale),
                radius: 0.77 * scale,
                opacity: 0.64
            )
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "germ"
        return image
    }

    private static func point(
        _ x: CGFloat,
        _ y: CGFloat,
        _ origin: NSPoint,
        _ scale: CGFloat
    ) -> NSPoint {
        NSPoint(x: origin.x + x * scale, y: origin.y + y * scale)
    }

    private static func strokeArc(
        center: NSPoint,
        radius: CGFloat,
        width: CGFloat,
        opacity: CGFloat,
        startAngle: CGFloat,
        endAngle: CGFloat
    ) {
        NSColor(calibratedWhite: 0, alpha: opacity).setStroke()
        let path = NSBezierPath()
        path.lineCapStyle = .round
        path.lineWidth = width
        path.appendArc(
            withCenter: center,
            radius: radius,
            startAngle: startAngle,
            endAngle: endAngle,
            clockwise: true
        )
        path.stroke()
    }

    private static func fillCell(center: NSPoint, radius: CGFloat, opacity: CGFloat) {
        NSColor(calibratedWhite: 0, alpha: opacity).setFill()
        NSBezierPath(
            ovalIn: NSRect(
                x: center.x - radius,
                y: center.y - radius,
                width: radius * 2,
                height: radius * 2
            )
        ).fill()
    }
}
