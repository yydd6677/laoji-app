# vNext contracts

`services/laoji-api/app/schemas/vnext_contracts.py` and the existing Facts V3
Pydantic models are the server-side schema sources for Stage 0. The generator
produces deterministic JSON Schema plus TypeScript/Kotlin revision manifests.

```text
PYTHONPATH=services/laoji-api .venv-vnext/bin/python contracts/vnext/generate.py
PYTHONPATH=services/laoji-api .venv-vnext/bin/python contracts/vnext/generate.py --check
```

Generated files are build artifacts. No contract contains meeting samples,
credentials, source text, or model-specific answers. Domain API implementation,
mobile repositories, and database migrations consume these contracts in later
stages; the schemas do not become a second business-state owner.
