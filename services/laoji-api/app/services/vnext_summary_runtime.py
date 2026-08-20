"""Single source of truth for the vNext Facts V3 runtime identity.

The mobile idempotency key, source-stream admission fence, durable chapter
checkpoint, and final artifact must all describe the same implementation.  A
model or prompt rollout therefore creates a new immutable generation instead
of silently reusing or resuming an older one.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.meeting_facts_v3 import PROMPT_REVISION
from app.services.summary_v3_generator import model_revision


HANDLER_REVISION = "summary-facts-v3-chapter-r5"
PROVIDER_ADAPTER_REVISION = "provider-v3-r2"


@dataclass(frozen=True)
class SummaryRuntimeRevision:
    handler_revision: str
    provider_revision: str
    prompt_revision: str
    model_revision: str


def current_summary_runtime_revision() -> SummaryRuntimeRevision:
    return SummaryRuntimeRevision(
        handler_revision=HANDLER_REVISION,
        provider_revision=PROVIDER_ADAPTER_REVISION,
        prompt_revision=PROMPT_REVISION,
        model_revision=model_revision(),
    )
