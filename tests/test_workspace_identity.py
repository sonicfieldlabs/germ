import os
import subprocess
import sys


def test_workspace_identity_and_final_mutation_fence(tmp_path):
    code = """
from fastapi.testclient import TestClient
from server.main import app
with TestClient(app) as client:
    identity = client.get('/owner/identity').json()
    assert identity['owner'] == 'germ' and len(identity['binding']) == 64
    assert client.post('/api/jobs/cancel-all').status_code == 409
"""
    env = dict(os.environ)
    env.update(
        LISTENINGSTACK_WORKSPACE_ID="ws_0123456789abcdef01234567",
        LISTENINGSTACK_WORKSPACE_GENERATION="generation-one",
        GERM_OUTPUT_DIR=str(tmp_path / "output"),
    )
    result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
