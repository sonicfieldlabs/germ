from copy import deepcopy
import json
import pytest
from server.cosmo_generation import apply_frame
from server.schemas import GenerateRequest
from server.routes._utils import run_provider_method
from server.registry import storage


def frame(status="applied", value=2):
    return dict(
        contract="cosmo/generation-frame/v1",
        frameId="fixture:frame",
        generatedAt="2026-09-07T00:00:00Z",
        acquisitionMode="fixture",
        originMode="fixture",
        relation={"of": "signal"},
        sourceRegister="non-acoustic",
        signals=[dict(id="carbon", confidence="high", timestamp="2026-09-01T00:00:00Z", staleAfterSeconds=1800)],
        receipts=[
            dict(
                signalId="carbon",
                mappingId="germ-carbon-duration",
                receiptId="fixture:receipt",
                target="duration",
                status=status,
                outputValue=value,
                sourceClock="2026-09-01T00:00:00Z",
                captureClock="2026-09-07T00:00:00Z",
                evidenceClass="fixture",
                attribution=[{"sourceId": "carbon_intensity_gb"}],
            )
        ],
    )


def selection(**kw):
    return dict(
        mapping_ids=["germ-carbon-duration"],
        intermodulation="replace",
        accept_held=False,
        accept_uncertainty=False,
        **kw,
    )


def test_attributed_frame_reaches_existing_masa_receipt():
    source = frame(value=0.2)
    before = deepcopy(source)
    request = apply_frame(
        GenerateRequest(
            provider="synthesis",
            model="additive",
            prompt="Synthetic frame",
            masa_contracts=["masa/0.2.0"],
        ),
        source,
        selection(),
    )
    result = run_provider_method(request, "text-to-audio", "generate")
    assert result.status == "done"
    metadata = json.loads(storage.resolve_path(result.metadata_files[0]).read_text())
    masa = json.loads(storage.resolve_path(metadata["masa"]["sidecar_path"]).read_text())
    assert masa["history"]["events"][-1]["extensions"]["germ:cosmoaudition"]["frame"] == source
    assert source == before


@pytest.mark.parametrize("status", ["held", "uncertainty", "refused", "skipped"])
def test_nonapplied_default_refuses(status):
    with pytest.raises(ValueError):
        apply_frame(GenerateRequest(), frame(status), selection())


def test_explicit_hold_and_intermodulation_bounds():
    chosen = selection()
    chosen["accept_held"] = True
    request = apply_frame(GenerateRequest(), frame("held"), chosen)
    assert request.duration == 2
    assert request.source["cosmoaudition"]["decisions"][0]["status"] == "held"
    chosen["intermodulation"] = "multiply"
    with pytest.raises(ValueError):
        apply_frame(GenerateRequest(duration=20), frame(value=2), chosen)
