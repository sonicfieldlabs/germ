import json
import zipfile
from hashlib import sha256
import pytest
from server.agent_sounds import package
from server.registry import storage
from test_synthesis_provider import run


def test_agent_asset_pack_keeps_sampling_and_perceptual_access_separate():
    result=run("additive",masa_contracts=["masa/0.2.0"])
    # The queue writes its durable receipt after its execution future resolves.
    from server.registry import job_runner
    job_runner.shutdown(wait=True)
    bundle=package(result.metadata_files,["PCM16-WAV", "sample-rate:44100"])
    path=storage.resolve_path(bundle["archive"])
    with zipfile.ZipFile(path) as archive:
        manifest=json.loads(archive.read("manifest.json"))
        entry=manifest["entries"][0]
        assert sha256(archive.read(entry["path"])).hexdigest()==entry["sha256"]
        assert entry["representation"]["sampled_band_hz"]["status"]=="unknown"
        assert entry["representation"]["human_perceptual_access"]=="unknown"
        assert manifest["human_rendering"]=="none"
    metadata=json.loads(storage.resolve_path(result.metadata_files[0]).read_text())
    storage.resolve_path(metadata["output_audio_path"]).write_bytes(b"changed")
    with pytest.raises(ValueError,match="changed"):
        package(result.metadata_files,["PCM16-WAV"])
