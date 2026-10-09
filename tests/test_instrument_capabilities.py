from unittest.mock import patch

from server.instrument_capabilities import catalog


def test_catalog_has_no_install_load_or_availability_promotion(monkeypatch):
    monkeypatch.delenv("GERM_RESEARCH_CONFIG", raising=False)
    with patch("server.instrument_capabilities.util.find_spec", return_value=None):
        result = catalog()
    rows = {item["id"]: item for item in result["instruments"]}
    assert not result["auto_install"]
    assert rows["shoebox-room"]["status"] == "dependency_unavailable"
    assert rows["basic-pitch"]["status"] == "deployment_unavailable"
    assert rows["rave-guitar"]["status"] == "deployment_unavailable"
    assert rows["spectral-frame"]["status"] == "source_gated"
    assert result["live_qualification"] == "not_claimed"
