from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


ProviderId = Literal["mock", "stable_audio_python", "stable_audio_mlx", "stability_api"]
ModeId = Literal["text-to-audio", "audio-to-audio", "inpainting", "continuation"]
SnapDivision = Literal["1/4", "1/8", "1/16", "1/32", "triplet"]
TimeModuleType = Literal[
    "colony_sequencer",
    "trigger_pads",
    "slicer",
    "melody_maker",
    "euclidean_colony",
    "clocked_looper",
    "probability_gate",
    "clock_divider",
    "humanizer",
    "polymeter",
    "incubation_timeline",
    "render_bus",
    "render_macros",
]
ControlPortKind = Literal["audio", "control", "event", "prompt", "metadata", "midi", "osc", "cv"]
ControlPortDirection = Literal["input", "output"]
ControlPortScope = Literal[
    "internal",
    "generation",
    "time",
    "library",
    "metadata",
    "hardware",
    "network",
    "export",
]
ControlLineageRole = Literal[
    "none",
    "audio-parent",
    "control-parent",
    "prompt-parent",
    "metadata-parent",
    "midi-parent",
    "osc-parent",
    "cv-parent",
    "hardware-return",
]
ControlCurve = Literal["linear", "exponential", "log", "s_curve", "stepped"]
ControlPolarity = Literal["normal", "inverted"]
ControlAnalysisFeature = Literal[
    "envelope",
    "rms",
    "transient",
    "spectral_centroid",
    "pitch",
    "chroma",
    "onset_density",
    "tempo",
    "timbre",
]
ControlCVMode = Literal["cv", "gate", "clock", "pitch"]
ControlCVRange = Literal["unipolar", "bipolar"]
CosmoauditionMode = Literal["live", "fixture"]
CosmoauditionConfidence = Literal["high", "medium", "low", "stale", "error"]
CosmoauditionEpistemicStatus = Literal[
    "measured",
    "reported",
    "derived",
    "interpreted",
    "speculative",
]
CosmoauditionTemporalCharacter = Literal[
    "event",
    "stream",
    "forecast",
    "aggregate",
    "context",
    "local",
]
CosmoauditionSignalKind = Literal["observation", "derived", "generator"]
CosmoauditionSphere = Literal[
    "cosmos",
    "atmosphere",
    "geosphere",
    "biosphere",
    "human",
    "machine",
]
CosmoauditionLayer = Literal["earth", "cloud", "city", "address", "interface", "user"]
CosmoauditionScale = Literal["linear", "log", "exp", "quantized", "categorical"]
CosmoauditionMissingData = Literal[
    "skip",
    "hold-explicitly",
    "interpolate-explicitly",
    "map-uncertainty",
    "refuse",
]
WavetableExtractionMode = Literal["simple", "cycle", "spectral", "harmonic", "texture"]
WavetableExportFormat = Literal["gwt", "wav-stack", "single-cycle", "metadata"]
WavetableGenerationMode = Literal[
    "single_cycle_tone",
    "evolving_timbre",
    "bass_oscillator",
    "glassy_metallic",
    "soft_pad_source",
    "formant_no_voice",
    "noisy_oscillator",
    "organic_reed",
]


SUPPORTED_WAVETABLE_FRAME_SIZES = {512, 1024, 2048, 4096}


def validate_json_compatible(value: Any, *, label: str = "payload") -> Any:
    """Reject non-finite, excessively deep, or non-JSON data before persistence."""
    stack: list[tuple[Any, int]] = [(value, 0)]
    nodes = 0
    text_characters = 0
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if nodes > 50_000:
            raise ValueError(f"{label} is too complex")
        if depth > 32:
            raise ValueError(f"{label} is nested too deeply")
        if item is None or isinstance(item, bool):
            continue
        if isinstance(item, int):
            if not -(2**63) <= item < 2**63:
                raise ValueError(f"{label} contains an integer outside the signed 64-bit range")
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError(f"{label} contains a non-finite number")
            continue
        if isinstance(item, str):
            try:
                item.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise ValueError(f"{label} contains invalid Unicode") from exc
            text_characters += len(item)
            if text_characters > 2_000_000:
                raise ValueError(f"{label} contains too much text")
            continue
        if isinstance(item, (list, tuple)):
            stack.extend((child, depth + 1) for child in item)
            continue
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise ValueError(f"{label} contains a non-string object key")
                if len(key) > 1_000:
                    raise ValueError(f"{label} contains an object key that is too long")
                try:
                    key.encode("utf-8")
                except UnicodeEncodeError as exc:
                    raise ValueError(f"{label} contains an invalid Unicode object key") from exc
                text_characters += len(key)
                if text_characters > 2_000_000:
                    raise ValueError(f"{label} contains too much text")
                stack.append((child, depth + 1))
            continue
        raise ValueError(f"{label} contains a non-JSON value")
    return value


class JSONRequestModel(BaseModel):
    @model_validator(mode="after")
    def validate_json_payload(self) -> "JSONRequestModel":
        validate_json_compatible(self.model_dump(mode="python"), label=self.__class__.__name__)
        return self


