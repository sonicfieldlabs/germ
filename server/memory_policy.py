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

    def admitted_digest(self, identifier):
        """The digest of the admitted record, or the refusal, computed once per request."""
        if identifier not in self._verdicts:
            try:
                record = self.store.get(identifier)
                self._verdicts[identifier] = (
                    digest(admitted_record(self.store, record, session=self)) if record else None
                )
            except HTTPException as exc:
                self._verdicts[identifier] = exc
        verdict = self._verdicts[identifier]
        if isinstance(verdict, HTTPException):
            raise verdict
        return verdict


def admitted_record(store, record, session=None):
    identifier = record["akousma_id"]
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
            if current.get("view", {}).get("state") != "available" or current_digest != digest(record):
                raise HTTPException(423, "Memory policy or content changed")
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "Current memory permission is unavailable") from exc
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
            return validate_context(context, session=own)
    for item in influences:
        if not isinstance(item, dict) or not re.fullmatch(r"[A-Za-z0-9_:-]{1,100}", str(item.get("record_id", ""))) or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))):
            raise HTTPException(422, "Invalid memory conditioning dependency")
        if session.admitted_digest(item["record_id"]) != item.get("sha256"):
            raise HTTPException(423, "Memory changed or was forgotten before generation admission")
