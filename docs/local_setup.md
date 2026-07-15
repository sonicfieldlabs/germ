# Local Setup

## Base Server

Install dependencies:

```bash
uv sync --extra dev
```

Run the server:

```bash
./scripts/run_server.sh
```

Check:

```bash
curl http://127.0.0.1:5178/health
```

## Mock Mode

Mock mode is the default. It writes placeholder WAV files and metadata so germ and
the dashboard can be tested before model downloads.

```bash
curl -X POST http://127.0.0.1:5178/generate \
  -H "content-type: application/json" \
  -d '{"provider":"mock","model":"mock-sine","prompt":"dry wood impact","duration":2}'
```

## Official Python Provider

```bash
./scripts/install_python_provider.sh
```

This clones or reuses the official Stable Audio 3 repository under `vendor/` unless
`GERM_OFFICIAL_REPO_DIR` is set. `GERMINATOR_OFFICIAL_REPO_DIR` remains a legacy
fallback. It runs:

```bash
uv sync --extra ui --extra lora
```

inside the official repo and installs this server with the optional Python provider.

Launch the official Gradio UI for manual testing:

```bash
./scripts/run_official_gradio.sh small-sfx
./scripts/run_official_gradio.sh small-music
./scripts/run_official_gradio.sh medium
```

Medium may require CUDA and Flash Attention depending on platform.

### Hugging Face Weight Access

The Stable Audio 3 Python provider uses gated Hugging Face model repositories. The
`hf` CLI can be installed and still fail to download weights if you are not logged
in or have not accepted the Stability AI model terms.

1. Open the model page and accept the terms for the model you want:

   - https://huggingface.co/stabilityai/stable-audio-3-small-sfx
   - https://huggingface.co/stabilityai/stable-audio-3-small-music
   - https://huggingface.co/stabilityai/stable-audio-3-medium

2. Log in from this project environment:

   ```bash
   uv run hf auth login
   ```

3. Download the exact checkpoint. Stable Audio's loader also downloads on first
   use, but an explicit download makes storage and access failures visible before
   a generation job:

   ```bash
   uv run hf download stabilityai/stable-audio-3-small-sfx
   uv run hf download stabilityai/stable-audio-3-small-music
   uv run hf download stabilityai/stable-audio-3-medium
   ```

   Download only the models you intend to use. The Hugging Face API currently
   reports approximately 3.49 GB for each Small post-trained repository and
   10.45 GB for Medium.

4. Start the server and verify access:

   ```bash
   ./launch_germ.command
   curl "http://127.0.0.1:5178/huggingface/status?check_models=true"
   ```

You can run the same check from the dashboard Status section with `HF Check`.

The exact model page controls. At the time of this public-alpha release, the
three pages are gated and identify the Stability AI Community License plus
additional component terms. GERM cannot accept those terms for an operator.

### Guided Listening Stack Install

The separate installer can prepare GERM or both main applications, show the
combined disk and RAM plan, authenticate Hugging Face, download only selected
models, and leave the gateways ready to start:

```bash
curl -fsSL https://raw.githubusercontent.com/sonicfieldlabs/listening-stack/main/install.sh | bash
```

It keeps model caches, state, logs, outputs, and local paths outside this Git
repository.

## Apple Silicon MLX Provider

```bash
./scripts/install_mlx_provider.sh
```

This clones or reuses the official repository, enters `optimized/mlx`, runs:

```bash
./install.sh
```

and performs a short test render:

```bash
./sa3 --prompt "short dry wood impact" --dit sm-sfx --decoder same-s --seconds 2 --out output/test.wav
```

If the repo lives elsewhere:

```bash
export GERM_MLX_REPO_DIR=/path/to/stable-audio-3
```

Long local renders are bounded by `GERM_PROVIDER_TIMEOUT_SECONDS`, which
defaults to 1800 seconds.

## Dashboard

The optimized dashboard is served by the FastAPI sidecar:

```bash
./scripts/run_dashboard.sh
```

Open:

```text
http://127.0.0.1:5178/dashboard
```

This dashboard is plain HTML/CSS/JavaScript, not Gradio. Gradio is only used for the
optional official Stability demo through `scripts/run_official_gradio.sh`.

## Real Model Test Workflow

Open:

```text
http://127.0.0.1:5178/dashboard
```

In the `Status` tab:

1. Click `Diagnostics`.
2. Click `HF Check` if you plan to use the Python provider.
3. Run `mock` + `mock-sine` first.
4. Install the recommended real provider from diagnostics.
5. Restart `./launch_germ.command`.
6. Select the real provider/model and click `Run Model Test`.

The model is actually functioning locally when the test writes a WAV and metadata
with `status: done`.