class LoraSpec(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    id: str | None = Field(default=None, max_length=256)
    name: str | None = Field(default=None, max_length=500)
    enabled: bool = True
    strength: float | None = Field(default=None, ge=0.0, le=10.0)
    step_range: str | None = Field(
        default=None,
        max_length=100,
        description="Optional MLX diffusion-step range, for example '2-8', '2-', or '-4'.",
    )
    tags: list[str] = Field(default_factory=list, max_length=128)
    author: str | None = Field(default=None, max_length=500)
    license: str | None = Field(default=None, max_length=500)
    source_dataset: str | None = Field(default=None, max_length=1000)
    prompt_vocabulary: list[str] = Field(default_factory=list, max_length=128)
    recommended_modules: list[str] = Field(default_factory=list, max_length=128)
    provenance_notes: str | None = Field(default=None, max_length=10_000)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("LoRA path is required")
        return cleaned

    @field_validator("step_range")
    @classmethod
    def validate_step_range(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            return None
        import re

        if not re.fullmatch(r"(?:[1-9]\d*|[1-9]\d*-[1-9]\d*|[1-9]\d*-|-[1-9]\d*)", cleaned):
            raise ValueError(
                "step_range must be a 1-based step or range such as '3', '2-8', '2-', or '-4'"
            )
        if "-" in cleaned and not cleaned.startswith("-") and not cleaned.endswith("-"):
            start, end = (int(part) for part in cleaned.split("-", 1))
            if start > end:
                raise ValueError("step_range start must be less than or equal to end")
        return cleaned


class StrainCard(JSONRequestModel):
    id: str | None = Field(default=None, max_length=256)
    name: str = Field(min_length=1, max_length=500)
    path: str | None = Field(default=None, max_length=4096)
    description: str | None = Field(default=None, max_length=10_000)
    source_dataset: str | None = Field(default=None, max_length=1000)
    license: str | None = Field(default=None, max_length=500)
    author: str | None = Field(default=None, max_length=500)
    training_settings: dict[str, Any] = Field(default_factory=dict)
    prompt_vocabulary: list[str] = Field(default_factory=list, max_length=128)
    recommended_modules: list[str] = Field(default_factory=list, max_length=128)
    example_sounds: list[str] = Field(default_factory=list, max_length=128)
    provenance_notes: str | None = Field(default=None, max_length=10_000)
    tags: list[str] = Field(default_factory=list, max_length=128)
    strength_min: float = Field(default=0.0, ge=0.0, le=10.0)
    strength_max: float = Field(default=1.5, ge=0.0, le=10.0)
    default_strength: float = Field(default=0.7, ge=0.0, le=10.0)
    enabled: bool = True
    created_at: str | None = Field(default=None, max_length=100)
    updated_at: str | None = Field(default=None, max_length=100)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("strain name is required")
        return cleaned

    @field_validator("path")
    @classmethod
    def validate_optional_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @model_validator(mode="after")
    def validate_strength_range(self) -> "StrainCard":
        if self.strength_max < self.strength_min:
            raise ValueError("strength_max must be greater than or equal to strength_min")
        if not self.strength_min <= self.default_strength <= self.strength_max:
            raise ValueError("default_strength must be inside the strength range")
        return self


class StrainRegistryResponse(BaseModel):
    strains: list[StrainCard] = Field(default_factory=list)


class StrainLoadRequest(BaseModel):
    provider: ProviderId = "stable_audio_python"
    strain_ids: list[str] = Field(default_factory=list, max_length=64)
    paths: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("strain_ids", "paths")
    @classmethod
    def validate_strain_references(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value or len(value) > 4096 for value in cleaned):
            raise ValueError("strain references must contain 1 to 4096 characters")
        return list(dict.fromkeys(cleaned))


class MicroMatterRequest(JSONRequestModel):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    source_id: str | None = Field(default=None, max_length=256)
    module: str = Field(default="microscope", min_length=1, max_length=120)
    window_ms: float = Field(default=20.0, ge=5.0, le=1000.0)
    hop_ms: float = Field(default=10.0, ge=5.0, le=1000.0)
    output_name: str | None = Field(default=None, max_length=120)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_analysis_window(self) -> "MicroMatterRequest":
        if self.window_ms > self.hop_ms * 4:
            raise ValueError("window_ms cannot exceed four times hop_ms")
        return self


class MicroMatterProfileResult(BaseModel):
    id: str
    status: Literal["done", "error"]
    input_audio_path: str
    profile_file: str | None = None
    metadata_file: str | None = None
    sample_rate: int | None = None
    duration: float | None = None
    module: str = "microscope"
    descriptors: dict[str, Any] = Field(default_factory=dict)
    module_suggestions: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None


class MatterAnalysisRequest(JSONRequestModel):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    source_id: str | None = Field(default=None, max_length=256)
    fft_size: Literal[512, 1024, 2048, 4096] = 2048
    max_frames: int = Field(default=64, ge=1, le=128)
    output_name: str | None = Field(default=None, max_length=120)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @field_validator("lineage")
    @classmethod
    def validate_lineage_parents(cls, value: dict[str, Any]) -> dict[str, Any]:
        if "parents" not in value:
            return value
        parents = value["parents"]
        if not isinstance(parents, list):
            raise ValueError("lineage.parents must be a list")
        if len(parents) > 128:
            raise ValueError("lineage.parents cannot contain more than 128 values")
        cleaned: list[str] = []
        for parent in parents:
            if isinstance(parent, bool) or not isinstance(parent, (str, int)):
                raise ValueError("lineage.parents values must be strings or integers")
            identifier = str(parent).strip()
            if not identifier or len(identifier) > 4_096:
                raise ValueError("lineage parent identifiers must contain 1 to 4096 characters")
            if identifier not in cleaned:
                cleaned.append(identifier)
        return {**value, "parents": cleaned}


class MatterAnalysisResult(BaseModel):
    id: str
    status: Literal["done", "error"]
    input_audio_path: str
    profile_file: str | None = None
    metadata_file: str | None = None
    masa_sidecar_file: str | None = None
    sample_rate: int | None = None
    channels: int | None = None
    duration: float | None = None
    analysis_state: str | None = None
    analysis: dict[str, Any] = Field(default_factory=dict)
    masa: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class CosmoauditionSignal(JSONRequestModel):
    id: str = Field(min_length=1, max_length=256)
    label: str = Field(default="Observation", min_length=1, max_length=500)
    layer: CosmoauditionLayer = "earth"
    unit: str = Field(default="unitless", min_length=1, max_length=120)
    value: float | None = None
    normalized: float | None = Field(default=None, ge=0.0, le=1.0)
    timestamp: str | None = Field(default=None, max_length=100)
    sourceId: str | None = Field(default=None, max_length=256)
    sourceUrl: str | None = Field(default=None, max_length=2_000)
    sphere: CosmoauditionSphere | None = None
    epistemicStatus: CosmoauditionEpistemicStatus | None = None
    temporalCharacter: CosmoauditionTemporalCharacter | None = None
    signalKind: CosmoauditionSignalKind | None = None
    eventKey: str | None = Field(default=None, max_length=500)
    confidence: CosmoauditionConfidence = "medium"
    staleAfterSeconds: float | None = Field(default=None, ge=0.0, le=31_536_000.0)
    error: str | None = Field(default=None, max_length=2_000)
    notes: str | None = Field(default=None, max_length=10_000)


class CosmoauditionCategory(JSONRequestModel):
    value: float
    output: float
    label: str | None = Field(default=None, max_length=500)


class CosmoauditionMapping(JSONRequestModel):
    id: str = Field(min_length=1, max_length=256)
    signalId: str = Field(min_length=1, max_length=256)
    layer: CosmoauditionLayer = "earth"
    target: str = Field(min_length=1, max_length=256)
    scale: CosmoauditionScale = "linear"
    inputRange: tuple[float, float] | None = None
    categories: list[CosmoauditionCategory] = Field(default_factory=list, max_length=128)
    outputRange: tuple[float, float] = (0.0, 1.0)
    smoothingMs: float = Field(default=80.0, ge=0.0, le=60_000.0)
    missingData: CosmoauditionMissingData = "skip"
    description: str = Field(default="Authored observation mapping.", max_length=10_000)
    epistemicNote: str = Field(
        default=(
            "This is an authored control relation, not the source's voice or an identity claim."
        ),
        min_length=1,
        max_length=10_000,
    )

    @model_validator(mode="after")
    def validate_mapping_ranges(self) -> "CosmoauditionMapping":
        if self.outputRange[0] == self.outputRange[1]:
            raise ValueError("outputRange must describe a non-zero range")
        if self.scale == "categorical":
            if not self.categories:
                raise ValueError("categorical mappings require categories")
            if len({entry.value for entry in self.categories}) != len(self.categories):
                raise ValueError("categorical mapping values must be unique")
        else:
            if self.inputRange is None or self.inputRange[0] >= self.inputRange[1]:
                raise ValueError("non-categorical mappings require an ascending inputRange")
            if self.scale == "log" and self.inputRange[0] <= 0:
                raise ValueError("log mappings require a positive inputRange")
        if self.scale == "quantized" and any(
            not float(value).is_integer() for value in self.outputRange
        ):
            raise ValueError("quantized mappings require integer output bounds")
        return self


class CosmoauditionMapRequest(JSONRequestModel):
    mapping: CosmoauditionMapping
    signal: CosmoauditionSignal | None = None
    previousOutput: float | None = None
    amount: float = Field(default=1.0, ge=0.0, le=1.0)
    enabled: bool = True
    missingData: CosmoauditionMissingData | None = None


class CosmoauditionArchiveRequest(JSONRequestModel):
    label: str = Field(default="Observation archive", min_length=1, max_length=120)
    snapshot: dict[str, Any] = Field(default_factory=dict)
    module: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=10_000)


class MicroBiomeSaveRequest(JSONRequestModel):
    name: str = Field(min_length=1, max_length=120)
    state: dict[str, Any] = Field(default_factory=dict)


class MicroBiomeSummary(BaseModel):
    id: str
    name: str
    biome_file: str
    created_at: str | None = None
    updated_at: str | None = None
    germ_count: int = 0
    module_count: int = 0


class MicroBiomeResult(BaseModel):
    status: Literal["done", "deleted"]
    biome: MicroBiomeSummary | None = None
    state: dict[str, Any] = Field(default_factory=dict)


class SessionSaveRequest(JSONRequestModel):
    name: str = Field(min_length=1, max_length=120)
    graph: dict[str, Any] = Field(default_factory=dict)


class SessionCurrentRequest(JSONRequestModel):
    graph: dict[str, Any] = Field(default_factory=dict)
    client_id: str | None = Field(default=None, max_length=64)


class SessionSummary(BaseModel):
    id: str
    name: str
    session_file: str
    created_at: str | None = None
    updated_at: str | None = None
    node_count: int = 0
    edge_count: int = 0
    asset_count: int = 0
    client_id: str | None = None


class SessionResult(BaseModel):
    status: Literal["done", "deleted", "empty"]
    session: SessionSummary | None = None
    graph: dict[str, Any] = Field(default_factory=dict)


class WavetableConvertRequest(JSONRequestModel):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    name: str | None = Field(default=None, max_length=500)
    frame_size: int = 2048
    frame_count: int = Field(default=128, ge=1, le=512)
    root_note: str = Field(default="C3", min_length=1, max_length=16)
    extraction_mode: WavetableExtractionMode = "simple"
    output_name: str | None = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=lambda: ["wavetable", "germ"], max_length=128)
    operation_params: dict[str, Any] = Field(default_factory=dict)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @field_validator("frame_size")
    @classmethod
    def validate_frame_size(cls, value: int) -> int:
        if value not in SUPPORTED_WAVETABLE_FRAME_SIZES:
            raise ValueError("frame_size must be one of 512, 1024, 2048, or 4096")
        return value

    @field_validator("extraction_mode")
    @classmethod
    def validate_extraction_mode(cls, value: WavetableExtractionMode) -> WavetableExtractionMode:
        if value != "simple":
            raise ValueError("only simple wavetable extraction is implemented in this phase")
        return value


