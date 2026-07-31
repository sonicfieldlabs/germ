from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from server.identity import PRODUCT_NAME, __version__


MASA_VERSION = "0.1.0"
MASA_SCHEMA = "https://smo.sonicfield.org/masa/schemas/0.1.0/matter-record.schema.json"


def _id(kind: str, value: str) -> str:
    return f"urn:uuid:{uuid5(NAMESPACE_URL, f'germ:{kind}:{value}')}"


def _known(value: Any) -> dict[str, Any]:
    return {"state": "known", "value": value}


def _unknown(reason: str, code: str) -> dict[str, Any]:
    return {"state": "unknown", "reason": reason, "reasonCode": code}


def _qualified(value: Any, *, missing: str = "not_applicable") -> dict[str, Any]:
    if value is None or value == "":
        return {"state": missing}
    return _known(value)


def _audio_technical(metadata: dict[str, Any]) -> dict[str, Any]:
    duration = metadata.get("duration")
    sample_rate = metadata.get("sample_rate")
    return {
        "durationSeconds": (
            _known(duration)
            if isinstance(duration, (int, float)) and duration >= 0
            else _unknown("Duration was not committed in the GERM record.", "not_recorded")
        ),
        "channels": _unknown(
            "Channel count is not asserted by the GERM generation record.",
            "not_recorded",
        ),
        "sampleRateHz": (
            _known(sample_rate)
            if isinstance(sample_rate, int) and sample_rate > 0
            else _unknown("Sample rate was not committed in the GERM record.", "not_recorded")
        ),
        "encoding": _known("WAVE audio; exact encoding is not asserted by this crosswalk"),
        "spatialFormat": _unknown(
            "Spatial format is not asserted by the GERM generation record.",
            "not_recorded",
        ),
        "levelContext": _unknown(
            "No calibrated playback or capture level accompanies this generation.",
            "not_calibrated",
        ),
    }


def _parent_representation(parent_sound_id: str, policy_id: str) -> dict[str, Any]:
    representation_id = _id("representation", parent_sound_id)
    return {
        "id": representation_id,
        "type": "masa:Representation",
        "role": "source-representation",
        "mediaType": "audio/wav",
        "format": _unknown(
            "The parent is referenced by GERM sound id; its bytes are not embedded here.",
            "external_lineage",
        ),
        "availability": "unavailable",
        "locator": _unknown(
            "Resolve the parent through the canonical GERM Sonic Lineage graph.",
            "external_lineage",
        ),
        "integrity": _unknown(
            "The parent bytes are not present in this standalone sidecar.",
            "not_bundled",
        ),
        "policyRefs": [policy_id],
        "disclosure": "private",
        "extensions": {"germ:lineage": {"soundId": parent_sound_id}},
    }


def _operation_type(metadata: dict[str, Any], parent_count: int) -> str:
    value = str(metadata.get("operation") or metadata.get("germinator_mode") or "generate").lower()
    if "inpaint" in value and parent_count:
        return "matter.inpaint"
    if "continu" in value and parent_count:
        return "matter.continue"
    if "graft" in value and parent_count >= 2:
        return "matter.graft"
    if any(token in value for token in ("mutat", "variation", "audio-to-audio")) and parent_count:
        return "matter.mutate"
    return "matter.generate"


def _stable_audio_parameters(metadata: dict[str, Any]) -> dict[str, Any]:
    latents = metadata.get("latents") if isinstance(metadata.get("latents"), dict) else {}
    return {
        key: value
        for key, value in {
            "duration": metadata.get("duration"),
            "steps": metadata.get("steps"),
            "cfgScale": metadata.get("cfg_scale"),
            "seed": metadata.get("seed"),
            "batchSize": metadata.get("batch_size"),
            "initNoiseLevel": metadata.get("init_noise_level"),
            "inpaintRanges": metadata.get("inpaint_ranges"),
            "loraStrains": metadata.get("lora_strains"),
            "latentFile": metadata.get("latent_file") or latents.get("file"),
            "latentFingerprint": metadata.get("latent_fingerprint") or latents.get("fingerprint"),
            "controlRoutes": metadata.get("control_routes"),
            "semanticEffects": metadata.get("semantic_effects"),
        }.items()
        if value not in (None, "", [], {})
    }


