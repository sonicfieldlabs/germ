# Runtime dependencies

GERM requires `akousma>=0.8.3` and `akouo-contract>=0.10.0`. Its optional spectral
extra requires `akousmata>=0.8.2` on Python >=3.11. Retained covenant policy and
checked object resolution are supplied by those declared dependencies.

`uv.lock` selects the canonical wheels under `vendor/`. `SHA256SUMS` and
`compatibility.json` record their hashes and source baselines. Verify the bytes
before installation. A minimum version is not evidence that an artifact contains
later source fixes; changed owners require rebuilt artifacts and fresh checks.

Object reads pass the record's content hash to the shared resolver. External file
references remain governed by GERM's host policy. Check separate and composed
owners without resyncing an active owner or changing its memory, credentials,
models or generated media.

The optional Python provider selects Stable Audio 3 at immutable upstream commit
`fa5ee841dd49bae0fa361fac26904adc27fd400e`. The manifest, lock and source-review
entry must agree. `scripts/audit_dependencies.py` audits registry transitive
dependencies and separately records the unindexed Git source review.

Optional Torch exceptions in `advisory-exceptions.json` expire automatically.
They do not establish model or accelerator qualification, fix a vulnerability,
or admit untrusted model artifacts. Re-review before enabling those runtimes or
changing their dependency pair, source identity or trust boundary.