class WavetableRenderRequest(JSONRequestModel):
    wavetable_id: str = Field(min_length=1, max_length=256)
    duration: float = Field(default=2.0, gt=0.0, le=60.0)
    root_note: str | None = Field(default=None, max_length=16)
    note: str = Field(default="C3", min_length=1, max_length=16)
    scan_start: float = Field(default=0.0, ge=0.0, le=1.0)
    scan_end: float = Field(default=1.0, ge=0.0, le=1.0)
    gain: float = Field(default=0.7, ge=0.0, le=2.0)
    output_name: str | None = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=lambda: ["wavetable-render"], max_length=128)
    lineage: dict[str, Any] = Field(default_factory=dict)


class WavetableImportRequest(JSONRequestModel):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    frame_size: int = 2048
    name: str = Field(default="imported table", min_length=1, max_length=500)
    root_note: str = Field(default="C3", min_length=1, max_length=16)
    output_name: str | None = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=lambda: ["wavetable", "imported"], max_length=128)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @field_validator("frame_size")
    @classmethod
    def validate_frame_size(cls, value: int) -> int:
        if value not in SUPPORTED_WAVETABLE_FRAME_SIZES:
            raise ValueError("frame_size must be one of 512, 1024, 2048, or 4096")
        return value


class WavetablePromptContract(BaseModel):
    user_prompt: str
    generation_mode: WavetableGenerationMode
    prompt: str
    negative_prompt: str


class WavetablePromptRequest(JSONRequestModel):
    provider: ProviderId = "mock"
    model: str = Field(default="mock-sine", min_length=1, max_length=500)
    prompt: str = Field(min_length=1, max_length=10_000)
    negative_prompt: str = Field(default="", max_length=10_000)
    duration: float = Field(default=2.0, gt=0.0, le=380.0)
    root_note: str = Field(default="C3", min_length=1, max_length=16)
    generation_mode: WavetableGenerationMode = "single_cycle_tone"
    extraction_mode: WavetableExtractionMode = "simple"
    frame_count: int = Field(default=64, ge=1, le=512)
    frame_size: int = 2048
    output_name: str | None = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=lambda: ["wavetable", "germ"], max_length=128)
    variation_count: int = Field(default=1, ge=1, le=16)
    modulators: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @field_validator("frame_size")
    @classmethod
    def validate_frame_size(cls, value: int) -> int:
        if value not in SUPPORTED_WAVETABLE_FRAME_SIZES:
            raise ValueError("frame_size must be one of 512, 1024, 2048, or 4096")
        return value

    @field_validator("extraction_mode")
    @classmethod
    def validate_extraction_mode(cls, value: WavetableExtractionMode) -> WavetableExtractionMode:
        if value != "simple":
            raise ValueError("only simple wavetable extraction is implemented in this phase")
        return value


