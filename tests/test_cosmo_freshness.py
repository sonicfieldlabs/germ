from copy import deepcopy
import json
from pathlib import Path
import pytest
from server.cosmo_generation import apply_frame
from server.cosmoaudition import execute_cosmoaudition_mapping
from server.schemas import GenerateRequest, CosmoauditionMapRequest

DATA = json.loads((Path(__file__).parent / "fixtures/cosmo-freshness.json").read_text())
SELECTION = dict(mapping_ids=["germ-carbon-duration"], intermodulation="replace", accept_held=True, accept_uncertainty=True)

@pytest.mark.parametrize("case", DATA["cases"], ids=lambda c: c["name"])
def test_actual_owner_frame_is_admitted_at_receiving_clock(case):
    frame = deepcopy(case["generation"])
    before = deepcopy(frame)
    if case["name"] in {"fresh", "fixture"}:
        result = apply_frame(GenerateRequest(), frame, SELECTION, now=DATA["evaluatedAt"])
        assert result.duration == pytest.approx(15.05)
        assert result.source["cosmoaudition"]["frame"] == before
    else:
        # Even a falsely upgraded producer decision cannot bypass the consumer clock.
        frame["receipts"][0].update(status="applied", outputValue=15.05)
        with pytest.raises(ValueError, match="not current"):
            apply_frame(GenerateRequest(), frame, SELECTION, now=DATA["evaluatedAt"])
    assert frame["signals"] == before["signals"]


def test_old_fresh_frame_expires_during_transit_and_forged_freshness_is_ignored():
    frame = deepcopy(next(c["generation"] for c in DATA["cases"] if c["name"] == "fresh"))
    before = deepcopy(frame)
    with pytest.raises(ValueError, match="age-limit-exceeded"):
        apply_frame(GenerateRequest(), frame, SELECTION, now="2026-09-26T12:30:00Z")
    assert frame == before


@pytest.mark.parametrize("timestamp,allowed", [("2026-09-26T11:59:00Z", True), ("2026-07-01T00:00:00Z", False), ("2026-09-26T12:01:00Z", False), (None, False)])
def test_direct_mapping_uses_clock_and_threshold(timestamp, allowed):
    req = CosmoauditionMapRequest(mapping=dict(id="m",signalId="s",target="duration",inputRange=[0,100],outputRange=[.1,30]),signal=dict(id="s",value=50,confidence="high",timestamp=timestamp,staleAfterSeconds=1800))
    result = execute_cosmoaudition_mapping(req, now=DATA["evaluatedAt"])
    assert (result["outputValue"] is not None) == allowed


def test_old_fixture_stale_receipt_cannot_opt_in_to_a_number():
    frame = deepcopy(next(c["generation"] for c in DATA["cases"] if c["name"] == "fixture"))
    frame["receipts"][0].update(status="uncertainty", reason="stale-input", outputValue=15.05)
    with pytest.raises(ValueError, match="source-stale"):
        apply_frame(GenerateRequest(), frame, SELECTION, now=DATA["evaluatedAt"])


@pytest.mark.parametrize("limit", [0, -1, float("nan"), 1e300, None])
def test_invalid_or_zero_age_limit_cannot_create_current_mapping(limit):
    from server.cosmo_freshness import evaluate_signal
    signal = dict(timestamp=DATA["evaluatedAt"], confidence="high", staleAfterSeconds=limit)
    assert not evaluate_signal(signal, now=DATA["evaluatedAt"])["mappingAllowed"]
