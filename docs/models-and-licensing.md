# Models and Licensing

GERM starts with a mock provider that needs no model. Stable Audio 3 code,
weights, hosted services, LoRAs, datasets, and accounts are optional operator
choices and are not bundled in this repository.

## Repository License

GERM source code is licensed under MPL-2.0. That license covers this
repository's code. It does not grant rights to third-party models, datasets,
source recordings, provider services, or generated material.

## Stable Audio 3 Code and Weights

The optional Python provider references the official
[Stable Audio 3 repository](https://github.com/Stability-AI/stable-audio-3).
Its repository [code license](https://github.com/Stability-AI/stable-audio-3/blob/main/LICENSE)
is MIT at the time of this release.

Stable Audio 3 model weights are separately licensed. For example, the
[Stable Audio 3 Small SFX model card](https://huggingface.co/stabilityai/stable-audio-3-small-sfx)
identifies the Stability AI Community License and may identify additional
component terms. Some checkpoints are gated. The upstream model card and terms
for the exact checkpoint always control.

GERM does not redistribute weights or accept upstream terms for the operator.
Before installing a model:

- review the code, weight, component, dataset, and commercial-use terms;
- record the exact checkpoint and revision used;
- confirm that the hardware and dependency combination is supported upstream;
- retain any attribution or notice required for publication or distribution.

The MLX installer prepares the official provider path on Apple Silicon; it
does not change the model's license.

## Stability API and Other Providers

The Stability API route is opt-in and uses an operator-supplied key. Service
terms, availability, credit use, retention, and content rules are separate
from GERM. Requests can include prompts and source audio, so enable it only
after deciding that transfer is appropriate.

LoRAs and future adapters can have their own licenses and training-data
constraints. GERM's Strain registry records declared identity, strength,
tags, license, and provenance, but it cannot verify that a declaration is
correct.

## Audio and Research Outputs

GERM does not determine ownership of input recordings, prompts, generated
audio, lineage notes, or research exports. Operators are responsible for
consent, provenance, attribution, and the rights required to create, store,
perform, publish, or redistribute them.

Use [CITATION.cff](../CITATION.cff) to cite GERM. Cite the exact model,
checkpoint, provider, and relevant upstream release separately when they
contributed to a result.