class WavetableMutationRequest(JSONRequestModel):
    wavetable_id: str = Field(min_length=1, max_length=256)
    provider: ProviderId = "mock"
    model: str = Field(default="mock-sine", min_length=1, max_length=500)
    prompt: str = Field(min_length=1, max_length=10_000)
    negative_prompt: str = Field(default="", max_length=10_000)
    init_noise_level: float = Field(default=0.42, ge=0.0, le=1.0)
    render_duration: float = Field(default=2.0, gt=0.0, le=60.0)
    root_note: str = Field(default="C3", min_length=1, max_length=16)
    extraction_mode: WavetableExtractionMode = "simple"
    frame_count: int = Field(default=64, ge=1, le=512)
    frame_size: int = 2048
    variation_count: int = Field(default=1, ge=1, le=16)
    modulators: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @field_validator("frame_size")
    @classmethod
    def validate_frame_size(cls, value: int) -> int:
        if value not in SUPPORTED_WAVETABLE_FRAME_SIZES:
            raise ValueError("frame_size must be one of 512, 1024, 2048, or 4096")
        return value

    @field_validator("extraction_mode")
    @classmethod
    def validate_extraction_mode(cls, value: WavetableExtractionMode) -> WavetableExtractionMode:
        if value != "simple":
            raise ValueError("only simple wavetable extraction is implemented in this phase")
        return value


class WavetableSummary(BaseModel):
    id: str
    name: str
    frame_size: int
    frame_count: int
    sample_rate: int
    root_note: str
    root_frequency: float
    data_path: str
    metadata_path: str
    source_audio_path: str | None = None
    source_prompt: str | None = None
    runtime: str | None = None
    operation: str | None = None
    tags: list[str] = Field(default_factory=list)
    descriptors: dict[str, Any] = Field(default_factory=dict)
    table_classification: str | None = None
    warnings: list[str] = Field(default_factory=list)
    parents: list[str] = Field(default_factory=list)
    children: list[str] = Field(default_factory=list)
    created_at: str | None = None


class WavetableDetail(WavetableSummary):
    type: str = "germ_wavetable"
    source_metadata_path: str | None = None
    negative_prompt: str | None = None
    generation_model: str | None = None
    extraction_mode: str = "simple"
    operation_params: dict[str, Any] = Field(default_factory=dict)
    lineage: dict[str, Any] = Field(default_factory=dict)


class WavetableOperationResult(BaseModel):
    status: Literal["done", "error"]
    wavetable: WavetableDetail | None = None
    wavetables: list[WavetableDetail] = Field(default_factory=list)
    audio_files: list[str] = Field(default_factory=list)
    metadata_files: list[str] = Field(default_factory=list)
    source_audio_files: list[str] = Field(default_factory=list)
    source_metadata_files: list[str] = Field(default_factory=list)
    error: str | None = None


class BaseGenerationRequest(JSONRequestModel):
    provider: ProviderId = "mock"
    model: str = Field(default="mock-sine", min_length=1, max_length=500)
    prompt: str = Field(default="", max_length=10_000)
    negative_prompt: str = Field(default="", max_length=10_000)
    base_prompt: str | None = Field(default=None, max_length=10_000)
    modulated_prompt: str | None = Field(default=None, max_length=10_000)
    base_negative_prompt: str | None = Field(default=None, max_length=10_000)
    modulated_negative_prompt: str | None = Field(default=None, max_length=10_000)
    modulators: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    semantic_layers: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    semantic_effects: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    generation_context: dict[str, Any] = Field(default_factory=dict)
    prompt_weight: float | None = Field(default=None, allow_inf_nan=False)
    negative_prompt_weight: float | None = Field(default=None, allow_inf_nan=False)
    seed_drift: float | None = Field(default=None, allow_inf_nan=False)
    batch_spread: float | None = Field(default=None, allow_inf_nan=False)
    inpaint_density: float | None = Field(default=None, allow_inf_nan=False)
    mask_feather: float | None = Field(default=None, allow_inf_nan=False)
    continuation_divergence: float | None = Field(default=None, allow_inf_nan=False)
    brightness_language: float | None = Field(default=None, allow_inf_nan=False)
    lora_strength: float | None = Field(default=None, allow_inf_nan=False)
    region_roles: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    preserve_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    accent_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    forbidden_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    seed_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    texture_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    variation_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    bridge_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    silence_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=512)
    genetic_identities: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    generation_sequences: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    duration: float = Field(default=4.0, gt=0.0, le=380.0)
    steps: int = Field(default=8, ge=1, le=250)
    cfg_scale: float = Field(default=1.0, ge=0.0, le=25.0)
    seed: int = Field(default=-1, ge=-1, le=4_294_967_294)
    batch_size: int = Field(default=1, ge=1, le=16)
    lora: list[LoraSpec] = Field(default_factory=list, max_length=32)
    output_name: str | None = Field(default=None, max_length=120)
    culture_id: str | None = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=128)
    notes: str | None = Field(default=None, max_length=10_000)
    ratings: dict[str, Any] = Field(default_factory=dict)
    waveform_preview: str | None = Field(default=None, max_length=4096)
    control_routes: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    control_snapshots: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    control_sources: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    source: dict[str, Any] = Field(default_factory=dict)
    latents: dict[str, Any] = Field(default_factory=dict)
    latent_file: str | None = Field(default=None, max_length=4096)
    latent_fingerprint: str | None = Field(default=None, max_length=500)
    chunked_decode: bool = True
    lineage: dict[str, Any] = Field(default_factory=dict)
    remember_to_akousmata: bool = False
    parent_akousma_ids: list[str] = Field(default_factory=list, max_length=64)
    akousma_relations: list[dict[str, Any]] = Field(default_factory=list, max_length=128)
    listening_context: dict[str, Any] = Field(default_factory=dict)
    covenant: dict[str, Any] = Field(default_factory=dict)
    akousma_summary: str | None = Field(default=None, max_length=500)
    job_id: str | None = Field(default=None, exclude=True)

    @field_validator("parent_akousma_ids")
    @classmethod
    def validate_parent_akousma_ids(cls, values: list[str]) -> list[str]:
        cleaned = [str(value).strip() for value in values if str(value).strip()]
        return list(dict.fromkeys(cleaned))

    @model_validator(mode="after")
    def resolve_effective_prompts(self) -> "BaseGenerationRequest":
        """Keep the user's neutral prompt and make the effective modulated text explicit.

        Providers consume ``prompt`` and ``negative_prompt``.  The dashboard also
        sends base/modulated variants, so resolve those fields here once instead
        of letting an adapter accidentally generate from the stale base text.
        """
        raw_prompt = self.prompt.strip()
        raw_negative = self.negative_prompt.strip()
        base_prompt = self.base_prompt.strip() if self.base_prompt is not None else raw_prompt
        base_negative = (
            self.base_negative_prompt.strip()
            if self.base_negative_prompt is not None
            else raw_negative
        )
        effective_prompt = (
            self.modulated_prompt.strip() if self.modulated_prompt is not None else raw_prompt
        )
        effective_negative = (
            self.modulated_negative_prompt.strip()
            if self.modulated_negative_prompt is not None
            else raw_negative
        )
        self.base_prompt = base_prompt
        self.modulated_prompt = effective_prompt
        self.base_negative_prompt = base_negative
        self.modulated_negative_prompt = effective_negative
        self.prompt = effective_prompt
        self.negative_prompt = effective_negative
        if "prompt_contract" not in self.generation_context:
            self.generation_context = {
                **self.generation_context,
                "prompt_contract": {
                    "contract": "germ.prompt/v0.1",
                    "neutral": True,
                    "base_prompt": base_prompt,
                    "effective_prompt": effective_prompt,
                    "base_negative_prompt": base_negative,
                    "effective_negative_prompt": effective_negative,
                    "modulated": self.modulated_prompt != base_prompt
                    or self.modulated_negative_prompt != base_negative,
                },
            }
        return self


