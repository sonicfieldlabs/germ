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
