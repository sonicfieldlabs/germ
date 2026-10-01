"""Receiver-clock admission; producer status and source timestamps remain evidence."""
from datetime import datetime, timezone
import math


def absolute_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.utcoffset() is not None else None
    except (ValueError, OverflowError):
        return None


def evaluate_signal(signal, *, mode="live", now=None):
    evaluated_at = now or datetime.now(timezone.utc).isoformat()
    result = {"evaluatedAt": evaluated_at, "mappingAllowed": False, "status": "unknown"}
    def finish(status, reason, allowed=False):
        return dict(result, status=status, reason=reason, mappingAllowed=allowed)
    if mode == "archive":
        return finish("unknown", "archive")
    if mode not in {"live", "fixture"}:
        return finish("unknown", "unknown-mode")
    if not isinstance(signal, dict):
        return finish("unknown", "missing-signal")
    if signal.get("confidence") == "error":
        return finish("unknown", "source-error")
    if signal.get("confidence") == "stale":
        return finish("stale", "source-stale")
    if mode == "fixture":
        return finish("unknown", "fixture", True)
    clock, observed = absolute_time(evaluated_at), absolute_time(signal.get("timestamp"))
    limit = signal.get("staleAfterSeconds")
    if clock is None or observed is None or type(limit) not in (int, float) or not math.isfinite(limit) or limit < 0:
        return finish("unknown", "invalid-clock-or-age-limit")
    if observed > clock:
        return finish("unknown", "future-source-time")
    expiry = observed + limit
    if not math.isfinite(expiry) or abs(expiry) > 8.64e12:
        return finish("unknown", "invalid-clock-or-age-limit")
    result["ageSeconds"] = clock - observed
    expired = clock >= expiry
    return finish("expired" if expired else "current", "age-limit-exceeded" if expired else "within-age-limit", not expired)


def frame_signal_freshness(frame, signal_id, *, now=None, receipt=None):
    signals = frame.get("signals", [])
    matches = [s for s in signals if isinstance(s, dict) and s.get("id") == signal_id] if isinstance(signals, list) else []
    signal = matches[0] if len(matches) == 1 else None
    mode = frame.get("acquisitionMode", "live")
    result = evaluate_signal(signal, mode=mode, now=now)
    if receipt and (receipt.get("reason") == "stale-input" or receipt.get("confidence") == "stale"):
        return dict(result, status="stale", reason="source-stale", mappingAllowed=False)
    return result