class GenerateRequest(BaseGenerationRequest):
    pass


class AudioToAudioRequest(BaseGenerationRequest):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    init_noise_level: float = Field(default=0.45, ge=0.0, le=1.0)


class InpaintRequest(BaseGenerationRequest):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    inpaint_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=64)

    @field_validator("inpaint_ranges")
    @classmethod
    def validate_ranges(cls, ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if not ranges:
            raise ValueError("at least one inpaint range is required")
        for start, end in ranges:
            if start < 0 or end < 0:
                raise ValueError("inpaint ranges must be non-negative")
            if end <= start:
                raise ValueError("each inpaint range end must be greater than start")
        return ranges

    @model_validator(mode="after")
    def validate_ranges_within_duration(self) -> "InpaintRequest":
        if any(end > self.duration for _, end in self.inpaint_ranges):
            raise ValueError("inpaint range end cannot exceed duration")
        return self


class ContinueRequest(BaseGenerationRequest):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    source_duration: float = Field(gt=0.0)
    target_duration: float = Field(gt=0.0, le=380.0)

    @field_validator("target_duration")
    @classmethod
    def validate_target_duration(cls, target_duration: float, info: Any) -> float:
        source_duration = info.data.get("source_duration") if hasattr(info, "data") else None
        if source_duration is not None and target_duration <= source_duration:
            raise ValueError("target_duration must be greater than source_duration")
        return target_duration


class LoadModelRequest(BaseModel):
    provider: ProviderId
    model: str = Field(min_length=1, max_length=500)
    device: str = Field(default="auto", min_length=1, max_length=100)


class LoadModelResponse(BaseModel):
    provider: str
    model: str
    device: str
    status: str
    detail: str | None = None


class LoraLoadRequest(BaseModel):
    provider: ProviderId = "stable_audio_python"
    paths: list[str] = Field(min_length=1, max_length=32)

    @field_validator("paths")
    @classmethod
    def validate_lora_paths(cls, paths: list[str]) -> list[str]:
        cleaned = [path.strip() for path in paths]
        if any(not path or len(path) > 4096 for path in cleaned):
            raise ValueError("LoRA paths must contain 1 to 4096 characters")
        return list(dict.fromkeys(cleaned))


class LoraStrengthRequest(BaseModel):
    provider: ProviderId = "stable_audio_python"
    strength: float = Field(ge=0.0, le=10.0)
    lora_index: int | None = Field(default=None, ge=0)


class ProviderStatus(BaseModel):
    id: str
    available: bool
    models: list[str]
    loaded_model: str | None = None
    device: str = "unknown"
    detail: str | None = None


class ModelsResponse(BaseModel):
    providers: list[ProviderStatus]


class HealthResponse(BaseModel):
    status: str
    server: str
    active_provider: str
    device: str
    models_loaded: list[str]
    output_dir: str


class GenerationResult(BaseModel):
    job_id: str
    status: Literal["queued", "running", "done", "error", "cancelled"]
    audio_files: list[str] = Field(default_factory=list)
    metadata_files: list[str] = Field(default_factory=list)
    seed: int | None = None
    duration: float | None = None
    sample_rate: int | None = None
    error: str | None = None
    provider: str | None = None
    model: str | None = None
    mode: str | None = None


class TimeClock(BaseModel):
    enabled: bool = True
    bpm: float = Field(default=120.0, ge=20.0, le=300.0)
    beats_per_bar: int = Field(default=4, ge=1, le=16)
    beat_unit: int = Field(default=4, ge=1, le=32)
    bars: int = Field(default=4, ge=1, le=128)
    ppq: int = Field(default=960, ge=24, le=3840)
    # Stable Audio 3 SAME latents are fixed at 44.1 kHz stereo, so time render
    # locks the clock sample rate to 44100 to match the encoder/decoder.
    sample_rate: Literal[44100] = 44100
    snap_division: SnapDivision = "1/16"
    swing: float = Field(default=0.0, ge=0.0, le=1.0)
    loop_start_tick: int = Field(default=0, ge=0)
    loop_end_tick: int | None = Field(default=None, ge=1)

    @field_validator("beat_unit")
    @classmethod
    def validate_beat_unit(cls, beat_unit: int) -> int:
        if beat_unit not in {1, 2, 4, 8, 16, 32}:
            raise ValueError("beat_unit must be a common note denominator")
        return beat_unit

    @model_validator(mode="after")
    def validate_loop_range(self) -> "TimeClock":
        loop_end = self.resolved_loop_end_tick()
        if loop_end > self.total_ticks():
            raise ValueError("loop_end_tick cannot exceed the clock length")
        if self.loop_start_tick >= loop_end:
            raise ValueError("loop_start_tick must be less than loop_end_tick")
        return self

    def seconds_per_beat(self) -> float:
        return 60.0 / self.bpm

    def total_beats(self) -> float:
        return float(self.bars * self.beats_per_bar)

    def loop_seconds(self) -> float:
        loop_ticks = self.resolved_loop_end_tick() - self.loop_start_tick
        return (loop_ticks / self.ppq) * self.seconds_per_beat()

    def loop_samples(self) -> int:
        return round(self.loop_seconds() * self.sample_rate)

    def ticks_per_bar(self) -> int:
        return self.beats_per_bar * self.ppq

    def total_ticks(self) -> int:
        return self.bars * self.ticks_per_bar()

    def resolved_loop_end_tick(self) -> int:
        return self.loop_end_tick or self.total_ticks()


class TimeRenderSource(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    label: str | None = Field(default=None, max_length=500)
    gain: float = Field(default=1.0, ge=0.0, le=2.0)
    pan: float = Field(default=0.0, ge=-1.0, le=1.0)


class TimeRenderEvent(BaseModel):
    tick: int = Field(ge=0)
    source_id: str = Field(min_length=1, max_length=128)
    lane: int | None = Field(default=None, ge=0)
    pad: int | None = Field(default=None, ge=0)
    velocity: float = Field(default=1.0, ge=0.0, le=2.0)
    gain: float = Field(default=1.0, ge=0.0, le=2.0)
    pan: float = Field(default=0.0, ge=-1.0, le=1.0)
    pitch_semitones: float = Field(default=0.0, ge=-48.0, le=48.0)
    source_start_sec: float | None = Field(default=None, ge=0.0)
    source_end_sec: float | None = Field(default=None, gt=0.0)
    fade_in_ms: float = Field(default=0.0, ge=0.0, le=5000.0)
    fade_out_ms: float = Field(default=5.0, ge=0.0, le=5000.0)
    variation: int | None = Field(default=None, ge=0)
    duration_ticks: int | None = Field(default=None, ge=1)
    reverse: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_source_window(self) -> "TimeRenderEvent":
        if self.source_start_sec is not None and self.source_end_sec is not None:
            if self.source_end_sec <= self.source_start_sec:
                raise ValueError("source_end_sec must be greater than source_start_sec")
        return self


class TimeRenderRequest(JSONRequestModel):
    module_type: TimeModuleType
    module_id: str = Field(min_length=1, max_length=128)
    clock: TimeClock = Field(default_factory=TimeClock)
    sources: list[TimeRenderSource] = Field(min_length=1, max_length=64)
    events: list[TimeRenderEvent] = Field(min_length=1, max_length=4096)
    output_name: str | None = Field(default=None, max_length=120)
    culture_id: str | None = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=128)
    notes: str | None = Field(default=None, max_length=10_000)
    prompt: str = Field(default="", max_length=10_000)
    negative_prompt: str = Field(default="", max_length=10_000)
    duration: float | None = Field(default=None, gt=0.0, le=380.0)
    seed: int = -1
    normalize: bool = True
    lora: list[LoraSpec] = Field(default_factory=list, max_length=32)
    source: dict[str, Any] = Field(default_factory=dict)
    latents: dict[str, Any] = Field(default_factory=dict)
    waveform_preview: str | None = Field(default=None, max_length=4096)
    lineage: dict[str, Any] = Field(default_factory=dict)
    modulators: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    control_routes: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    control_snapshots: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    control_sources: list[dict[str, Any]] = Field(default_factory=list, max_length=512)
    job_id: str | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def validate_unique_source_ids(self) -> "TimeRenderRequest":
        ids = [source.id for source in self.sources]
        if len(set(ids)) != len(ids):
            raise ValueError("time render sources must have unique ids")
        missing_ids = sorted({event.source_id for event in self.events} - set(ids))
        if missing_ids:
            raise ValueError(
                f"time render event references missing source: {', '.join(missing_ids)}"
            )
        loop_start = self.clock.loop_start_tick
        loop_end = self.clock.resolved_loop_end_tick()
        if any(not loop_start <= event.tick < loop_end for event in self.events):
            raise ValueError("time render event ticks must fall inside the clock loop")
        if self.duration is not None:
            tolerance = 1.0 / self.clock.sample_rate
            if abs(self.duration - self.clock.loop_seconds()) > tolerance:
                raise ValueError("duration must match the clock loop duration")
        return self


ListenerProvider = Literal["neutral", "mock", "local", "oida", "api"]
ListenerTask = Literal["prompt_enhance", "negative_prompt", "curate", "repair"]


class ListenerEnhanceRequest(JSONRequestModel):
    provider: ListenerProvider = "neutral"
    task: ListenerTask = "prompt_enhance"
    prompt: str = Field(default="", max_length=10_000)
    negative_prompt: str = Field(default="", max_length=10_000)
    model: str = Field(default="neutral-compiler", min_length=1, max_length=500)
    context: dict[str, Any] = Field(default_factory=dict)


class ListenerEnhanceResult(BaseModel):
    provider: ListenerProvider
    model: str
    task: ListenerTask
    prompt: str
    enhanced_prompt: str
    negative_prompt: str
    suggestions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    repair_proposals: list[dict[str, Any]] = Field(default_factory=list)


class ListenerScoreRequest(JSONRequestModel):
    provider: ListenerProvider = "neutral"
    prompt: str = Field(default="", max_length=10_000)
    audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    model: str = Field(default="local-signal-check", min_length=1, max_length=500)
    context: dict[str, Any] = Field(default_factory=dict)


class ListenerScoreResult(BaseModel):
    provider: ListenerProvider
    model: str
    prompt: str
    audio_path: str
    score: float = Field(ge=0.0, le=1.0)
    rating: Literal["excellent", "good", "fair", "weak"]
    tags: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)
    repair_proposals: list[dict[str, Any]] = Field(default_factory=list)
    features: dict[str, Any] = Field(default_factory=dict)


