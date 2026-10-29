# Visionary Tech mark

`visionary-mark.svg` is the editable source for the app identity. Its front-facing geometry and flat navy/teal colors are inferred from the user's oblique wall-sign photograph, not verified official artwork or official color values. Keep the two overlapping straight-sided strokes; do not include the photographed company lettering, wall, glare, perspective or shadow.

The user-adjusted palette is navy `#305978` and teal `#4098A9`, one small step lighter than the first reconstruction. The visible mark itself has a 1:1 bounding box; preserve this independently of square image padding or launcher masks.

Run `node tools/generate-brand-assets.cjs` on Linux or Windows to regenerate the launcher, adaptive/monochrome icon, favicon, splash mark and bottom credit. The existing neutral typeface renders the small credit reproducibly; no additional runtime font is packaged.

The adaptive foreground fits inside Android's 66/108 safe circle. The bottom credit uses the platform 200×80dp branding slot, contains only `created by visionary tech`, and does not introduce a minimum splash duration. Generated PNGs are committed inputs so a normal build does not require the rasterizer.
