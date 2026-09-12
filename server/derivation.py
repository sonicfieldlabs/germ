"""Owner-local A12 templates. Plans propose a sound; they never enqueue a job."""

from copy import deepcopy
from datetime import datetime, timezone
from akousma.listening_context import claim_validity_at
import hashlib
import json

from akousma import validation_errors
from akouo_contract.agent_report import agent_report_errors
from akouo_contract.record_workflows import derivation_plan
from server.akousma_store import derive_prompt_contract

POLICY = {
    "id": "germ:derivation",
    "revision": "1",
    "parameters": {
        "duration": {"minimum": 0.1, "maximum": 60, "unit": "s"},
        "steps": {"minimum": 1, "maximum": 250, "unit": "iterations"},
        "cfg_scale": {"minimum": 0, "maximum": 25, "unit": "ratio"},
    },
}
TEMPLATES = {
    "variation": "Propose a new variation from these retained descriptions",
    "combine": "Propose a new composition combining these retained descriptions",
    "structured": "Propose a new sound from these attributed structured features",
}


def catalog():
    return dict(
        policy=deepcopy(POLICY),
        templates=[dict(id=k, instruction=v) for k, v in TEMPLATES.items()],
        defaults=dict(duration=4, steps=8, cfg_scale=1),
        execution="not_requested",
        mappings=[
            dict(
                names=["time_scale"],
                unit="s",
                shape="number 0.1–60",
                target="duration",
                aggregate="maximum",
            ),
            dict(
                names=["frequency_band"],
                unit="Hz",
                shape="ordered nonnegative pair",
                target="prompt",
            ),
            dict(
                names=["texture", "gesture", "material"],
                unit="descriptor",
                shape="text 1–256 characters",
                target="prompt",
            ),
        ],
    )


def _digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def _reports(record):
    found = []
    for namespace, envelope in record.get("listening", {}).items():
        if not isinstance(envelope, dict):
            continue
        report = envelope.get("payload", envelope)
        if not isinstance(report, dict) or report.get("contract") != "akouo/agent-report/v0.1":
            continue
        errors = agent_report_errors(report)
        if errors:
            raise ValueError("; ".join(errors))
        bindings = record.get("auditum", {}).get("listenings", [])
        if not any(
            b.get("report_namespace") == namespace
            and b.get("listening_pass_ref") == report["listening_pass_id"]
            and b.get("listener_id") == report["listener_id"]
            for b in bindings
        ):
            raise ValueError("Report must bind to its retained listening account")
        if record.get("subject") != report["subject_ref"]:
            raise ValueError("Report subject differs from retained record")
        access = record.get("extensions", {}).get("earworm_listening_access", {})
        if access.get("declaration_id") != report["apparatus_ref"]:
            raise ValueError("Report apparatus declaration is unresolved")
        found.append(report)
    return found


def _structured(records, now):
    fragments, mappings, omitted, durations, reports = [], [], [], [], []
    for record in records:
        selected = _reports(record)
        if not selected:
            raise ValueError("Each structured source must retain a bound agent report")
        for report in selected:
            reports.append(
                dict(
                    record_ref=record["akousma_id"],
                    report_id=report["report_id"],
                    sha256=_digest(report),
                    limitations=deepcopy(report["limitations"]),
                )
            )
            for feature in report["features"]:
                ref = dict(
                    record_ref=record["akousma_id"],
                    report_id=report["report_id"],
                    feature_id=feature["feature_id"],
                    category=feature["category"],
                )
                claims = (
                    record.get("extensions", {})
                    .get("earworm_listening_context", {})
                    .get("claims", [])
                )
                declarations = [c for c in claims if c["claim_ref"] == feature["claim"]["claim_id"]]
                validity = claim_validity_at(declarations[0], now) if declarations else "unknown"
                ref.update(
                    claim_id=feature["claim"]["claim_id"],
                    validity=validity,
                    evidence_refs=deepcopy(feature["claim"]["evidence_refs"]),
                )
                if validity in ("expired", "not_yet_valid"):
                    omitted.append(dict(**ref, reason=validity))
                    continue
                value = feature["value"]
                if value["status"] != "known" or feature["category"] == "undetermined":
                    omitted.append(dict(**ref, reason=value["status"]))
                    continue
                name, unit, val = feature["name"], value["unit"], value["value"]
                target = None
                # Exact names and units are part of the host mapping policy, not synonyms
                # inferred from prose. Values outside it stay explicit omissions.
                if (
                    name == "time_scale"
                    and unit == "s"
                    and type(val) in (int, float)
                    and 0.1 <= val <= 60
                ):
                    durations.append(val)
                    target = "duration"
                elif (
                    name == "frequency_band"
                    and unit == "Hz"
                    and isinstance(val, list)
                    and len(val) == 2
                    and all(type(n) in (int, float) for n in val)
                    and 0 <= val[0] <= val[1]
                ):
                    fragments.append(
                        f"{record['akousma_id']} / {feature['feature_id']}: proposed band reference {val[0]}–{val[1]} Hz"
                    )
                    target = "prompt"
                elif (
                    name in ("texture", "gesture", "material")
                    and unit == "descriptor"
                    and isinstance(val, str)
                    and 0 < len(val.strip()) <= 256
                ):
                    fragments.append(
                        f"{record['akousma_id']} / {feature['feature_id']}: {name} = {val.strip()}"
                    )
                    target = "prompt"
                if target:
                    mappings.append(
                        dict(
                            **ref,
                            namespace=feature["namespace"],
                            name=name,
                            value=deepcopy(value),
                            target=target,
                            claim_category="speculative",
                        )
                    )
                else:
                    omitted.append(dict(**ref, reason="Unsupported name, unit, value or range"))
    if not mappings:
        raise ValueError("No supported known features; no derivation was invented")
    return fragments, mappings, omitted, durations, reports


