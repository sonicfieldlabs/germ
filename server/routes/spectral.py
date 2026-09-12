"""Retained numeric evidence into explicit generation jobs."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from server.akousma_store import open_store
from server.audify import digest, resolve
from server.routes.jobs import submit_job
from server.schemas import JobSubmitRequest
from server.spectral_brief import extract

router = APIRouter(prefix="/workspace/spectral")


class Render(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    selection: dict
    sample_rate: int = 44100
    duration: float = Field(default=2, ge=0.1, le=30)
    gain: float = Field(default=0.2, ge=0, le=1)
    seed: int = Field(default=42, ge=0, le=4294967294)


@router.get("/sources")
def sources():
    try:
        from akousmata_app.derivatives import authorized_bundle
    except ImportError as exc:
        raise HTTPException(503, "Install GERM spectral support on Python 3.11 or later") from exc
    entries = []
    with open_store() as store:
        for record in store.query(limit=1000):
            ref = record["akousma_id"]
            if store.forgotten(ref):
                continue
            binding = record.get("extensions", {}).get("earworm_observation")
            if binding:
                source = record["listening"][binding["mapping_namespace"]]["payload"][
                    "source_snapshot"
                ]
                for series in source.get("extensions", {}).get("cosmo:observation-series", []):
                    selection = dict(
                        record_ref=ref,
                        series_id=series["seriesId"],
                        series_sha256=digest(series),
                        mode="parameter_mapping",
                        input_range=[0, 1],
                        frequency_range=[100, 1000],
                        resampling="none",
                        missing_data="reject",
                    )
                    try:
                        resolve(selection)
                    except ValueError:
                        continue
                    values = [
                        p["value"]
                        for p in series["points"]
                        if p.get("status") == "reported" and p.get("value") is not None
                    ]
                    if values:
                        selection["input_range"] = [
                            min(values),
                            max(values) if max(values) > min(values) else min(values) + 1,
                        ]
                    entries.append(
                        dict(
                            kind="observation",
                            label=series["seriesId"],
                            selection=selection,
                            unit=series["unit"],
                            points=len(series["points"]),
                            mode=series["mode"],
                        )
                    )
            try:
                bundle = authorized_bundle(store, ref)
            except ValueError:
                continue
            for view in bundle["views"]:
                if view["state"] == "retained" and view["kind"] == "complex_stft":
                    entries.append(
                        dict(
                            kind="frame",
                            label=ref
                            + " / "
                            + view["view_id"]
                            + " / FFT "
                            + str(view["settings"]["fft_length"]),
                            selection=dict(
                                record_ref=ref,
                                view_id=view["view_id"],
                                view_sha256=view["sha256"],
                                frame=min(2, view["shape"][2] - 1),
                                channel=0,
                                partials=3,
                            ),
                            shape=view["shape"],
                            rate=bundle["effective_rate_hz"],
                            fft_length=view["settings"]["fft_length"],
                        )
                    )
    return {"sources": entries[:1000]}


def submit(request, kind):
    try:
        if kind == "audification":
            resolve(request.selection)
        else:
            extract(request.selection)
        return submit_job(
            JobSubmitRequest(
                mode="text-to-audio",
                request=dict(
                    provider="synthesis",
                    model="audification" if kind == "audification" else "additive",
                    prompt="Explicit retained observation mapping"
                    if kind == "audification"
                    else "Explicit retained spectral frame reconstruction",
                    duration=request.duration,
                    seed=request.seed,
                    remember_to_akousmata=True,
                    parent_akousma_ids=[request.selection["record_ref"]],
                    source={
                        kind: request.selection,
                        "synthesis": {"sample_rate": request.sample_rate, "gain": request.gain},
                    },
                ),
            )
        )
    except ImportError as exc:
        raise HTTPException(503, "Install GERM spectral support on Python 3.11 or later") from exc
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/audify")
def audify(request: Render):
    return submit(request, "audification")


@router.post("/frame")
def frame(request: Render):
    return submit(request, "spectral_frame")
