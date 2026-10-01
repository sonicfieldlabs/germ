"""Permission and exact-input admission for memory-conditioned generation."""

import hashlib
import json
import os
import re

import httpx
from fastapi import HTTPException
from akousma.retained_policy import retained_covenant, blocks_untyped_prose


def digest(record):
    return hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


# What Akousmata's curator writes when rights are asserted (akousmata_app.records.set_consent),
# and nothing else. A rights assertion is not a change in what was heard.
RIGHTS_FIELDS = (
    ("provenance", "consent_status"),
    ("provenance", "rights_note"),
    ("extensions", "akousmata.app", "consent_set_by"),
)


def _has_rights(record):
    for path in RIGHTS_FIELDS:
        node = record
        for key in path[:-1]:
            node = node.get(key) if isinstance(node, dict) else None
        if isinstance(node, dict) and path[-1] in node:
            return True
    return False


def without_rights(record):
    """The record as it was before a curator recorded its rights: those fields removed, and
    any container the assertion created, and left otherwise empty, removed with them.

    Only the containers on a rights path are copied; everything else is shared with the
    record, which is never modified. A full deep copy of every memory a render drew on
    took about 3 s for 113 records (25 September 2026).
    """
    value = dict(record)
    for path in RIGHTS_FIELDS:
        trail, node = [], value
        for key in path[:-1]:
            if not isinstance(node, dict) or not isinstance(node.get(key), dict):
                node = None
                break
            node[key] = dict(node[key])  # copy on the path only
            trail.append((node, key))
            node = node[key]
        if not isinstance(node, dict) or path[-1] not in node:
            continue
        del node[path[-1]]
        for parent, key in reversed(trail[1:] if path[0] == "provenance" else trail):
            if parent[key] == {}:
                del parent[key]
    return value


class Admitted:
    """An admitted record's digest, and its digest without recorded rights, computed only
    when a dependency does not match the first. Unpacks as ``(full, bare)``."""

    def __init__(self, record, full):
        self.record = record
        self.full = full
        self._bare = None

    @property
    def bare(self):
        if self._bare is None:
            self._bare = digest(without_rights(self.record)) if _has_rights(self.record) else self.full
        return self._bare

    def __iter__(self):
        return iter((self.full, self.bare))


def matches_admitted(admitted, expected):
    """A conditioning dependency still holds when the record is the one it bound, or that record
    with only its rights recorded since. Found 25 September 2026: recording consent rewrites a
    record under its id, and a render made in memory mode binds the digest of every record it
    drew on (66-110), so recording rights refused every such render as changed memory."""
    if admitted is None:
        return False
    if not isinstance(admitted, Admitted):
        full, bare = admitted
        return expected in (full, bare)
    return expected == admitted.full or expected == admitted.bare


