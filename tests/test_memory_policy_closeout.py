from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from server.routes import workspace
from server.memory_policy import digest, validate_context


class Store:
    def __init__(self, records):
        self.records = records
        self.revoked = set()
    def get(self, identifier): return deepcopy(self.records.get(identifier))
    def query(self, **kwargs): return [deepcopy(value) for value in self.records.values()]
    def forgotten(self, identifier): return identifier in self.revoked
    def close(self): pass


@pytest.mark.parametrize("location", ["top", "native", "listening", "auditum", "forgotten"])
def test_conditioning_rejects_selected_and_excludes_optional_private_memory(monkeypatch, location):
    allowed = {"akousma_id": "allowed", "auditum": {"contract": "fixture"}, "summary": "PUBLIC_TONE"}
    private = {**deepcopy(allowed), "akousma_id": "private", "summary": "PRIVATE_CANARY"}
    covenant = {"rules_applied": ["do_not_reveal:speech"]}
    if location == "top":
        private["covenant"] = covenant
    if location == "native":
        private["extensions"] = {"oida.native-policy": {"covenant": covenant}}
    if location == "listening":
        private["listening"] = {"oida.listen": {"payload": {"listening_context": {"covenant": covenant}}}}
    if location == "auditum":
        private["auditum"]["covenant"] = covenant
    store = Store({"allowed": allowed, "private": private})
    if location == "forgotten":
        store.revoked.add("private")
    monkeypatch.delenv("LISTENINGSTACK_WORKSPACE_ID", raising=False)
    monkeypatch.setattr(workspace, "open_store", lambda: store)
    monkeypatch.setattr(workspace, "derive_prompt_contract", lambda record: {"prompt": record["summary"], "contract": "fixture"})
    with pytest.raises(HTTPException) as exc:
        workspace.memory_context(["allowed", "private"])
    assert exc.value.status_code == 423
    context = workspace.memory_context()
    assert "PRIVATE_CANARY" not in str(context) and "PUBLIC_TONE" in context["prompt"]
    assert context["excluded"][0]["record_id"] == "private"


def test_manifest_rechecks_changes_and_forgetting(monkeypatch):
    import server.akousma_store
    record = {"akousma_id": "memory", "auditum": {}, "summary": "Allowed"}
    store = Store({"memory": record})
    monkeypatch.delenv("LISTENINGSTACK_WORKSPACE_ID", raising=False)
    monkeypatch.setattr(server.akousma_store, "open_store", lambda: store)
    context = {"memory_influences": [{"record_id": "memory", "sha256": digest(record)}]}
    validate_context(context)
    record["summary"] = "Changed"
    with pytest.raises(HTTPException):
        validate_context(context)
    record["summary"] = "Allowed"
    store.revoked.add("memory")
    with pytest.raises(HTTPException):
        validate_context(context)


@pytest.mark.parametrize("revoke_during", [False, True])
def test_provider_admission_and_commit_recheck(monkeypatch, revoke_during):
    from server.routes import _utils
    from server.schemas import GenerateRequest, GenerationResult
    import server.memory_policy as policy
    calls = []
    def validate(request):
        calls.append("check")
        if not revoke_during or "provider" in calls:
            raise HTTPException(423, "Memory revoked")
    monkeypatch.setattr(policy, "validate_conditioning", validate)
    def generate(request):
        calls.append("provider")
        return GenerationResult(job_id="fixture", status="done", mode="text_to_audio")
    fake = SimpleNamespace(generate=generate, clear_cancel_event=lambda _: None)
    monkeypatch.setattr(_utils.registry, "get", lambda _: fake)
    monkeypatch.setattr(_utils.storage, "get_job", lambda _: None)
    monkeypatch.setattr(_utils.storage, "update_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(_utils.storage, "write_error_metadata", lambda **kwargs: SimpleNamespace(status="error"))
    request = GenerateRequest(prompt="fixture")
    result = _utils.run_provider_method_with_existing_job(request, job_id="fixture", mode="text_to_audio", method_name="generate")
    assert result.status == "error"
    assert calls == (["check", "provider", "check"] if revoke_during else ["check"])


def test_library_rechecks_cached_conditioned_outputs(monkeypatch):
    from server.routes import library
    import server.akousma_store
    record = {"akousma_id": "memory", "auditum": {}, "summary": "Allowed"}
    store = Store({"memory": record})
    context = {"memory_influences": [{"record_id": "memory", "sha256": digest(record)}]}
    item = {"id": "generated", "prompt": "PRIVATE_DERIVED_PROMPT", "generation_context": context}
    monkeypatch.delenv("LISTENINGSTACK_WORKSPACE_ID", raising=False)
    monkeypatch.setattr(server.akousma_store, "open_store", lambda: store)
    monkeypatch.setattr(library, "_refresh_library_unlocked", lambda *args: None)
    monkeypatch.setattr(library, "_library_cache", {"items": [item]})
    assert library.library_items() == [item]
    store.revoked.add("memory")
    assert library.library_items() == []


def test_a_job_records_how_long_it_waited_for_the_heavy_lease(monkeypatch):
    """24 Sept: a render waited behind another lane's listening and only its total was recorded."""
    from server.routes import _utils
    from server.schemas import GenerateRequest, GenerationResult
    import akousma.resource_admission as admission
    import server.memory_policy as policy

    recorded = {}
    monkeypatch.setattr(policy, "validate_conditioning", lambda request: None)
    monkeypatch.setattr(admission, "last_wait_seconds", lambda: 12.3456)
    fake = SimpleNamespace(
        generate=lambda request: GenerationResult(job_id="fixture", status="done", mode="text_to_audio"),
        register_cancel_event=lambda *a: None,
        clear_cancel_event=lambda _: None,
    )
    monkeypatch.setattr(_utils.registry, "get", lambda _: fake)
    monkeypatch.setattr(_utils.storage, "get_job", lambda _: None)
    monkeypatch.setattr(_utils.storage, "update_job", lambda job_id, **kw: recorded.update(kw.get("metrics") or {}))
    _utils.run_provider_method_with_existing_job(GenerateRequest(prompt="fixture"), job_id="fixture", mode="text_to_audio", method_name="generate")
    assert recorded["admission_wait_seconds"] == 12.346 and "elapsed_seconds" in recorded
