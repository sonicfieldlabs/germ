"""Station authorization uses the exact cached index entry, but never cached permission."""
import hashlib

import pytest
from fastapi import HTTPException

from server.routes import library


def test_exact_authorization_rechecks_only_selected_item(tmp_path, monkeypatch):
    path = tmp_path / "selected.wav"
    path.write_bytes(b"fixture audio")
    key = hashlib.sha256(b"selected").hexdigest()
    selected = {"id": "selected", "sound_id": "selected", "audio_file": str(path),
                "audio_exists": True, "provider": "mock", "title": "Canary"}
    other = {"id": "other"}
    monkeypatch.setattr(library, "_library_cache", {"items": [other, selected], "key_index": {key: selected}})
    monkeypatch.setattr(library, "_refresh_library_unlocked", lambda: None)
    monkeypatch.setattr(library.settings, "output_root", tmp_path)
    checked = []
    permitted = True
    def check(items):
        checked.append(items)
        return items if permitted else []
    monkeypatch.setattr(library, "_permitted_items", check)
    assert library.library_audio_authorization(key)["kind"] == "generated"
    assert checked == [[selected]]
    permitted = False
    with pytest.raises(HTTPException) as exc:
        library.library_audio_authorization(key)
    assert exc.value.status_code == 404
    assert checked == [[selected], [selected]]
