"""One request reads each memory's permission once, and the next request reads it again.

24 September 2026: a library listing of 108 items opened the store 108 times and made 288
requests (a fresh client, a fresh Oída identity and a routing read per influence), about ten
seconds. Permission is still never cached between requests.
"""

from copy import deepcopy

import pytest
from fastapi import HTTPException

import server.akousma_store
import server.listener
from server.memory_policy import AdmissionSession, digest, validate_context


BATCH = {"supported": True}


class Store:
    opened = 0

    def __init__(self, records):
        Store.opened += 1
        self.records = records
        self.reads = []

    def get(self, identifier):
        self.reads.append(identifier)
        return deepcopy(self.records.get(identifier))

    def forgotten(self, identifier):
        return False

    def close(self):
        pass


@pytest.fixture
def world(monkeypatch):
    record = {"akousma_id": "memory", "auditum": {}, "summary": "Allowed"}
    records = {"memory": record}
    stores = []

    def open_store():
        stores.append(Store(records))
        return stores[-1]

    routing = []

    class Response:
        def __init__(self, value):
            self.value = value

        def raise_for_status(self):
            pass

        def json(self):
            return self.value

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url, headers=None):
            routing.append(url)
            return Response({"view": {"state": "available"}, "record": deepcopy(records["memory"])})

        def post(self, url, headers=None, json=None):
            routing.append(("batch", tuple(json["ids"])))
            if not BATCH["supported"]:
                raise __import__("httpx").HTTPStatusError("404", request=None, response=None)
            return Response(
                {
                    "contract": "oida/archive-digests/v1",
                    "views": {
                        i: {"state": "available", "record_sha256": digest(records[i])}
                        for i in json["ids"]
                        if i in records
                    },
                }
            )

        def close(self):
            pass

    BATCH["supported"] = True
    monkeypatch.setenv("LISTENINGSTACK_WORKSPACE_ID", "ws_fixture")
    monkeypatch.setattr(server.akousma_store, "open_store", open_store)
    monkeypatch.setattr(
        server.listener, "_oida_workspace_headers", lambda: {"X-Centaur-Binding": "b"}
    )
    monkeypatch.setattr("server.memory_policy.httpx.Client", Client)
    return record, stores, routing


def influenced(record):
    return {"memory_influences": [{"record_id": "memory", "sha256": digest(record)}]}


def test_a_request_reads_each_memory_once(world):
    record, stores, routing = world
    with AdmissionSession() as session:
        for _ in range(5):
            validate_context(influenced(record), session=session)
    assert len(stores) == 1 and stores[0].reads == ["memory"] and len(routing) == 1


def test_the_next_request_reads_permission_again(world):
    record, stores, routing = world
    context = influenced(record)
    with AdmissionSession() as session:
        validate_context(context, session=session)
    record["summary"] = "Changed"
    with AdmissionSession() as session:
        with pytest.raises(HTTPException) as refused:
            validate_context(context, session=session)
    assert refused.value.status_code == 423 and len(stores) == 2 and len(routing) == 2


def test_a_refusal_is_remembered_for_the_request_only(world):
    record, stores, routing = world
    stale = {"memory_influences": [{"record_id": "memory", "sha256": "0" * 64}]}
    with AdmissionSession() as session:
        for _ in range(3):
            with pytest.raises(HTTPException):
                validate_context(stale, session=session)
    assert len(routing) == 1
    validate_context(influenced(record))  # a fresh request, admitted


@pytest.mark.parametrize("supported", [True, False])
def test_a_listing_prefetches_every_digest_in_one_request_or_reads_each(world, supported):
    record, stores, routing = world
    BATCH["supported"] = supported
    with AdmissionSession() as session:
        session.prefetch(["memory", "memory"])
        for _ in range(3):
            validate_context(influenced(record), session=session)
    batches = [call for call in routing if isinstance(call, tuple)]
    singles = [call for call in routing if not isinstance(call, tuple)]
    assert batches == [("batch", ("memory",))]
    assert singles == ([] if supported else [singles[0]]) and len(singles) == (
        0 if supported else 1
    )


def test_a_prefetched_digest_that_differs_is_refused(world):
    record, stores, routing = world
    with AdmissionSession() as session:
        session.prefetch(["memory"])
        record["summary"] = "Changed after the prefetch"
        stores.clear()
        with pytest.raises(HTTPException) as refused:
            validate_context(
                {"memory_influences": [{"record_id": "memory", "sha256": digest(record)}]},
                session=session,
            )
    assert refused.value.status_code == 423


def curate(record, status="licensed", note="Operator attestation"):
    """What akousmata_app.records.set_consent does to a record, and nothing more."""
    record.setdefault("provenance", {})["consent_status"] = status
    record["provenance"]["rights_note"] = note
    record.setdefault("extensions", {}).setdefault("akousmata.app", {})["consent_set_by"] = "human"


def test_recording_rights_after_a_render_does_not_read_as_changed_memory(world):
    """25 Sept: recording consent rewrote each record, and every memory-mode render bound the
    digests of the records it drew on, so recording rights refused all such renders."""
    record, stores, routing = world
    record["provenance"] = {"origin": "file"}
    context = influenced(record)
    curate(record)
    with AdmissionSession() as session:
        validate_context(context, session=session)
    record["summary"] = "A different account"
    with AdmissionSession() as session:
        with pytest.raises(HTTPException):
            validate_context(context, session=session)


