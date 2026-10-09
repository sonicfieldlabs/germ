"""Checkpoint-specific workspace operations; the existing job service owns execution."""

from fastapi import HTTPException

MODELS = {
    "sm-sfx": (
        "stable_audio_mlx",
        "sm-sfx",
        "Stable Audio 3 · Small SFX",
        0.1,
        120,
        ["generate", "variation", "inpaint", "continue"],
    ),
    "sm-music": (
        "stable_audio_mlx",
        "sm-music",
        "Stable Audio 3 · Small Music",
        0.1,
        120,
        ["generate", "variation", "inpaint", "continue"],
    ),
    "medium": (
        "stable_audio_mlx",
        "medium",
        "Stable Audio 3 · Medium",
        0.1,
        380,
        ["generate", "variation", "inpaint", "continue"],
    ),
    "synth-additive": ("synthesis", "additive", "CPU · Additive synthesis", 0.1, 30, ["generate"]),
    **{
        f"synth-{name}": ("synthesis", name, f"CPU · {name}", 0.1, 30, ["generate"])
        for name in ("chirp", "band-noise", "fm", "pulse")
    },
    "synth-string": ("synthesis", "physical-string", "CPU · Plucked string", 0.1, 30, ["generate"]),
    "ace-turbo": (
        "ace_step",
        "acestep-v15-turbo",
        "ACE-Step 1.5 · Turbo",
        10,
        30,
        ["generate", "variation", "inpaint"],
    ),
}


def descriptor(identifier):
    if identifier not in MODELS:
        raise HTTPException(422, "Unknown generation model")
    provider, model, name, minimum, maximum, operations = MODELS[identifier]
    return dict(
        id=identifier,
        provider=provider,
        model=model,
        name=name,
        min_duration=minimum,
        max_duration=maximum,
        operations=operations,
    )


def catalog(registry):
    result = []
    for identifier in MODELS:
        entry = descriptor(identifier)
        try:
            provider = registry.get(entry["provider"])
            entry.update(available=provider.is_available(), detail=provider.status_detail())
        except ValueError:
            entry.update(available=False, detail="Local deployment not provisioned")
        result.append(entry)
    return result


def admit(request):
    entry = descriptor(request.model)
    operation = request.edit if request.mode == "audio" else "generate"
    if request.mode != "audio" and request.edit != "variation":
        raise HTTPException(422, "Editing requires an audio source")
    if operation not in entry["operations"]:
        raise HTTPException(422, "Selected checkpoint does not support this operation")
    if not entry["min_duration"] <= request.duration <= entry["max_duration"]:
        raise HTTPException(
            422, f"Selected model supports {entry['min_duration']}–{entry['max_duration']} seconds"
        )
    if entry["provider"] != "synthesis" and request.synthesis:
        raise HTTPException(422, "Synthesis controls require a synthesis model")
    if entry["provider"] != "ace_step" and request.music:
        raise HTTPException(422, "Music controls require ACE-Step")
    if entry["provider"] == "ace_step" and (
        request.negative_prompt or request.cfg_scale != 1 or request.steps != 8
    ):
        raise HTTPException(
            422, "This admitted Turbo deployment uses 8 steps, no CFG and no negative prompt"
        )
    if request.edit != "inpaint" and request.inpaint_ranges:
        raise HTTPException(422, "Intervals require inpainting")
    if request.edit == "inpaint" and not request.inpaint_ranges:
        raise HTTPException(422, "Select at least one inpaint interval")
    if entry["provider"] == "ace_step":
        from server.ace.deployment import music_parameters

        try:
            music_parameters(request.music)
        except ValueError as exc:
            raise HTTPException(422, "Invalid ACE-Step music controls") from exc
        if operation == "inpaint" and len(request.inpaint_ranges) != 1:
            raise HTTPException(422, "Admitted Turbo supports one inpaint interval")
    if entry["provider"] == "synthesis":
        from server.spectral_synthesis import MODELS, admit as admit_spectral

        if entry["model"] in MODELS:
            try:
                admit_spectral(entry["model"], request.synthesis, request.duration)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
        else:
            import math

            allowed = {"frequency": (40, 4000), "gain": (0, 1)}
            if set(request.synthesis) - set(allowed) or any(
                type(v) not in (int, float)
                or not math.isfinite(v)
                or not allowed[k][0] <= v <= allowed[k][1]
                for k, v in request.synthesis.items()
            ):
                raise HTTPException(422, "Invalid synthesis controls")
    return entry
