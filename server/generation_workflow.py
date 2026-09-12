"""One-command retained-record derivation through the existing provider runner."""

from copy import deepcopy
import json
from hashlib import sha256

from server.derivation import build, _digest
from server.akousma_store import open_store
from server.registry import storage, settings
from server.schemas import GenerateRequest, ListenerRelistenRequest
from server.routes._utils import run_provider_method


def check_sources(store, plan):
    sources = plan.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 32:
        raise ValueError("Missing bounded derivation sources")
    for item in sources:
        record = store.get(item["record_ref"])
        if (
            record is None
            or record.get("provenance", {}).get("consent_status") == "restricted"
            or _digest(record) != item["sha256"]
        ):
            raise ValueError("Derivation source changed, restricted or forgotten")


def admit_derivation(request):
    from server.derivation import POLICY

    plan = request.source["derivation"]
    if plan.get("parameter_policy") != POLICY:
        raise ValueError("Unrecognized derivation parameter policy")
    for key, bound in POLICY["parameters"].items():
        value = getattr(request, key)
        if not bound["minimum"] <= value <= bound["maximum"]:
            raise ValueError("Execution exceeds derivation policy: " + key)
    refs = [item["record_ref"] for item in plan.get("sources", [])]
    if len(set(refs)) != len(refs) or set(refs) != set(request.parent_akousma_ids):
        raise ValueError("Execution parents differ from selected sources")
    permissions = plan.get("permissions", [])
    if (
        len(permissions) != len(refs)
        or {p.get("record_ref") for p in permissions} != set(refs)
        or any(p.get("status") != "granted" or not p.get("permission_ref") for p in permissions)
    ):
        raise ValueError("Each execution source requires declared permission")
    with open_store() as store:
        check_sources(store, plan)


def execute(body):
    if not isinstance(body, dict) or set(body) != {"derivation", "execution"}:
        raise ValueError("Expected derivation and execution")
    options = body["execution"]
    if not isinstance(options, dict) or set(options) - {
        "provider",
        "model",
        "seed",
        "masa_contracts",
        "record_contract",
        "relisten",
        "synthesis",
    }:
        raise ValueError("Unsupported execution option")
    if not isinstance(options.get("provider"), str) or not isinstance(options.get("model"), str):
        raise ValueError("Choose an explicit provider and model")
    if options.get("record_contract") != "earworm/akousma/v1.6":
        raise ValueError("Explicit earworm/akousma/v1.6 output negotiation is required")
    if options.get("masa_contracts") != ["masa/0.2.0"]:
        raise ValueError("Explicit masa/0.2.0 generation negotiation is required")
    if type(options.get("relisten", False)) is not bool:
        raise ValueError("relisten must be boolean")
    if "synthesis" in options and (options.get("provider") != "synthesis" or not isinstance(options["synthesis"], dict)):
        raise ValueError("Synthesis parameters require the synthesis provider")
    if not settings.masa_sidecars_enabled:
        raise ValueError("Enable owner MASA sidecars for this linked workflow")
    with open_store() as store:
        plan = build(store, body["derivation"])
        request = GenerateRequest(
            **deepcopy(plan["generation_fields"]),
            provider=options["provider"],
            model=options["model"],
            seed=options.get("seed", -1),
            masa_contracts=options["masa_contracts"],
            remember_to_akousmata=True,
        )
        if "synthesis" in options:
            request.source["synthesis"] = deepcopy(options["synthesis"])
        request.source["derivation"]["output_record_contract"] = options["record_contract"]
        request.source["derivation"]["masa_contracts"] = options["masa_contracts"]
        check_sources(store, plan)
    # Existing provider admission, job storage, error handling and sidecar writer.
    result = run_provider_method(request, "text-to-audio", "generate")
    links, gaps = [], []
    if result.status == "done":
        for filename in result.metadata_files:
            try:
                path = storage.resolve_existing_metadata_path(filename)
                metadata = json.loads(path.read_text())
                if metadata.get("generation_job_id") != result.job_id:
                    raise ValueError("Metadata does not bind to this generation job")
                output = storage.resolve_existing_input_audio_path(metadata["output_audio_path"])
                digest = sha256()
                with output.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                masa = metadata.get("masa", {})
                if (
                    masa.get("status") != "written"
                    or masa.get("output_sha256") != digest.hexdigest()
                ):
                    raise ValueError("Missing MASA receipt or changed output bytes")
                akousmata = metadata.get("akousmata", {})
                if not akousmata.get("akousma_id"):
                    raise ValueError("Output exists but canonical generation retention failed")
                links.append(
                    dict(
                        metadata_file=filename,
                        audio_file=metadata["output_audio_path"],
                        output_sha256=digest.hexdigest(),
                        akousma_id=akousmata["akousma_id"],
                        parent_refs=plan["parent_refs"],
                        masa=masa,
                    )
                )
            except (ValueError, OSError, KeyError) as exc:
                gaps.append(dict(metadata_file=filename, reason=str(exc)))
        if not result.metadata_files:
            gaps.append(dict(reason="Completed provider result has no retained metadata"))
    subsequent = []
    if options.get("relisten") and result.status == "done":
        from server.listener import relisten_with_oida

        for link in links:
            try:
                # The existing bridge owns the actual pass. G8 handles retained decisions.
                listened = relisten_with_oida(
                    ListenerRelistenRequest(
                        audio_path=link["audio_file"],
                        metadata_path=link["metadata_file"],
                        prompt=plan["prompt"],
                        remember=False,
                        context={
                            "generation_akousma_id": link["akousma_id"],
                            "output_sha256": link["output_sha256"],
                        },
                    )
                )
                subsequent.append(
                    dict(
                        status="completed",
                        generation_akousma_id=link["akousma_id"],
                        output_sha256=link["output_sha256"],
                        result=listened.model_dump(),
                    )
                )
            except Exception as exc:
                subsequent.append(
                    dict(status="error", generation_akousma_id=link["akousma_id"], error=str(exc))
                )
    return dict(
        contract="germ/linked-generation/v0.1",
        plan=plan,
        generation=result.model_dump(),
        linkage_status="complete"
        if result.status == "done" and links and not gaps
        else "incomplete",
        outputs=links,
        gaps=gaps,
        subsequent_listening=subsequent,
    )