class AdmissionSession:
    """One request's permission reads, shared across the items it checks.

    A library listing checked every item on its own: a store opened per item, and for
    every memory influence a fresh HTTP client, a fresh Oída identity read and a routing
    read, so 108 items with 144 influences cost 288 requests and about ten seconds
    (24 September 2026). A session opens the store and one client once, reads Oída's
    identity once, and checks each record once for the life of the request. Nothing
    outlives the request: the next request reads permission afresh.
    """

    def __init__(self):
        self._store = None
        self._client = None
        self._headers = None
        self._verdicts = {}
        self._digests = {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if self._client is not None:
            self._client.close()
        if self._store is not None:
            self._store.close()

    @property
    def store(self):
        if self._store is None:
            from server.akousma_store import open_store

            self._store = open_store()
        return self._store

    def _connect(self):
        from server.listener import _oida_workspace_headers

        if self._headers is None:
            self._headers = _oida_workspace_headers()
        if self._client is None:
            self._client = httpx.Client(timeout=10, trust_env=False, follow_redirects=False)

    def prefetch(self, identifiers):
        """Read the current view and digest of many records in one request.

        An Oída without the batch route, or any failure, leaves each record to be read on
        its own when it is checked; nothing is assumed from a failed prefetch.
        """
        if not os.getenv("LISTENINGSTACK_WORKSPACE_ID"):
            return
        from server.registry import settings

        wanted = [i for i in dict.fromkeys(identifiers) if i not in self._digests and re.fullmatch(r"[A-Za-z0-9_:-]{1,100}", str(i))]
        try:
            self._connect()
            for start in range(0, len(wanted), 500):
                response = self._client.post(
                    f"{settings.oida_url}/reasoning/workspace/routing/archive/digests",
                    headers=self._headers,
                    json={"ids": wanted[start : start + 500]},
                )
                response.raise_for_status()
                value = response.json()
                if value.get("contract") != "oida/archive-digests/v1":
                    return
                self._digests.update(value.get("views") or {})
        except (httpx.HTTPError, ValueError, HTTPException):
            return

    def current(self, identifier):
        from server.registry import settings

        if identifier in self._digests:
            row = self._digests[identifier]
            return {"view": {"state": row.get("state")}, "record_sha256": row.get("record_sha256")}
        self._connect()
        response = self._client.get(
            f"{settings.oida_url}/reasoning/workspace/routing/archive/{identifier}",
            headers=self._headers,
        )
        response.raise_for_status()
        return response.json()

    def _raw(self, identifier):
        conn = getattr(self.store, "conn", None)
        if conn is None:
            return False  # a store without a connection: read it through get()
        row = conn.execute("SELECT record FROM akousmata WHERE akousma_id=?", (identifier,)).fetchone()
        return row[0] if row else None

    def admitted_digest(self, identifier):
        """The admitted record's digest and its digest without recorded rights, or the refusal,
        computed once per request."""
        if identifier not in self._verdicts:
            try:
                raw = self._raw(identifier)
                if raw is False:
                    record = self.store.get(identifier)
                    admitted, full = admitted_record(self.store, record, session=self, with_digest=True) if record else (None, None)
                    self._verdicts[identifier] = Admitted(admitted, full) if admitted else None
                elif raw is None:
                    self._verdicts[identifier] = None
                else:
                    self._verdicts[identifier] = admitted_pure(self.store, identifier, _PURE.get(raw), session=self)
            except HTTPException as exc:
                self._verdicts[identifier] = exc
        verdict = self._verdicts[identifier]
        if isinstance(verdict, HTTPException):
            raise verdict
        return verdict


class _PureMemo:
    """What a stored record yields independently of any policy, keyed by the SHA-256 of its
    stored text: its cumulative covenant verdict, its digest and its digest without recorded
    rights. Each is a pure function of those bytes, so the memo is exact; forgetting and
    Oída's current state are still read on every request. Parsing and digesting the ~300 KB
    records a memory render drew on, on every playback request, cost seconds (25 September)."""

    def __init__(self, limit=2048):
        import threading
        from collections import OrderedDict

        self.limit, self.items, self.lock = limit, OrderedDict(), threading.Lock()

    def get(self, raw):
        key = hashlib.sha256(raw.encode()).hexdigest()
        with self.lock:
            hit = self.items.get(key)
            if hit is not None:
                self.items.move_to_end(key)
                return hit
        record = json.loads(raw)
        covenant = retained_covenant(record)
        full = digest(record)
        value = {
            "identifier": record.get("akousma_id"),
            "covenant_blocks": bool(blocks_untyped_prose(covenant) or any(covenant.get(key) for key in ("withheld", "rules_applied", "commitments"))),
            "full": full,
            "bare": digest(without_rights(record)) if _has_rights(record) else full,
        }
        with self.lock:
            self.items[key] = value
            while len(self.items) > self.limit:
                self.items.popitem(last=False)
        return value


_PURE = _PureMemo()


def admitted_pure(store, identifier, pure, session):
    """``admitted_record`` over a record's pure derivations: forgetting and, in a managed
    workspace, Oída's current state and digest are read afresh; the rest comes from ``pure``."""
    if pure["identifier"] != identifier:
        raise HTTPException(423, "Selected memory is withheld or forgotten")
    forgotten = getattr(store, "forgotten", lambda _: None)(identifier)
    if forgotten or pure["covenant_blocks"]:
        raise HTTPException(423, "Selected memory is withheld or forgotten")
    if os.getenv("LISTENINGSTACK_WORKSPACE_ID"):
        try:
            current = session.current(identifier)
            current_digest = current["record_sha256"] if "record_sha256" in current else digest(current.get("record"))
            if current.get("view", {}).get("state") != "available" or current_digest != pure["full"]:
                raise HTTPException(423, "Memory policy or content changed")
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "Current memory permission is unavailable") from exc
    return (pure["full"], pure["bare"])


def admitted_record(store, record, session=None, with_digest=False):
    identifier = record["akousma_id"]
    own = None
    forgotten = getattr(store, "forgotten", lambda _: None)(identifier)
    covenant = retained_covenant(record)
    if forgotten or blocks_untyped_prose(covenant) or any(covenant.get(key) for key in ("withheld", "rules_applied", "commitments")):
        raise HTTPException(423, "Selected memory is withheld or forgotten")
    # In a managed workspace Oída owns the current (not only archived) policy.
    # Standalone GERM uses the canonical store and cumulative covenant above.
    if os.getenv("LISTENINGSTACK_WORKSPACE_ID"):
        try:
            if session is not None:
                current = session.current(identifier)
            else:
                from server.listener import _oida_workspace_headers
                from server.registry import settings

                with httpx.Client(timeout=10, trust_env=False, follow_redirects=False) as client:
                    response = client.get(f"{settings.oida_url}/reasoning/workspace/routing/archive/{identifier}", headers=_oida_workspace_headers())
                response.raise_for_status()
                current = response.json()
            current_digest = current["record_sha256"] if "record_sha256" in current else digest(current.get("record"))
            own = digest(record)
            if current.get("view", {}).get("state") != "available" or current_digest != own:
                raise HTTPException(423, "Memory policy or content changed")
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "Current memory permission is unavailable") from exc
    if with_digest:
        return record, own if own is not None else digest(record)
    return record


def validate_conditioning(request):
    validate_context(getattr(request, "generation_context", None) or {})


def validate_context(context, session=None):
    if not isinstance(context, dict):
        raise HTTPException(422, "Invalid memory conditioning context")
    influences = context.get("memory_influences") or []
    if not influences:
        return
    if not isinstance(influences, list) or len(influences) > 1000:
        raise HTTPException(422, "Invalid memory conditioning manifest")
    if session is None:
        with AdmissionSession() as own:
            own.prefetch(item.get("record_id") for item in influences if isinstance(item, dict))
            return validate_context(context, session=own)
    for item in influences:
        if not isinstance(item, dict) or not re.fullmatch(r"[A-Za-z0-9_:-]{1,100}", str(item.get("record_id", ""))) or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))):
            raise HTTPException(422, "Invalid memory conditioning dependency")
        if not matches_admitted(session.admitted_digest(item["record_id"]), item.get("sha256")):
            raise HTTPException(423, "Memory changed or was forgotten before generation admission")
