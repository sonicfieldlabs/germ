"""Read-only instrument admission inventory; importing this never loads a model."""

from importlib import metadata, util


def catalog(*, verify_deployments=False):
    from server.research.deployment import deployment

    entries = [
        dict(
            id="spectral-frame",
            owner="germ",
            endpoint="/workspace/spectral/frame",
            status="source_gated",
            dependency="numpy/scipy",
            max_seconds=30,
            claim="Retained numerical frame reconstruction; no source recovery or physical audibility claim",
        ),
        dict(
            id="observation-audification",
            owner="germ",
            endpoint="/workspace/spectral/audify",
            status="source_gated",
            dependency="numpy/scipy",
            max_seconds=30,
            claim="Explicit parameter mapping from retained observations; missing values refused",
        ),
    ]
    try:
        present = util.find_spec("pyroomacoustics") is not None
        version = metadata.version("pyroomacoustics") if present else None
    except (ImportError, metadata.PackageNotFoundError):
        present, version = False, None
    entries.append(
        dict(
            id="shoebox-room",
            owner="germ",
            endpoint=None,
            adapter="server.processing_adapter.execute",
            status="policy_gated" if present else "dependency_unavailable",
            dependency="pyroomacoustics",
            version=version,
            max_seconds=30,
            max_tail_seconds=5,
            claim="Image-source digital simulation; no measured-room, capture or playback qualification",
        )
    )
    for tool in ("basic-pitch", "rave-guitar"):
        try:
            entry = deployment(tool, verify=verify_deployments)
            status, license_note = (
                (
                    "deployment_hash_verified"
                    if verify_deployments
                    else "declared_execution_recheck_required"
                ),
                entry["license"],
            )
        except (OSError, ValueError, KeyError):
            status, license_note = "deployment_unavailable", None
        entries.append(
            dict(
                id=tool,
                owner="germ",
                endpoint="/research/run",
                status=status,
                license=license_note,
                max_seconds=30,
                max_job_seconds=180,
                claim="Checkpoint-specific admitted job; independent corroboration remains false",
            )
        )
    return dict(
        contract="germ/instruments/v1",
        instruments=entries,
        auto_install=False,
        max_concurrency=1,
        live_qualification="not_claimed",
    )