class ListenerRelistenRequest(JSONRequestModel):
    audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    prompt: str = Field(default="", max_length=10_000)
    negative_prompt: str = Field(default="", max_length=10_000)
    route_preset: str = Field(default="generative", min_length=1, max_length=80)
    intent: Literal["transform", "variation", "counterpoint", "sonification"] = "variation"
    privacy_mode: Literal["session", "incognito"] = "session"
    remember: bool = False
    context: dict[str, Any] = Field(default_factory=dict)


class ListenerRelistenResult(BaseModel):
    provider: Literal["oida"] = "oida"
    contract: str = "germ.oida-relisten/v0.1"
    audio_path: str
    metadata_path: str | None = None
    route_preset: str
    relisten_mode: Literal["generation_relisten", "gateway_listen"] = "gateway_listen"
    source_generation_id: str | None = None
    listening_event_id: str
    generation_id: str
    prompt: str
    negative_prompt: str
    source_summary: str = ""
    listening_result: dict[str, Any] = Field(default_factory=dict)
    route_comparison: dict[str, Any] = Field(default_factory=dict)
    remembered: bool = False
    akousma_id: str | None = None
    warnings: list[str] = Field(default_factory=list)


class JobStatus(BaseModel):
    job_id: str
    status: str
    mode: str
    provider: str | None = None
    model: str | None = None
    request: dict[str, Any] = Field(default_factory=dict)
    audio_files: list[str] = Field(default_factory=list)
    metadata_files: list[str] = Field(default_factory=list)
    error: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class JobSubmitRequest(BaseModel):
    mode: ModeId
    request: dict[str, Any]


