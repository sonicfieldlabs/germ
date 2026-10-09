from hashlib import sha256

from akousma import AkousmataStore
from server.akousma_store import resolve_audio_path


def test_memory_audio_checks_object_identity_and_refuses_symlinks(tmp_path):
    data = b"temporary germ object fixture"
    with AkousmataStore(tmp_path / "store") as store:
        uri = store.put_audio(data)
        record = {"audio": {"uri": uri, "content_hash": "sha256:" + sha256(data).hexdigest()}}
        path = resolve_audio_path(store, record)
        assert path.read_bytes() == data
        assert resolve_audio_path(store, {"audio": {"uri": uri, "content_hash": "sha256:" + "0" * 64}}) is None
        outside = tmp_path / "outside"
        outside.write_bytes(data)
        path.unlink()
        path.symlink_to(outside)
        assert resolve_audio_path(store, record) is None
        assert outside.read_bytes() == data
