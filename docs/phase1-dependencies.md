# Phase 1 dependency candidate

GERM requires `akousma>=0.8.3` and `akouo-contract>=0.10.0`; its optional spectral
extra requires `akousmata>=0.8.2` on Python >=3.11. Retained covenant policy and
object resolution no longer depend on an undeclared newer editable sibling.

The canonical candidate wheels under `vendor/` are selected by `uv.lock` and
verified by `SHA256SUMS` in CI. `compatibility.json` records their source baseline,
package-input fingerprints and hashes. Current application version 0.6.1 is
unchanged; local candidate wheel hashes distinguish builds. These are not
published package-index releases or a provider/accelerator qualification.

Object reads now pass the record's content hash to the shared resolver.
Explicit external file references remain governed by GERM's existing host
policy. Test owner-separated and composed environments without resyncing an
active owner or changing its memory, credentials, models or generated media.