class JobSubmitResponse(BaseModel):
    job_id: str
    status: str
    mode: ModeId
    provider: str | None = None
    model: str | None = None
    status_url: str
    events_url: str


class ControlTransform(BaseModel):
    amount: float = Field(default=1.0, ge=0.0, le=4.0, allow_inf_nan=False)
    polarity: ControlPolarity = "normal"
    curve: ControlCurve = "linear"
    min: float | None = Field(default=None, allow_inf_nan=False)
    max: float | None = Field(default=None, allow_inf_nan=False)
    smoothing_ms: float = Field(default=0.0, ge=0.0, le=60000.0, allow_inf_nan=False)
    slew_ms: float = Field(default=0.0, ge=0.0, le=60000.0, allow_inf_nan=False)
    quantize_steps: int | None = Field(default=None, ge=2, le=4096)
    probability: float = Field(default=1.0, ge=0.0, le=1.0, allow_inf_nan=False)
    clock_sync: bool = False
    division: SnapDivision | None = None
    clamp_min: float | None = Field(default=None, allow_inf_nan=False)
    clamp_max: float | None = Field(default=None, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_ranges(self) -> "ControlTransform":
        if self.min is not None and self.max is not None and self.max < self.min:
            raise ValueError("max must be greater than or equal to min")
        if (
            self.clamp_min is not None
            and self.clamp_max is not None
            and self.clamp_max < self.clamp_min
        ):
            raise ValueError("clamp_max must be greater than or equal to clamp_min")
        return self


class ControlPort(BaseModel):
    id: str
    label: str
    kind: ControlPortKind
    direction: ControlPortDirection
    scope: ControlPortScope = "internal"
    unit: str | None = None
    min: float | None = None
    max: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ControlRoute(JSONRequestModel):
    id: str | None = Field(default=None, max_length=256)
    label: str | None = Field(default=None, max_length=500)
    source_port_id: str = Field(min_length=1, max_length=256)
    target_port_id: str = Field(min_length=1, max_length=256)
    source_kind: ControlPortKind
    target_kind: ControlPortKind
    enabled: bool = True
    transform: ControlTransform = Field(default_factory=ControlTransform)
    lineage_role: ControlLineageRole = "control-parent"
    created_at: str | None = Field(default=None, max_length=100)
    updated_at: str | None = Field(default=None, max_length=100)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("source_port_id", "target_port_id")
    @classmethod
    def validate_port_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("port id cannot be empty")
        return value


class ControlEvent(JSONRequestModel):
    id: str | None = Field(default=None, max_length=256)
    route_id: str | None = Field(default=None, max_length=256)
    port_id: str | None = Field(default=None, max_length=256)
    kind: ControlPortKind = "event"
    source: str = Field(default="dashboard", min_length=1, max_length=256)
    value: Any = None
    timestamp: str | None = Field(default=None, max_length=100)
    tick: int | None = Field(default=None, ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ControlSnapshot(BaseModel):
    id: str
    captured_at: str
    routes: list[ControlRoute] = Field(default_factory=list)
    events: list[ControlEvent] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ControlPortsResponse(BaseModel):
    ports: list[ControlPort]


class ControlRoutesResponse(BaseModel):
    routes: list[ControlRoute]


class ControlEventsResponse(BaseModel):
    events: list[ControlEvent]


class ControlRouteEnableRequest(BaseModel):
    enabled: bool


class ControlAudioAnalysisRequest(JSONRequestModel):
    input_audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    source_id: str | None = Field(default=None, max_length=256)
    features: list[ControlAnalysisFeature] = Field(
        default_factory=lambda: ["envelope", "rms", "transient", "spectral_centroid"]
    )
    window_ms: float = Field(default=40.0, ge=5.0, le=1000.0)
    hop_ms: float = Field(default=20.0, ge=5.0, le=1000.0)
    smooth: float = Field(default=0.15, ge=0.0, le=1.0)
    normalize: bool = True
    output_name: str | None = Field(default=None, max_length=120)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @field_validator("features")
    @classmethod
    def validate_features(cls, value: list[ControlAnalysisFeature]) -> list[ControlAnalysisFeature]:
        if not value:
            raise ValueError("at least one feature is required")
        unique = list(dict.fromkeys(value))
        return unique

    @model_validator(mode="after")
    def validate_analysis_window(self) -> "ControlAudioAnalysisRequest":
        if self.window_ms > self.hop_ms * 4:
            raise ValueError("window_ms cannot exceed four times hop_ms")
        return self


class ControlFeatureSummary(BaseModel):
    feature: ControlAnalysisFeature
    point_count: int
    min: float
    max: float
    mean: float
    peak_time_sec: float | None = None
    event_count: int = 0


class ControlAnalysisResult(BaseModel):
    id: str
    status: Literal["done", "error"]
    input_audio_path: str
    control_files: list[str] = Field(default_factory=list)
    metadata_file: str | None = None
    sample_rate: int | None = None
    duration: float | None = None
    features: list[ControlFeatureSummary] = Field(default_factory=list)
    route_suggestions: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None


class ControlPoint(BaseModel):
    t: float = Field(ge=0.0)
    value: float = Field(ge=-1.0, le=1.0)


class ControlCVRenderRequest(JSONRequestModel):
    input_control_path: str | None = Field(default=None, max_length=4096)
    feature: ControlAnalysisFeature | None = None
    points: list[ControlPoint] = Field(default_factory=list, max_length=20000)
    duration: float = Field(default=4.0, gt=0.0, le=380.0)
    sample_rate: Literal[44100] = 44100
    output_name: str | None = Field(default=None, max_length=120)
    mode: ControlCVMode = "cv"
    range: ControlCVRange = "unipolar"
    scale: float = Field(default=1.0, ge=0.0, le=1.0)
    offset: float = Field(default=0.0, ge=-1.0, le=1.0)
    clamp_min: float = Field(default=-1.0, ge=-1.0, le=1.0)
    clamp_max: float = Field(default=1.0, ge=-1.0, le=1.0)
    slew_ms: float = Field(default=0.0, ge=0.0, le=60000.0)
    gate_value: float = Field(default=1.0, ge=0.0, le=1.0)
    lineage: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_source(self) -> "ControlCVRenderRequest":
        if not self.input_control_path and not self.points:
            raise ValueError("provide input_control_path or points")
        if self.clamp_max < self.clamp_min:
            raise ValueError("clamp_max must be greater than or equal to clamp_min")
        return self


class ControlCVRenderResult(BaseModel):
    status: Literal["done", "error"]
    audio_file: str | None = None
    metadata_file: str | None = None
    duration: float | None = None
    sample_rate: int | None = None
    mode: ControlCVMode | None = None
    cv_safe: bool = True
    hardware_output: bool = False
    error: str | None = None


class ControlBridgeStatus(BaseModel):
    osc_udp_send: bool = True
    osc_udp_receive: bool = False
    midi_browser: bool = True
    midi_native: bool = False
    cv_hardware_output: bool = False
    cv_profiles: int = 0
    armed_cv_outputs: int = 0
    detail: dict[str, Any] = Field(default_factory=dict)


class ControlOSCMessage(JSONRequestModel):
    host: str = Field(default="127.0.0.1", min_length=1, max_length=253)
    port: int = Field(default=9000, ge=1, le=65535)
    address: str = Field(default="/germ/value", min_length=1, max_length=256)
    values: list[float | int | str] = Field(default_factory=list, max_length=32)
    rate_limit_hz: float = Field(default=60.0, gt=0.0, le=1000.0)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("address")
    @classmethod
    def validate_osc_address(cls, value: str) -> str:
        value = value.strip()
        if not value.startswith("/") or any(character.isspace() for character in value):
            raise ValueError("OSC address must start with / and contain no whitespace")
        if "\0" in value:
            raise ValueError("OSC address cannot contain null bytes")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ValueError("OSC address must contain valid Unicode") from exc
        return value

    @field_validator("host")
    @classmethod
    def validate_osc_host(cls, value: str) -> str:
        value = value.strip()
        if not value or "\0" in value:
            raise ValueError("OSC host is invalid")
        return value

    @model_validator(mode="after")
    def validate_values(self) -> "ControlOSCMessage":
        if not self.values:
            self.values = [0.0]
        if len(self.values) > 32:
            raise ValueError("OSC messages support up to 32 values")
        for value in self.values:
            if isinstance(value, bool):
                raise ValueError("OSC values cannot be booleans")
            if isinstance(value, int) and not -(2**31) <= value < 2**31:
                raise ValueError("OSC integer values must fit signed 32-bit encoding")
            if isinstance(value, float) and (
                not math.isfinite(value) or abs(value) > 3.4028235e38
            ):
                raise ValueError("OSC float values must fit finite 32-bit encoding")
            if isinstance(value, str):
                if len(value.encode("utf-8")) > 1024:
                    raise ValueError("OSC string values cannot exceed 1024 UTF-8 bytes")
                if "\0" in value:
                    raise ValueError("OSC string values cannot contain null bytes")
        return self


class ControlOSCResult(BaseModel):
    status: Literal["sent", "recorded", "error"]
    host: str
    port: int
    address: str
    byte_count: int = 0
    sent: bool = False
    error: str | None = None


class ControlNornsBridgeRequest(JSONRequestModel):
    host: str = Field(default="127.0.0.1", min_length=1, max_length=253)
    port: int = Field(default=10111, ge=1, le=65535)
    profile: Literal["norns", "fates"] = "fates"
    gravity: float | None = Field(default=None, ge=0.0, le=1.0)
    viscosity: float | None = Field(default=None, ge=0.0, le=1.0)
    energy: float | None = Field(default=None, ge=0.0, le=1.0)
    spawn: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("host")
    @classmethod
    def validate_norns_host(cls, value: str) -> str:
        value = value.strip()
        if not value or "\0" in value:
            raise ValueError("norns host is invalid")
        return value


class ControlNornsBridgeResult(BaseModel):
    status: Literal["sent", "error"]
    host: str
    port: int
    profile: str
    sent: bool = False
    messages: list[ControlOSCResult] = Field(default_factory=list)
    error: str | None = None


class ControlMIDIMessage(JSONRequestModel):
    backend: Literal["browser", "native_optional", "event"] = "event"
    device: str | None = Field(default=None, max_length=500)
    channel: int = Field(default=1, ge=1, le=16)
    type: Literal["note_on", "note_off", "cc", "clock", "transport"] = "cc"
    note: int | None = Field(default=None, ge=0, le=127)
    cc: int | None = Field(default=None, ge=0, le=127)
    value: int = Field(default=64, ge=0, le=127)
    velocity: int = Field(default=96, ge=0, le=127)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ControlMIDIResult(BaseModel):
    status: Literal["sent", "recorded", "unsupported", "error"]
    sent: bool = False
    backend: str
    detail: str | None = None


class ControlCVProfile(JSONRequestModel):
    id: str | None = Field(default=None, max_length=256)
    name: str = Field(min_length=1, max_length=120)
    interface_label: str | None = Field(default=None, max_length=500)
    output_channel: int = Field(ge=1, le=256)
    mode: ControlCVMode = "cv"
    range: ControlCVRange = "unipolar"
    volts_per_unit: float = Field(default=1.0, gt=0.0, le=10.0)
    offset_volts: float = Field(default=0.0, ge=-10.0, le=10.0)
    clamp_min_volts: float = Field(default=0.0, ge=-10.0, le=10.0)
    clamp_max_volts: float = Field(default=5.0, ge=-10.0, le=10.0)
    slew_limit_ms: float = Field(default=5.0, ge=0.0, le=60000.0)
    gate_voltage: float = Field(default=5.0, ge=0.0, le=10.0)
    pulse_width_ms: float = Field(default=10.0, ge=1.0, le=10000.0)
    speaker_protection: bool = True
    calibrated: bool = False
    armed: bool = False
    created_at: str | None = Field(default=None, max_length=100)
    updated_at: str | None = Field(default=None, max_length=100)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_cv_profile(self) -> "ControlCVProfile":
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("CV profile name cannot be empty")
        if self.clamp_max_volts < self.clamp_min_volts:
            raise ValueError("clamp_max_volts must be greater than or equal to clamp_min_volts")
        if self.armed and (not self.calibrated or not self.speaker_protection):
            raise ValueError("CV profile must be calibrated and speaker-protected before arming")
        return self


class ControlCVProfilesResponse(BaseModel):
    profiles: list[ControlCVProfile]


class ControlCVArmRequest(BaseModel):
    armed: bool
    confirm: bool = False


class ControlGeneticGraphResponse(BaseModel):
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    source: dict[str, Any] = Field(default_factory=dict)