def test_rights_already_recorded_when_the_render_was_made_are_not_forgotten(world):
    record, stores, routing = world
    record["provenance"] = {"origin": "file"}
    curate(record, status="licensed", note="First attestation")
    context = influenced(record)
    record["provenance"]["rights_note"] = "A later, different attestation"
    with AdmissionSession() as session:
        with pytest.raises(HTTPException):
            validate_context(context, session=session)


def test_without_rights_removes_only_what_the_assertion_wrote():
    from server.memory_policy import without_rights

    original = {"provenance": {"origin": "file"}, "extensions": {"other": {"x": 1}}, "summary": "s"}
    curated = deepcopy(original)
    curate(curated)
    assert without_rights(curated) == original
    bare = {"provenance": {"origin": "file"}, "summary": "s"}
    curated = deepcopy(bare)
    curate(curated)
    assert without_rights(curated) == bare, "containers the assertion created go with it"


def test_without_rights_copies_only_the_rights_paths_and_never_touches_the_record():
    import copy
    from server.memory_policy import without_rights

    record = {"akousma_id": "akm_1", "auditum": {"listenings": [{"claims": list(range(50))}]},
              "provenance": {"consent_status": "owned", "rights_note": "n", "source": "s"},
              "extensions": {"akousmata.app": {"consent_set_by": "curator", "other": 1}}}
    before = copy.deepcopy(record)
    bare = without_rights(record)
    assert record == before, "the admitted record is not modified"
    assert bare["auditum"] is record["auditum"], "content outside the rights paths is shared, not copied"
    assert bare["provenance"] == {"source": "s"} and bare["extensions"] == {"akousmata.app": {"other": 1}}


def test_the_rights_free_digest_is_computed_only_when_needed():
    from server import memory_policy as mp

    plain = {"akousma_id": "akm_2", "provenance": {"source": "s"}}
    admitted = mp.Admitted(plain, mp.digest(plain))
    assert mp.matches_admitted(admitted, admitted.full)
    assert admitted._bare is None, "a matching full digest needs no second digest"
    assert admitted.bare == admitted.full, "a record with no rights has one digest"
    curated = {"akousma_id": "akm_3", "provenance": {"source": "s", "consent_status": "owned"}}
    before_rights = {"akousma_id": "akm_3", "provenance": {"source": "s"}}
    admitted = mp.Admitted(curated, mp.digest(curated))
    assert mp.matches_admitted(admitted, mp.digest(before_rights))
    full, bare = admitted
    assert (full, bare) == (mp.digest(curated), mp.digest(before_rights))


def test_a_validation_that_owns_its_session_prefetches_every_influence(monkeypatch):
    from server import memory_policy as mp

    fetched = []
    monkeypatch.setattr(mp.AdmissionSession, "prefetch", lambda self, ids: fetched.append(list(ids)))
    monkeypatch.setattr(mp.AdmissionSession, "admitted_digest", lambda self, rid: mp.Admitted({"akousma_id": rid}, "a" * 64))
    context = {"memory_influences": [{"record_id": "akm_a", "sha256": "a" * 64}, {"record_id": "akm_b", "sha256": "a" * 64}]}
    mp.validate_context(context)
    assert fetched == [["akm_a", "akm_b"]]


def test_the_stored_text_path_agrees_with_admitted_record_on_a_real_store(tmp_path, monkeypatch):
    import akousma
    import server.akousma_store
    from server import memory_policy as mp

    monkeypatch.delenv("LISTENINGSTACK_WORKSPACE_ID", raising=False)
    store = akousma.AkousmataStore(root=tmp_path / "store")
    auditum = akousma.auditum(route_decisions=[akousma.route_decision("fixture", gate="input", outcome="abstain", subject="synthetic", reason="none", actor="test")])
    plain = akousma.new_akousma(audio={"asset_id": "p"}, originating_app="oida", summary="Plain", auditum=auditum)
    curated = akousma.new_akousma(audio={"asset_id": "c"}, originating_app="oida", summary="Curated", auditum=auditum)
    curated.setdefault("provenance", {})["consent_status"] = "owned"
    for record in (plain, curated):
        store.put(record)
    forgotten = set()
    monkeypatch.setattr(type(store), "forgotten", lambda self, i: i in forgotten, raising=False)
    monkeypatch.setattr(server.akousma_store, "open_store", lambda: store)
    monkeypatch.setattr(type(store), "close", lambda self: None, raising=False)
    for record in (plain, curated):
        rid = record["akousma_id"]
        stored = store.get(rid)
        with mp.AdmissionSession() as session:
            assert session._raw(rid) is not False, "a real store is read as stored text"
            assert tuple(session.admitted_digest(rid)) == (mp.digest(stored), mp.digest(mp.without_rights(stored)))
        forgotten.add(rid)
        with mp.AdmissionSession() as session, pytest.raises(HTTPException):
            session.admitted_digest(rid)
        forgotten.discard(rid)
