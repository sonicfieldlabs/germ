from __future__ import annotations

import argparse
from pathlib import Path

import httpx


DEFAULT_BASE_URL = "http://127.0.0.1:5178"


class GerminatorClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: float = 600.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(timeout=timeout)

    def health(self) -> dict:
        return self.client.get(f"{self.base_url}/health").raise_for_status().json()

    def models(self) -> dict:
        return self.client.get(f"{self.base_url}/models").raise_for_status().json()

    def diagnostics(self) -> dict:
        return self.client.get(f"{self.base_url}/diagnostics").raise_for_status().json()

    def huggingface_status(self, *, check_models: bool = False) -> dict:
        response = self.client.get(
            f"{self.base_url}/huggingface/status",
            params={"check_models": str(check_models).lower()},
        )
        return response.raise_for_status().json()

    def submit_job(self, mode: str, request: dict) -> dict:
        payload = {"mode": mode, "request": request}
        return self.client.post(f"{self.base_url}/jobs/submit", json=payload).raise_for_status().json()

    def job(self, job_id: str) -> dict:
        return self.client.get(f"{self.base_url}/jobs/{job_id}").raise_for_status().json()

    def generate(
        self,
        prompt: str,
        *,
        provider: str = "mock",
        model: str = "mock-sine",
        duration: float = 4.0,
        seed: int = -1,
        output_name: str | None = None,
    ) -> dict:
        payload = {
            "provider": provider,
            "model": model,
            "prompt": prompt,
            "duration": duration,
            "seed": seed,
            "output_name": output_name,
        }
        return self.client.post(f"{self.base_url}/generate", json=payload).raise_for_status().json()

    def audio_to_audio(
        self,
        input_audio_path: str | Path,
        prompt: str,
        *,
        provider: str = "mock",
        model: str = "mock-sine",
        duration: float = 4.0,
        init_noise_level: float = 0.45,
    ) -> dict:
        payload = {
            "provider": provider,
            "model": model,
            "prompt": prompt,
            "input_audio_path": str(input_audio_path),
            "duration": duration,
            "init_noise_level": init_noise_level,
        }
        return self.client.post(f"{self.base_url}/audio-to-audio", json=payload).raise_for_status().json()

    def inpaint(
        self,
        input_audio_path: str | Path,
        prompt: str,
        ranges: list[tuple[float, float]],
        *,
        provider: str = "mock",
        model: str = "mock-sine",
        duration: float = 8.0,
    ) -> dict:
        payload = {
            "provider": provider,
            "model": model,
            "prompt": prompt,
            "input_audio_path": str(input_audio_path),
            "inpaint_ranges": ranges,
            "duration": duration,
        }
        return self.client.post(f"{self.base_url}/inpaint", json=payload).raise_for_status().json()

    def continue_audio(
        self,
        input_audio_path: str | Path,
        prompt: str,
        *,
        source_duration: float,
        target_duration: float,
        provider: str = "mock",
        model: str = "mock-sine",
    ) -> dict:
        payload = {
            "provider": provider,
            "model": model,
            "prompt": prompt,
            "input_audio_path": str(input_audio_path),
            "source_duration": source_duration,
            "target_duration": target_duration,
            "duration": target_duration,
        }
        return self.client.post(f"{self.base_url}/continue", json=payload).raise_for_status().json()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--prompt", default="short dry wood impact, close microphone")
    parser.add_argument("--provider", default="mock")
    parser.add_argument("--model", default="mock-sine")
    args = parser.parse_args()

    client = GerminatorClient(args.base_url)
    print(client.health())
    print(client.generate(args.prompt, provider=args.provider, model=args.model))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
