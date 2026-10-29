"""Lossless, bounded wire decoding; immutable Q2 sources remain authoritative."""
from __future__ import annotations

import base64
import json
from typing import Literal
import zlib

from pydantic import BaseModel, ConfigDict, Field

MAX_INLINE_BYTES = 256 * 1024


class CompressedQuestionSources(BaseModel):
    model_config = ConfigDict(extra="forbid")

    encoding: Literal["gzip-base64"]
    uncompressed_bytes: int = Field(strict=True, ge=1, le=MAX_INLINE_BYTES)
    data: str = Field(min_length=1, max_length=4 * ((MAX_INLINE_BYTES + 1026) // 3))

    def decode(self) -> list[dict]:
        try:
            compressed = base64.b64decode(self.data, validate=True)
            decoder = zlib.decompressobj(wbits=31)
            raw = decoder.decompress(compressed, self.uncompressed_bytes + 1)
            if (len(raw) != self.uncompressed_bytes or not decoder.eof
                or decoder.unconsumed_tail or decoder.unused_data):
                raise ValueError("source_codec_size_or_frame_invalid")
            sources = json.loads(raw.decode("utf-8"))
            if not isinstance(sources, list) or not 1 <= len(sources) <= 1_024:
                raise ValueError("source_codec_rows_invalid")
            return sources
        except (ValueError, TypeError, UnicodeError, zlib.error) as error:
            # Neither compressed input nor decoded private text is an error detail.
            raise ValueError("会议问答来源格式无效") from error