def build_generation_record(metadata: dict[str, Any]) -> dict[str, Any]:
    """Crosswalk one committed GERM output without replacing Sonic Lineage.

    The returned object is self-contained and uses deterministic MASA URNs.
    It deliberately preserves GERM's ``sound_id`` inside an extension instead
    of treating the MASA Representation id as GERM's canonical identity.
    """

    sound_id = str(metadata.get("sound_id") or "").strip()
    if not sound_id:
        raise ValueError("GERM metadata is missing its canonical sound_id")
    output_path = str(metadata.get("output_audio_path") or "").strip()
    if not output_path:
        raise ValueError("GERM metadata is missing its committed output_audio_path")
    created_at = str(metadata.get("created_at") or "").strip()
    if not created_at:
        raise ValueError("GERM metadata is missing created_at")

    lineage = metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}
    parents = [
        str(value).strip()
        for value in lineage.get("parents", metadata.get("parents", []))
        if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip()
    ]
    parents = list(dict.fromkeys(parents))[:128]
    record_id = _id("record", sound_id)
    representation_id = _id("representation", sound_id)
    actor_id = _id("actor", "germ")
    policy_id = _id("policy", sound_id)
    rule_id = _id("policy-rule", sound_id)
    receipt_id = _id("operation", sound_id)
    tool_id = _id("tool", f"{metadata.get('provider')}:{metadata.get('model')}")
    parent_representations = [_parent_representation(parent, policy_id) for parent in parents]
    parent_representation_ids = [item["id"] for item in parent_representations]
    operation_type = _operation_type(metadata, len(parents))
    prompt_representation: dict[str, Any] | None = None
    prompt_representation_id: str | None = None
    # MASA requires every completed output to retain a receipt-bound parent
    # relation. Text-only generation therefore carries its prompt as a
    # Representation instead of fabricating an audio ancestor.
    if not parent_representation_ids:
        prompt_representation_id = _id("prompt", sound_id)
        prompt_representation = {
            "id": prompt_representation_id,
            "type": "masa:Representation",
            "role": "prompt",
            "mediaType": "text/plain",
            "format": _known("UTF-8 prompt text recorded in GERM metadata"),
            "availability": "available",
            "locator": _known(f"{metadata.get('metadata_path') or 'germ-metadata'}#prompt"),
            "integrity": _unknown(
                "Prompt text is embedded in the companion GERM metadata, not hashed here.",
                "not_bundled",
            ),
            "policyRefs": [policy_id],
            "disclosure": "private",
            "extensions": {"germ:prompt": {"kind": "generation-conditioning"}},
        }

    regions: list[dict[str, Any]] = []
    region_refs: list[str] = []
    if operation_type == "matter.inpaint" and parent_representation_ids:
        region_id = _id("region", sound_id)
        region_refs.append(region_id)
        ranges = metadata.get("inpaint_ranges")
        regions.append(
            {
                "id": region_id,
                "type": "masa:Region",
                "representationRef": parent_representation_ids[0],
                "basis": "temporal",
                "bounds": {"germInpaintRanges": ranges if isinstance(ranges, list) else []},
                "createdBy": actor_id,
                "createdAt": created_at,
                "uncertainty": [
                    "The sidecar preserves GERM's authored range payload without asserting sample-accurate verification."
                ],
                "extensions": {"germ:lineage": {"soundId": parents[0]}},
            }
        )

    output_representation = {
        "id": representation_id,
        "type": "masa:Representation",
        "role": "model-output",
        "mediaType": "audio/wav",
        "format": _known("GERM WAVE output"),
        "availability": "available",
        "locator": _known(output_path),
        "integrity": _unknown(
            "This sidecar does not hash the separately stored audio bytes.",
            "not_bundled",
        ),
        "policyRefs": [policy_id],
        "disclosure": "private",
        "extensions": {
            "germ:lineage": {
                "soundId": sound_id,
                "metadataPath": metadata.get("metadata_path"),
                "parentSoundIds": parents,
            },
            "germ:stableAudio": _stable_audio_parameters(metadata),
        },
        "audio": _audio_technical(metadata),
    }

    relations = [
        {
            "id": _id("relation", f"{sound_id}:{parent}"),
            "type": "masa:Relation",
            "subject": representation_id,
            "predicate": "masa:derived-from",
            "object": parent_representation_ids[index],
            "assertedBy": actor_id,
            "createdAt": created_at,
            "basis": [{"ref": receipt_id, "role": "operation"}],
            "operationRef": receipt_id,
            "extensions": {"germ:lineage": {"parentSoundId": parent}},
        }
        for index, parent in enumerate(parents)
    ]
    if prompt_representation_id is not None:
        relations.append(
            {
                "id": _id("relation", f"{sound_id}:prompt"),
                "type": "masa:Relation",
                "subject": representation_id,
                "predicate": "masa:derived-from",
                "object": prompt_representation_id,
                "assertedBy": actor_id,
                "createdAt": created_at,
                "basis": [{"ref": receipt_id, "role": "operation"}],
                "operationRef": receipt_id,
                "extensions": {"germ:prompt": {"kind": "generation-conditioning"}},
            }
        )

    provider = str(metadata.get("provider") or "unknown")
    model = str(metadata.get("model") or "unknown")
    seed = metadata.get("seed")
    determinism = (
        {"state": "seeded", "seed": seed}
        if seed is not None
        else {"state": "nondeterministic", "note": "No seed is asserted in GERM metadata."}
    )
    generation_parameters = {
        "generationMethod": str(metadata.get("germinator_mode") or metadata.get("mode") or "generate"),
        "parentRefs": parent_representation_ids,
        "conditioningRefs": (
            [prompt_representation_id] if prompt_representation_id is not None else []
        ),
        "regionRefs": region_refs,
        "prompt": _qualified(metadata.get("prompt")),
        "negativePrompt": _qualified(metadata.get("negative_prompt")),
        "model": _known(model),
        "adapter": _known(f"GERM MASA crosswalk {__version__}"),
        "provider": _known(provider),
        "providerPolicyState": _unknown(
            "Provider terms and authority are not interpreted by this local crosswalk.",
            "not_assessed",
        ),
        "selection": _known("GERM committed this successful output."),
        "rejectedOutputRefs": [],
        "germParameters": _stable_audio_parameters(metadata),
    }

    receipt = {
        "id": receipt_id,
        "type": "masa:OperationReceipt",
        "recordId": record_id,
        "sequence": 0,
        "operationType": operation_type,
        "effectClass": "generate",
        "finalStatus": "completed",
        "startedAt": created_at,
        "endedAt": created_at,
        "actors": [actor_id],
        "inputs": [
            *parent_representation_ids,
            *([prompt_representation_id] if prompt_representation_id is not None else []),
        ],
        "outputs": [representation_id],
        "tool": {
            "state": "known",
            "value": {
                "id": tool_id,
                "name": PRODUCT_NAME,
                "version": _known(__version__),
                "kind": "software",
                "provider": _known(provider),
                "adapter": _known("GERM MASA sidecar crosswalk"),
            },
        },
        "parameters": generation_parameters,
        "policyEvaluation": {
            "action": "generate",
            "targets": [representation_id],
            "policyRefs": [policy_id],
            "result": "permitted",
            "evaluatedAt": created_at,
            "evaluator": actor_id,
            "authorityRefs": [rule_id],
            "reasons": [
                "The local GERM operation completed before this descriptive sidecar was written."
            ],
        },
        "reversibility": "irreversible",
        "determinism": determinism,
        "warnings": [
            "This interoperability sidecar does not replace GERM Sonic Lineage or imply source identity."
        ],
        "errors": [],
        "claimRefs": [],
        "extensions": {"germ:lineage": {"soundId": sound_id}},
    }

    return {
        "$schema": MASA_SCHEMA,
        "masaVersion": MASA_VERSION,
        "id": record_id,
        "type": "masa:MatterRecord",
        "revision": 1,
        "profiles": ["core", "audio", "generation"],
        "createdAt": created_at,
        "createdBy": actor_id,
        "title": f"GERM sound {sound_id}",
        "description": (
            "A private MASA interoperability account for a GERM representation; "
            "the representation is not asserted to be identical to a physical event or perceptual object."
        ),
        "actors": [
            {
                "id": actor_id,
                "type": "masa:Actor",
                "actorKind": "software",
                "roles": ["record-creator", "operation-executor"],
                "name": _known(PRODUCT_NAME),
                "disclosure": "private",
                "extensions": {"germ:version": __version__},
            }
        ],
        "sources": [],
        "representations": [
            *parent_representations,
            *([prompt_representation] if prompt_representation is not None else []),
            output_representation,
        ],
        "encounters": [],
        "apertures": [],
        "listeningPasses": [],
        "claims": [],
        "regions": regions,
        "measurements": [],
        "observations": [],
        "mappings": [],
        "relations": relations,
        "policies": [
            {
                "id": policy_id,
                "type": "masa:Policy",
                "policyKind": "composite",
                "issuer": actor_id,
                "status": "active",
                "disclosure": "private",
                "rules": [
                    {
                        "id": rule_id,
                        "effect": "permission",
                        "actions": ["read", "validate", "generate", "transform"],
                        "targets": [record_id],
                        "subjects": [actor_id],
                        "authorityBasis": _known(
                            "Private local operation initiated through the GERM application."
                        ),
                        "constraints": {"network": "not authorized by this sidecar"},
                        "duties": [
                            "Preserve provenance, uncertainty, and GERM's canonical lineage identity."
                        ],
                    }
                ],
                "review": {
                    "contact": _unknown("No external review contact is asserted.", "local_record"),
                    "route": _known("Review the GERM metadata and this MASA sidecar together."),
                },
                "extensions": {},
            }
        ],
        "contexts": [],
        "agentRuns": [],
        "capabilities": [],
        "integrity": _unknown(
            "The sidecar accounts for a separately stored local audio representation.",
            "not_bundled",
        ),
        "history": {"mode": "embedded", "events": [receipt]},
        "disclosure": "private",
        "registers": ["digital-technical", "compositional-transformational"],
        "scales": ["object-event", "corpus-lineage"],
        "extensions": {
            "germ:lineage": {
                "canonicalIdentity": "sound_id",
                "soundId": sound_id,
                "metadataPath": metadata.get("metadata_path"),
            },
            "germ:crosswalk": {
                "status": "descriptive-sidecar",
                "masaVersion": MASA_VERSION,
            },
        },
    }


