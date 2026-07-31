/* Cosmoaudition dashboard boundary -----------------------------------------
   Keep unavailable, errored, and explicitly zero-valued observations
   distinct before they enter GERM's modulation graph. These helpers are
   intentionally DOM-free so the data contract can be exercised in smoke
   tests without booting the dashboard. */

export const COSMOAUDITION_MODULATOR_TYPES = new Set([
  "cosmo_observation",
  "cosmo_cosmic_field",
  "cosmo_earth_field",
  "cosmo_biosphere_field",
  "cosmo_human_machine_field",
  "cosmo_relational_index",
  "cosmo_event_pulsar",
  "cosmo_mapping_loom",
  "cosmo_semantic_field",
  "cosmo_uncertainty_field",
  "cosmo_observation_archive",
]);

const UNCERTAINTY_VALUES = Object.freeze({
  high: 0.08,
  medium: 0.3,
  low: 0.62,
  stale: 0.84,
  error: 1,
});

export function finiteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function cosmoauditionSignalMatches(modulatorType, signal = {}) {
  const sphere = String(signal.sphere || "").toLowerCase();
  if (modulatorType === "cosmo_cosmic_field") return sphere === "cosmos";
  if (modulatorType === "cosmo_earth_field") return ["atmosphere", "geosphere"].includes(sphere);
  if (modulatorType === "cosmo_biosphere_field") return sphere === "biosphere";
  if (modulatorType === "cosmo_human_machine_field") return ["human", "machine"].includes(sphere);
  return true;
}

export function cosmoauditionMatchingSignals(modulatorType, signals = []) {
  return (Array.isArray(signals) ? signals : []).filter((signal) =>
    signal && cosmoauditionSignalMatches(modulatorType, signal));
}

export function cosmoauditionUsableSignals(modulatorType, signals = []) {
  return cosmoauditionMatchingSignals(modulatorType, signals).filter((signal) =>
    signal.confidence !== "error"
    && !signal.error
    && finiteNumberOrNull(signal.normalized) !== null);
}

export function cosmoauditionSelectedSignal(node, signals = []) {
  const modulatorType = node?.modulatorType || "cosmo_observation";
  let candidates;
  if (["cosmo_mapping_loom", "cosmo_uncertainty_field"].includes(modulatorType)) {
    candidates = cosmoauditionMatchingSignals(modulatorType, signals);
  } else {
    candidates = cosmoauditionUsableSignals(modulatorType, signals);
  }
  if (modulatorType === "cosmo_event_pulsar") {
    candidates = candidates.filter((signal) =>
      signal.temporalCharacter === "event" || Boolean(signal.eventKey));
  }
  const selectedId = String(node?.config?.signalId || "").trim();
  return selectedId
    ? candidates.find((signal) => signal.id === selectedId) || null
    : candidates[0] || null;
}

export function cosmoauditionUnitFor(node, signals = [], selected = null, semanticUnit = () => 0) {
  const modulatorType = node?.modulatorType || "cosmo_observation";
  const usable = cosmoauditionUsableSignals(modulatorType, signals);
  if (modulatorType === "cosmo_relational_index") {
    return usable.length
      ? usable.reduce((sum, signal) => sum + finiteNumberOrNull(signal.normalized), 0) / usable.length
      : null;
  }
  if (modulatorType === "cosmo_event_pulsar") {
    return selected ? 1 : null;
  }
  if (modulatorType === "cosmo_uncertainty_field") {
    return UNCERTAINTY_VALUES[selected?.confidence] ?? null;
  }
  const observed = finiteNumberOrNull(selected?.normalized);
  if (modulatorType === "cosmo_semantic_field" && observed !== null) {
    const semantic = finiteNumberOrNull(semanticUnit(selected));
    const boundedSemantic = Math.min(1, Math.max(0, semantic ?? 0));
    return Math.min(1, Math.max(0, (observed * 0.65) + (boundedSemantic * 0.35)));
  }
  return observed;
}

export function cosmoauditionPreviousOutput(node) {
  const stored = finiteNumberOrNull(node?.config?.previousValue);
  if (stored !== null) return stored;
  return node?.config?.available === true
    ? finiteNumberOrNull(node?.config?.currentValue)
    : null;
}

export function cosmoauditionMappingSignal(selected) {
  if (!selected) return null;
  const normalized = finiteNumberOrNull(selected.normalized);
  return {
    ...selected,
    value: normalized,
    normalized,
    unit: "normalized",
  };
}
