# Contributing to GERM

GERM is a public-alpha cultivation environment and open research release.
Contributions are welcome when they improve its sonic practice, lineage,
provider accountability, safety, accessibility, or reproducibility.

## Begin Here

1. Open an issue before a large graph, API, provider, or storage change.
2. Fork the repository and create a focused branch.
3. Install the model-free development environment:

   ```bash
   uv sync --extra dev
   ```

4. Develop against the mock provider unless the change specifically concerns
   a real provider. Tests and review must not require gated weights or a live
   account.
5. Add tests and public documentation, run the checks below, and describe any
   lineage, storage, network, or licensing effect in the pull request.

Do not commit model weights, generated audio, uploads, credentials, `.env`
files, local paths, private prompts, personal sessions, or provider responses.

Commit messages describe the change and its reason in plain prose. Never add
`Co-Authored-By` lines or any AI attribution trailer: no assistant, tool, or
model is listed as an author, co-author, or contributor. Commits carry the
human author's identity only.

## Contracts to Preserve

- Cloud egress remains explicit, opt-in, and documented.
- Secrets and absolute private paths never enter metadata, lineage, fixtures,
  logs, screenshots, or documentation.
- A generation enters Akousmata only through an explicit remember request.
- Parentage, prompts, models, parameters, mutations, and listening references
  remain inspectable rather than being flattened into one caption.
- Server limits, path containment, and CV/MIDI safety gates remain testable.
- API changes update `docs/api_reference.md`; provider changes update
  `docs/provider_design.md` and model attribution where relevant.

## Scoped Contribution Opportunities

These public-alpha tasks have clear review boundaries:

1. **Provider contract fixtures.** Add a mock or recorded-response fixture that
   exercises readiness, progress, cancellation, error metadata, and output
   validation without a network call or model weights.
2. **Listening Stack round trip.** Extend a test for
   Oída → GERM → Akousmata → Oída so parent identifiers, operation, prompt,
   provider, retention choice, and fresh listening remain intact.
3. **Dashboard accessibility.** Test one complete keyboard and screen-reader
   path through adding a module, configuring it, starting a mock render, and
   opening its result. Include visible focus and reduced-motion behavior.
4. **Reproducible provider report.** Document one exact OS, CPU/GPU, Python,
   provider revision, checkpoint, and short render result. Share metadata and
   license-safe observations, never weights or copyrighted source audio.

Small documentation fixes do not need an issue. Larger tasks should state
acceptance criteria and which contract they touch.

## Local Checks

```bash
uv run pytest -q
uv run ruff check server tests
node --check dashboard/static/app.js
node --check dashboard/static/dish.js
node --check dashboard/static/micro_forms.js
node --check dashboard/static/micro_render.js
node --check dashboard/static/micro_unicode.js
node --check dashboard/static/ui_utils.js
node --check dashboard/static/wavetable_synth.js
node scripts/smoke_dashboard.mjs
```

Use `./launch_germ.command` and the mock provider for a manual dashboard smoke
test. Do not place the resulting runtime data in Git.

## License and Rights

GERM is licensed under MPL-2.0. By submitting a contribution, you confirm that
you have the right to provide it under that license. Third-party code, model
interfaces, fixtures, and media need explicit compatible provenance. See
[models and licensing](docs/models-and-licensing.md) before adding a provider
or checkpoint surface.
