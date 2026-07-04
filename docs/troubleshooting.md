# Troubleshooting

## Server Does Not Start

Run:

```bash
uv run python scripts/check_environment.py
```

If `uv` is missing, install uv and rerun setup.

## Python Provider Is Unavailable

`GET /models` will show `stable_audio_python.available=false` when `stable_audio_3`
cannot be imported. Run:

```bash
./scripts/install_python_provider.sh
```

Medium may need CUDA and Flash Attention. Small Music and Small SFX are the safer
first local tests.

If loading a Python model returns `401 Client Error` for a `stabilityai/stable-audio-3-*`
Hugging Face URL, the package is installed but the model repo is gated. Accept the
model terms on Hugging Face and log in with a read token:

```bash
uv run hf auth login
```

Then check from the server:

```bash
curl "http://127.0.0.1:5178/huggingface/status?check_models=true"
```

If the model status is `requires_approval_or_login`, open the corresponding
Hugging Face model page, accept the terms, and rerun the check.

On Apple Silicon, use `stable_audio_mlx` first; it is the verified local route for
this project.

## MLX Provider Is Unavailable

The MLX provider requires Apple Silicon and the official `optimized/mlx/sa3` CLI.

```bash
./scripts/install_mlx_provider.sh
```

If the official repo is outside this project:

```bash
export GERM_MLX_REPO_DIR=/path/to/stable-audio-3
```

## Generation Returns Error Metadata

Generation failures still create metadata under `output/metadata`. Open the JSON and
check `error`, `request`, `stdout`, and `stderr`.

## Dashboard Cannot Reach Server

Start the server first:

```bash
./scripts/run_server.sh
```

Then launch the dashboard:

```bash
./scripts/run_dashboard.sh
```

Confirm the dashboard Server URL is:

```text
http://127.0.0.1:5178
```

## Licensing

Review the relevant Stability AI model license, API terms, and any Hugging Face
access terms before commercial use or redistribution. This project keeps providers
replaceable so local, API, or enterprise backends can be selected according to the
deployment requirements.
