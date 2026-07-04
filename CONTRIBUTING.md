# Contributing

germ is licensed under MPL-2.0. By contributing, you agree that your
contribution is provided under the same license.

Keep the local-first contract intact:

- Do not add cloud egress unless it is explicitly opt-in and documented.
- Do not log secrets, tokens, absolute private paths, or raw prompt data beyond
  the local metadata files the user asked germ to create.
- Keep generated audio, uploads, scratch data, and personal `.env` files out of
  git.
- Add or update tests when changing API behavior, metadata lineage, storage, or
  safety limits.
- Update `docs/api_reference.md` when adding, removing, or renaming a FastAPI
  route.

Before proposing a release change, run:

```bash
.venv/bin/pytest -q
.venv/bin/ruff check server tests
node --check dashboard/static/app.js
node --check dashboard/static/dish.js
node --check dashboard/static/micro_forms.js
node --check dashboard/static/micro_render.js
node --check dashboard/static/micro_unicode.js
node --check dashboard/static/ui_utils.js
node --check dashboard/static/wavetable_synth.js
node scripts/smoke_dashboard.mjs
```
