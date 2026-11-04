"""Every generator says what it is for, so a listening loop sounds by what it heard."""
from server.workspace_capabilities import MODELS, PURPOSES, descriptor


def test_every_generator_names_its_purpose_size_and_a_duration_it_supports():
    assert set(PURPOSES) == set(MODELS)
    for identifier in MODELS:
        entry = descriptor(identifier)
        assert entry["purpose"] in {"music", "sfx", "any"}
        assert entry["size"] in {"small", "medium", "cpu"}
        assert entry["min_duration"] <= entry["recommended_duration"] <= entry["max_duration"]


def test_the_small_stable_audio_checkpoints_split_music_and_effects():
    assert (descriptor("sm-music")["purpose"], descriptor("sm-music")["size"]) == ("music", "small")
    assert (descriptor("sm-sfx")["purpose"], descriptor("sm-sfx")["size"]) == ("sfx", "small")