def build(store, body):
    if not isinstance(body, dict) or set(body) - {"workflow", "template", "parameters"}:
        raise ValueError("Expected workflow, template and optional parameters")
    request = deepcopy(body.get("workflow"))
    if not isinstance(request, dict):
        raise ValueError("workflow is required")
    template = body.get("template")
    if not isinstance(template, str) or template not in TEMPLATES:
        raise ValueError("Unknown template")
    refs = request.get("source_refs")
    if (
        not isinstance(refs, list)
        or not 1 <= len(refs) <= 32
        or any(not isinstance(r, str) or not r for r in refs)
        or len(set(refs)) != len(refs)
    ):
        raise ValueError("Select 1-32 distinct retained source references")
    records = [store.get(ref) for ref in refs]
    if any(r is None for r in records):
        raise ValueError("Missing retained source")
    for record in records:
        if len(json.dumps(record, allow_nan=False).encode()) > 2 * 1024 * 1024:
            raise ValueError("Selected source exceeds 2 MiB")
        errors = validation_errors(record)
        if errors:
            raise ValueError("Invalid retained source: " + "; ".join(errors))
        if record.get("provenance", {}).get("consent_status") == "restricted":
            raise ValueError("Restricted retained source")
        covenant = record.get("covenant") or {}
        if any(covenant.get(k) for k in ("withheld", "rules_applied", "commitments")):
            raise ValueError("Covenant-bearing source requires a dedicated derivation policy")
    params = dict(duration=4, steps=8, cfg_scale=1)
    overrides = body.get("parameters", {})
    if not isinstance(overrides, dict) or set(overrides) - set(params):
        raise ValueError("Unsupported generation parameter")
    fragments, mappings, omitted, durations, reports = [], [], [], [], []
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if template == "structured":
        fragments, mappings, omitted, durations, reports = _structured(records, now)
        if durations:
            params["duration"] = max(durations)  # explicit compositional choice, not measurement
    else:
        fragments = [f"{r['akousma_id']}: {derive_prompt_contract(r)['prompt']}" for r in records]
    params.update(overrides)
    if type(params["steps"]) is not int:
        raise ValueError("steps must be an integer")
    if any(type(v) not in (int, float) for v in params.values()):
        raise ValueError("Parameters must be JSON numbers")
    # Policy negotiation is explicit. The caller cannot override the host policy.
    for key in ("prompt", "parameters", "kind"):
        if key in request:
            raise ValueError("Template owns " + key)
    request.update(
        kind="derivation",
        prompt=TEMPLATES[template]
        + ": "
        + "; ".join(fragments or ["duration from a retained time-scale feature"]),
        parameters=params,
    )
    plan = derivation_plan(
        request, records, parameter_policy=POLICY, validate_record=validation_errors
    )
    if any(_digest(store.get(r["akousma_id"])) != _digest(r) for r in records):
        raise RuntimeError("Source changed during derivation; retry")
    plan.update(
        template=template,
        evaluated_at=now,
        mapping_revision="1",
        mappings=mappings,
        omitted=omitted,
        reports=reports,
        parameter_overrides=deepcopy(overrides),
        duration_aggregation="maximum supported time_scale, unless explicitly overridden",
        generation_fields=dict(
            prompt=plan["prompt"],
            **params,
            parent_akousma_ids=refs,
            source=dict(kind="retained-record-derivation", request_id=request["request_id"]),
            lineage=dict(operation="derivation-plan", plan_sources=plan["sources"]),
        ),
    )
    plan["generation_fields"]["source"]["derivation"] = deepcopy(
        {
            key: plan[key]
            for key in (
                "contract",
                "request_id",
                "actor_ref",
                "permissions",
                "sources",
                "parameter_policy",
                "template",
                "mapping_revision",
                "evaluated_at",
                "mappings",
                "omitted",
                "reports",
                "parameter_overrides",
                "claim_category",
                "limitation",
            )
        }
    )
    plan["generation_fields"]["source"]["derivation"]["covenants"] = [
        dict(record_ref=r["akousma_id"], covenant=deepcopy(r["covenant"]))
        for r in records
        if r.get("covenant")
    ]
    return plan