def build_analysis_record(artifact: dict[str, Any]) -> dict[str, Any]:
    analysis_id = str(artifact.get("id") or "").strip()
    if not analysis_id:
        raise ValueError("Matter Analysis artifact is missing its id")
    input_audio_path = str(artifact.get("input_audio_path") or "").strip()
    profile_file = str(artifact.get("profile_file") or "").strip()
    created_at = str(artifact.get("created_at") or "").strip()
    if not input_audio_path or not profile_file or not created_at:
        raise ValueError("Matter Analysis artifact is missing a persistence reference")
    source_key = str(artifact.get("source_id") or input_audio_path)
    record_id = _id("analysis-record", analysis_id)
    source_representation_id = _id("representation", source_key)
    analysis_representation_id = _id("analysis-representation", analysis_id)
    actor_id = _id("actor", "germ-matter-analysis")
    policy_id = _id("analysis-policy", analysis_id)
    rule_id = _id("analysis-policy-rule", analysis_id)
    receipt_id = _id("analysis-operation", analysis_id)
    tool_id = _id("tool", "germ-matter-analysis")
    analysis = artifact.get("analysis") if isinstance(artifact.get("analysis"), dict) else {}
    duration = float(artifact.get("duration") or analysis.get("durationSeconds") or 0.0)
    sample_rate = int(artifact.get("sample_rate") or analysis.get("sampleRateHz") or 0)
    channels = int(artifact.get("channels") or analysis.get("channels") or 0)
    amplitude = analysis.get("amplitude") if isinstance(analysis.get("amplitude"), dict) else {}
    temporal = analysis.get("temporal") if isinstance(analysis.get("temporal"), dict) else {}
    spectral = analysis.get("spectral") if isinstance(analysis.get("spectral"), dict) else {}
    method = {
        "name": "GERM bounded Matter Analysis",
        "version": _known(__version__),
        "parameters": {
            "fftSize": artifact.get("fft_size"),
            "maxSpectralFrames": artifact.get("max_frames"),
            "analysisState": analysis.get("analysisState"),
        },
    }
    window = {"kind": "temporal", "unit": "s", "start": 0, "end": max(0.0, duration)}
    measurement_specs: list[tuple[str, Any, str, list[str]]] = [
        ("duration", duration, "s", []),
        (
            "root mean square amplitude",
            amplitude.get("rms", 0.0),
            "linear amplitude",
            ["Uncalibrated digital full-scale reference."],
        ),
        (
            "peak amplitude",
            amplitude.get("peak", 0.0),
            "linear amplitude",
            ["Bounded sampling stride is preserved in the analysis artifact."],
        ),
        (
            "onset density",
            temporal.get("onsetDensityHz", 0.0),
            "events/s",
            ["Thresholded computational onset estimate."],
        ),
    ]
    if spectral.get("state") == "measured":
        measurement_specs.extend(
            [
                ("spectral centroid", spectral.get("centroidHz", 0.0), "Hz", []),
                ("spectral bandwidth", spectral.get("bandwidthHz", 0.0), "Hz", []),
                ("spectral flatness", spectral.get("flatness", 0.0), "ratio", []),
                ("spectral flux", spectral.get("flux", 0.0), "normalized", []),
            ]
        )
    measurements = [
        {
            "id": _id("measurement", f"{analysis_id}:{index}:{metric}"),
            "type": "masa:Measurement",
            "about": source_representation_id,
            "metric": metric,
            "value": value,
            "unit": unit,
            "method": method,
            "window": window,
            "actor": actor_id,
            "createdAt": created_at,
            "uncertainty": uncertainty,
            "extensions": {"germ:matterAnalysis": {"analysisId": analysis_id}},
        }
        for index, (metric, value, unit, uncertainty) in enumerate(measurement_specs)
    ]
    source_audio = {
        "durationSeconds": _known(duration),
        "channels": _known(channels),
        "sampleRateHz": _known(sample_rate),
        "bitDepth": _known(16),
        "encoding": _known("PCM signed integer little-endian"),
        "spatialFormat": _known("mono" if channels == 1 else "stereo"),
        "levelContext": _unknown(
            "No calibrated playback or capture level accompanies the analysis.",
            "not_calibrated",
        ),
    }
    return {
        "$schema": MASA_SCHEMA,
        "masaVersion": MASA_VERSION,
        "id": record_id,
        "type": "masa:MatterRecord",
        "revision": 1,
        "profiles": ["core", "audio", "analysis"],
        "createdAt": created_at,
        "createdBy": actor_id,
        "title": f"GERM Matter Analysis {analysis_id}",
        "description": (
            "A private computational analysis account that keeps measurements, inference, "
            "and unavailable states distinct from heard claims."
        ),
        "actors": [
            {
                "id": actor_id,
                "type": "masa:Actor",
                "actorKind": "software",
                "roles": ["record-creator", "analyst"],
                "name": _known("GERM Matter Analysis"),
                "disclosure": "private",
                "extensions": {"germ:version": __version__},
            }
        ],
        "sources": [],
        "representations": [
            {
                "id": source_representation_id,
                "type": "masa:Representation",
                "role": "source-representation",
                "mediaType": "audio/wav",
                "format": _known("16-bit PCM WAVE accepted by GERM Matter Analysis"),
                "availability": "available",
                "locator": _known(input_audio_path),
                "integrity": _unknown(
                    "The sidecar does not hash the separately stored audio bytes.",
                    "not_bundled",
                ),
                "policyRefs": [policy_id],
                "disclosure": "private",
                "extensions": {"germ:lineage": {"soundId": artifact.get("source_id")}},
                "audio": source_audio,
            },
            {
                "id": analysis_representation_id,
                "type": "masa:Representation",
                "role": "data",
                "mediaType": "application/json",
                "format": _known("GERM Matter Analysis JSON artifact"),
                "availability": "available",
                "locator": _known(profile_file),
                "integrity": _unknown(
                    "The standalone JSON artifact is not hashed by this sidecar.",
                    "not_bundled",
                ),
                "policyRefs": [policy_id],
                "disclosure": "private",
                "extensions": {"germ:matterAnalysis": {"analysisId": analysis_id}},
            },
        ],
        "encounters": [],
        "apertures": [],
        "listeningPasses": [],
        "claims": [],
        "regions": [],
        "measurements": measurements,
        "observations": [],
        "mappings": [],
        "relations": [
            {
                "id": _id("analysis-relation", analysis_id),
                "type": "masa:Relation",
                "subject": analysis_representation_id,
                "predicate": "masa:derived-from",
                "object": source_representation_id,
                "assertedBy": actor_id,
                "createdAt": created_at,
                "basis": [{"ref": receipt_id, "role": "operation"}],
                "operationRef": receipt_id,
                "extensions": {},
            }
        ],
        "policies": [
            {
                "id": policy_id,
                "type": "masa:Policy",
                "policyKind": "composite",
                "issuer": actor_id,
                "status": "active",
                "disclosure": "private",
                "rules": [
                    {
                        "id": rule_id,
                        "effect": "permission",
                        "actions": ["read", "validate", "analyze"],
                        "targets": [record_id],
                        "subjects": [actor_id],
                        "authorityBasis": _known(
                            "Private local analysis initiated through the GERM application."
                        ),
                        "constraints": {"network": "prohibited"},
                        "duties": ["Keep measured, inferred, and unavailable states distinct."],
                    }
                ],
                "review": {
                    "contact": _unknown("No external review contact is asserted.", "local_record"),
                    "route": _known("Review the source, GERM artifact, and MASA sidecar together."),
                },
                "extensions": {},
            }
        ],
        "contexts": [],
        "agentRuns": [],
        "capabilities": [],
        "integrity": _unknown(
            "The sidecar accounts for separately stored local analysis material.",
            "not_bundled",
        ),
        "history": {
            "mode": "embedded",
            "events": [
                {
                    "id": receipt_id,
                    "type": "masa:OperationReceipt",
                    "recordId": record_id,
                    "sequence": 0,
                    "operationType": "matter.analyze",
                    "effectClass": "derive",
                    "finalStatus": "completed",
                    "startedAt": created_at,
                    "endedAt": created_at,
                    "actors": [actor_id],
                    "inputs": [source_representation_id],
                    "outputs": [analysis_representation_id],
                    "tool": {
                        "state": "known",
                        "value": {
                            "id": tool_id,
                            "name": "GERM Matter Analysis",
                            "version": _known(__version__),
                            "kind": "software",
                        },
                    },
                    "parameters": method["parameters"],
                    "policyEvaluation": {
                        "action": "analyze",
                        "targets": [analysis_representation_id],
                        "policyRefs": [policy_id],
                        "result": "permitted",
                        "evaluatedAt": created_at,
                        "evaluator": actor_id,
                        "authorityRefs": [rule_id],
                        "reasons": ["The bounded local analysis completed before sidecar writing."],
                    },
                    "reversibility": "compensatable",
                    "determinism": {
                        "state": "deterministic",
                        "note": "The same accepted PCM frames and parameters produce the same descriptors.",
                    },
                    "warnings": list(analysis.get("warnings") or []),
                    "errors": [],
                    "claimRefs": [],
                    "extensions": {"germ:matterAnalysis": {"analysisId": analysis_id}},
                }
            ],
        },
        "disclosure": "private",
        "registers": ["digital-technical", "perceptual-acoulogical"],
        "scales": ["microtemporal", "spectral-stratal", "object-event"],
        "extensions": {
            "germ:matterAnalysis": {
                "analysisId": analysis_id,
                "state": analysis.get("analysisState"),
                "inferenceIsNotListening": True,
            }
        },
    }


def sidecar_path_for(metadata_path: str | Path, masa_dir: Path) -> Path:
    return masa_dir / f"{Path(metadata_path).stem}.masa.json"
