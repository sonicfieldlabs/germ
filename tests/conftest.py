"""Test-suite isolation: redirect all generated output into a throwaway temp dir.

This module runs at pytest collection time, *before* any ``server.*`` module is
imported. That ordering matters: ``server.config`` builds the ``Settings``
singleton at import, and ``server.registry`` builds ``StorageManager`` plus the
control/strain registries at import — all of which capture the output paths once.
By exporting ``GERMINATOR_OUTPUT_DIR`` (and the input/model root allowlists) here,
every one of those singletons is constructed against the temp dir from the start,
so the suite never writes ``pytest_*`` artifacts into the real ``./output`` tree.

``server.config`` calls ``load_dotenv()`` with the default ``override=False``, so
these explicit ``os.environ`` assignments win over the values in ``.env``.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import pytest
from pathlib import Path

# Resolve the temp root so it matches the canonical paths used by the storage
# containment checks (macOS puts TMPDIR under /var -> /private/var via symlink).
_TEST_OUTPUT_ROOT = Path(tempfile.mkdtemp(prefix="germ-test-output-")).resolve()

os.environ["GERMINATOR_OUTPUT_DIR"] = str(_TEST_OUTPUT_ROOT)
# Keep input validation scoped to the isolated tree: files placed under the temp
# uploads/audio dirs are accepted, while external paths (other tmp_path dirs the
# tests create to exercise rejection) stay outside the allowlist and are refused.
os.environ["GERMINATOR_ALLOWED_INPUT_ROOTS"] = str(_TEST_OUTPUT_ROOT)
# Preserve the vendored model repo as a valid model root, swapping the real
# output tree for the isolated one.
os.environ["GERMINATOR_ALLOWED_MODEL_ROOTS"] = f"{_TEST_OUTPUT_ROOT},vendor/stable-audio-3"
# The host's heavy-operation lease is shared with a running stack. Tests take their own,
# so they neither wait behind live listening nor hold it up (24 September: the suite ran
# 235 s instead of 8 while a Testing loop listened).
os.environ["LISTENINGSTACK_RESOURCE_DIR"] = str(_TEST_OUTPUT_ROOT / "resources")


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Remove the isolated output tree once the whole session is done."""
    shutil.rmtree(_TEST_OUTPUT_ROOT, ignore_errors=True)


# Match application lifecycle for legacy tests that use TestClient without a context.


@pytest.fixture(autouse=True)
def managed_job_runner():
    from server.registry import job_runner
    job_runner.startup()
    yield
    job_runner.shutdown(wait=True)
