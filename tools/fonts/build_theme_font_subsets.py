#!/usr/bin/env python3
"""Build LaoJi's redistributable, common-Chinese theme font subsets.

The original font binaries are intentionally not copied into the repository.
Pass a directory containing the pinned source files listed in FONT_SPECS. The
generated subsets use LaoJi-specific internal family names because several
upstream licenses reserve their original family names for unmodified fonts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from fontTools import subset
from fontTools.ttLib import TTFont


REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class FontSpec:
    theme_id: str
    source_name: str
    source_file: str
    source_url: str
    source_sha256: str
    family: str
    output_file: str
    collection_index: int | None = None


FONT_SPECS = (
    FontSpec(
        theme_id="neutral",
        source_name="Noto Sans CJK SC Regular",
        source_file="NotoSansCJK-Regular.ttc",
        source_url="https://github.com/notofonts/noto-cjk",
        source_sha256="b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a",
        family="LaojiThemeNeutral",
        output_file="laoji_theme_neutral.ttf",
        collection_index=2,
    ),
    FontSpec(
        theme_id="vivid",
        source_name="ChillRoundF v3.0",
        source_file="ChillRoundF-v3.0.ttf",
        source_url="https://github.com/Warren2060/ChillRound/blob/main/ChillRoundF%20v3.0.ttf",
        source_sha256="7dae804b344f7bc1a1c8426b9515e9b54d7baac3e123263d0bae94d0a305a732",
        family="LaojiThemeVivid",
        output_file="laoji_theme_vivid.ttf",
    ),
    FontSpec(
        theme_id="paper",
        source_name="LXGW WenKai Regular v1.522",
        source_file="LXGWWenKai-Regular-v1.522.ttf",
        source_url="https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf",
        source_sha256="39ad71264b588165b469e35e6afb162a378dacd1f95348160240ba9038ac3009",
        family="LaojiThemePaper",
        output_file="laoji_theme_paper.ttf",
    ),
    FontSpec(
        theme_id="midnight",
        source_name="LXGW Neo ZhiSong Screen 26.08.21",
        source_file="LXGWNeoZhiSongScreen-26.08.21.ttf",
        source_url="https://github.com/lxgw/LxgwNeoXiZhi-Screen/releases/download/26.08.21/LXGWNeoZhiSongScreen.ttf",
        source_sha256="4e071b63ee221e72309ec720259f264024336991d1ee0bce42e80d1fb3855a1c",
        family="LaojiThemeMidnight",
        output_file="laoji_theme_midnight.ttf",
    ),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def gb2312_characters() -> set[str]:
    characters: set[str] = set()
    for lead in range(0xA1, 0xF8):
        for trail in range(0xA1, 0xFF):
            try:
                characters.add(bytes((lead, trail)).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return characters


def characters_from_ranges(ranges: Iterable[tuple[int, int]]) -> set[str]:
    return {chr(codepoint) for start, end in ranges for codepoint in range(start, end + 1)}


def app_authored_characters() -> set[str]:
    characters: set[str] = set()
    roots = (
        REPO_ROOT / "src",
        REPO_ROOT / "modules" / "laoji-native-platform" / "android" / "src" / "main",
    )
    allowed_suffixes = {".ts", ".tsx", ".js", ".kt", ".java", ".xml", ".json"}
    candidates = [REPO_ROOT / "App.tsx", REPO_ROOT / "app.config.js"]
    for root in roots:
        candidates.extend(path for path in root.rglob("*") if path.suffix in allowed_suffixes)
    for path in candidates:
        if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
            continue
        characters.update(path.read_text(encoding="utf-8", errors="ignore"))
    return characters


def required_codepoints() -> set[int]:
    ranges = (
        (0x0020, 0x00FF),  # Latin, digits and common punctuation
        (0x2000, 0x206F),  # General punctuation
        (0x20A0, 0x20CF),  # Currency symbols
        (0x2100, 0x214F),  # Letterlike symbols
        (0x2190, 0x22FF),  # Arrows and mathematical operators
        (0x2460, 0x27BF),  # Enclosed numbers, shapes and dingbats
        (0x3000, 0x303F),  # CJK punctuation
        (0xFF00, 0xFFEF),  # Full-width forms
    )
    characters = gb2312_characters()
    characters.update(characters_from_ranges(ranges))
    characters.update(app_authored_characters())
    return {ord(character) for character in characters}


def rename_font(font: TTFont, family: str) -> None:
    name_table = font["name"]
    overridden_ids = {1, 2, 3, 4, 6, 16, 17, 21, 22}
    name_table.names = [record for record in name_table.names if record.nameID not in overridden_ids]
    postscript_name = family.replace(" ", "")
    unique_name = f"LaoJi theme subset; {family}; Regular"
    for platform_id, encoding_id, language_id in ((3, 1, 0x409), (1, 0, 0)):
        name_table.setName(family, 1, platform_id, encoding_id, language_id)
        name_table.setName("Regular", 2, platform_id, encoding_id, language_id)
        name_table.setName(unique_name, 3, platform_id, encoding_id, language_id)
        name_table.setName(family, 4, platform_id, encoding_id, language_id)
        name_table.setName(postscript_name, 6, platform_id, encoding_id, language_id)
        name_table.setName(family, 16, platform_id, encoding_id, language_id)
        name_table.setName("Regular", 17, platform_id, encoding_id, language_id)
    if "OS/2" in font:
        font["OS/2"].achVendID = "LJUI"


def build_subset(spec: FontSpec, source_root: Path, output_root: Path, unicodes: set[int]) -> dict:
    source = source_root / spec.source_file
    if not source.is_file():
        raise FileNotFoundError(f"missing source font: {source}")
    actual_source_hash = sha256(source)
    if actual_source_hash != spec.source_sha256:
        raise ValueError(
            f"source hash mismatch for {spec.source_file}: "
            f"expected {spec.source_sha256}, got {actual_source_hash}"
        )

    font = TTFont(source, fontNumber=spec.collection_index, recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.name_legacy = True
    options.notdef_glyph = True
    options.notdef_outline = True
    options.recommended_glyphs = True
    options.glyph_names = True
    options.symbol_cmap = True
    options.legacy_cmap = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    rename_font(font, spec.family)

    output_root.mkdir(parents=True, exist_ok=True)
    output = output_root / spec.output_file
    font.save(output, reorderTables=True)
    output_font = TTFont(output, recalcTimestamp=False)
    cmap = output_font.getBestCmap() or {}
    output_font.close()
    font.close()
    return {
        "theme_id": spec.theme_id,
        "family": spec.family,
        "source_name": spec.source_name,
        "source_url": spec.source_url,
        "source_sha256": actual_source_hash,
        "output_file": spec.output_file,
        "output_sha256": sha256(output),
        "byte_size": output.stat().st_size,
        "codepoint_count": len(cmap),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=REPO_ROOT / "assets" / "fonts" / "theme",
    )
    args = parser.parse_args()

    unicodes = required_codepoints()
    records = [build_subset(spec, args.source_root, args.output_root, unicodes) for spec in FONT_SPECS]
    manifest = {
        "schema_version": 1,
        "selection": "GB2312 common Chinese plus LaoJi-authored UI text and common symbols",
        "requested_codepoint_count": len(unicodes),
        "fonts": records,
    }
    manifest_path = args.output_root / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
