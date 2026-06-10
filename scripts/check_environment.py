from __future__ import annotations

from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))


def present(value: object) -> str:
    return "yes" if value else "no"


def main() -> int:
    from server.diagnostics import environment_report
    from server.registry import registry, settings

    report = environment_report(settings, registry)
    print("germ Stable Audio 3 local environment")
    print(f"project_root: {PROJECT_ROOT}")
    print(f"python: {report['python']}")
    print(f"platform: {report['platform']}")
    print(f"machine: {report['machine']}")
    print(f"uv: {report['uv'] or 'missing'}")
    for name, ok in report["dependencies"].items():
        print(f"{name}: {present(ok)}")
    print(f"recommended_local_provider: {report['recommended_local_provider']}")
    print(f"official_repo_dir: {report['paths']['official_repo_dir']}")
    print(f"official_repo_exists: {present(report['paths']['official_repo_exists'])}")
    print(f"mlx_cli_dir: {report['paths']['mlx_cli_dir']}")
    print(f"mlx_sa3: {present(report['paths']['mlx_sa3_exists'])}")
    print(f"hf_cli: {report['huggingface']['hf_cli'] or 'missing'}")
    print(f"hf_token_env_present: {present(report['huggingface']['hf_token_env_present'])}")
    if report["missing_for_real_local_models"]:
        print("missing_for_real_local_models:")
        for item in report["missing_for_real_local_models"]:
            print(f"  - {item}")
    print("provider_status:")
    for provider in report["providers"]:
        print(
            f"  - {provider['id']}: available={provider['available']} "
            f"device={provider['device']} detail={provider.get('detail')}"
        )
    print("output_dirs:")
    for child in ["output/audio", "output/metadata", "output/uploads"]:
        path = PROJECT_ROOT / child
        path.mkdir(parents=True, exist_ok=True)
        print(f"  {child}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
