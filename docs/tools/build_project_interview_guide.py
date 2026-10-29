#!/usr/bin/env python3
"""Build the LaoJi project report and visual review artifacts.

Only document outputs are written. No build, service, or device state is changed.
Requires markdown-it-py, weasyprint, and pymupdf; usable on Linux and Windows.
"""
from __future__ import annotations

import argparse
from html import escape
import json
import math
from pathlib import Path
import re

from markdown_it import MarkdownIt
from weasyprint import HTML
import pymupdf as fitz


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/LAOJI_PROJECT_DESIGN_AND_INTERVIEW_GUIDE_ZH.md"
OUTPUT = ROOT / "output/pdf/LAOJI_PROJECT_DESIGN_AND_INTERVIEW_GUIDE_ZH.pdf"
WORK = ROOT / "tmp/pdfs/laoji_report"
INK = "#182d36"
TEAL = "#246e74"
MUTED = "#587079"
TONES = {
    "teal": ("#edf5f3", "#93bbb4"),
    "gold": ("#faf4e7", "#d9c498"),
    "gray": ("#f0f3f4", "#bdcbd0"),
    "rose": ("#faf0ed", "#d5afa6"),
}


class Figure:
    def __init__(self, height: int):
        self.height = height
        self.parts: list[str] = []

    def text(self, x, y, text, size=22, anchor="middle", color=INK, weight=400):
        self.parts.append(
            f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" '
            f'font-weight="{weight}" fill="{color}">{escape(str(text))}</text>'
        )

    def box(self, x, y, w, h, title, subtitle="", tone="teal", size=23):
        fill, stroke = TONES[tone]
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1.3"/>'
        )
        lines = subtitle.split("\n") if subtitle else []
        total = (size + len(lines) * 29)
        baseline = y + (h - total) / 2 + size * .85
        self.text(x + w / 2, baseline, title, size=size, weight=600)
        for i, line in enumerate(lines):
            self.text(x + w / 2, baseline + 31 + i * 29, line, size=20, color=MUTED)

    def arrow(self, points, dashed=False, head=True):
        self.parts.append(
            '<polyline points="' + ' '.join(f'{x},{y}' for x, y in points)
            + f'" fill="none" stroke="{MUTED}" stroke-width="2" '
            + ('stroke-dasharray="6 5" ' if dashed else '')
            + '/>'
        )
        if not head:
            return
        # Draw the arrowhead explicitly. SVG marker orientation differs among
        # PDF renderers and must not reverse the flow of a technical diagram.
        (px, py), (x, y) = points[-2:]
        norm = math.hypot(x-px, y-py)
        ux, uy = (x-px)/norm, (y-py)/norm
        a = (x-11*ux+5*uy, y-11*uy-5*ux)
        b = (x-11*ux-5*uy, y-11*uy+5*ux)
        self.parts.append(f'<polygon points="{x},{y} {a[0]},{a[1]} {b[0]},{b[1]}" fill="{MUTED}"/>')

    def svg(self):
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="760" height="{self.height}" '
            f'viewBox="0 0 760 {self.height}" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif">'
            + ''.join(self.parts) + '</svg>'
        )


def figures():
    out = {}

    def save(key, figure, caption):
        path = WORK / "figures" / f"{key.lower()}.svg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(figure.svg(), encoding="utf-8")
        out[key] = (path.as_uri(), caption)

    f = Figure(202)
    f.box(18, 12, 330, 86, "会议", "保存讨论、笔记与后续事项", size=25)
    f.box(410, 12, 330, 86, "日程", "管理接下来要做的安排", tone="gold", size=25)
    f.arrow([(183,98),(183,140),(575,140),(575,103)])
    f.text(380,183,"用户确认的后续事项可以进入日历",size=22)
    save("PRODUCT",f,"两个主入口，通过用户确认的行动衔接。")

    f = Figure(276)
    for x,title in [(18,"手机录音"),(271,"音视频导入"),(524,"外接录音设备")]:
        f.box(x,12,218,66,title,tone="gray",size=23)
        f.arrow([(x+109,78),(x+109,112),(380,112)],head=False)
    f.arrow([(380,112),(380,143)])
    f.box(122,146,516,85,"一条完整的会议记录","原音频、文字记录与个人笔记",size=24)
    f.text(380,268,"来源不同，后续整理、问答和管理保持一致",size=21)
    save("MEETING",f,"录音来源被整合到同一种资料形态中。")

    f = Figure(260)
    f.box(75,12,610,69,"当前会议资料",tone="gray",size=24)
    f.arrow([(380,81),(380,112)],head=False)
    for x,title,sub,tone in [(18,"阅读整理","集中查看要点","teal"),
                             (271,"继续提问","按问题找回细节","gray"),
                             (524,"后续安排","用户确认后采用","gold")]:
        f.arrow([(380,112),(x+109,112),(x+109,143)])
        f.box(x,146,218,88,title,sub,tone=tone,size=23)
    save("AFTER",f,"同一份会议资料支持阅读、追问和后续行动。")

    f = Figure(274)
    f.box(18,14,270,182,"手机中的个人资料","日程、录音和笔记\n已确认的安排与修改",size=22)
    f.box(472,14,270,182,"智能处理服务","语音理解、整理与问答\n按任务使用必要材料",tone="gold",size=22)
    f.arrow([(288,93),(466,93)])
    f.text(380,73,"必要材料",size=20)
    f.arrow([(472,146),(294,146)])
    f.text(380,179,"结果返回",size=20)
    f.text(380,253,"基本管理在本机完成，智能计算按需要联网",size=21)
    save("DISTRIBUTION",f,"长期资料归属与智能处理的位置分开。")

    f = Figure(257)
    f.text(180,29,"原先：先选择模板",size=22,weight=600)
    for x,y,title in [(18,50,"通用"),(184,50,"单独交流"),
                      (18,127,"项目同步"),(184,127,"访谈")]:
        f.box(x,y,150,59,title,tone="gray",size=21)
    f.arrow([(346,118),(416,118)])
    f.box(427,50,315,136,"现在：统一整理","依据内容组织要点\n有依据时呈现图表",size=23)
    f.text(380,236,"减少重复选择，保留能够帮助理解的信息",size=21)
    save("SUMMARY",f,"从形式分类转向内容驱动的整理。")

    f = Figure(213)
    for i,(title,sub,tone) in enumerate([
        ("先接住输入","录音开始、文件接纳","teal"),
        ("尽早提供内容","文字先到、可以阅读","gold"),
        ("继续完善结果","整理与讲话人信息","gray"),
    ]):
        x=18+i*253
        f.box(x,20,218,105,title,sub,tone=tone,size=22)
        if i<2:f.arrow([(x+218,72),(x+247,72)])
    f.text(380,179,"不必等到全部处理结束，才交付第一份可用内容",size=21)
    save("EXPERIENCE",f,"按用户获得可用内容的时刻观察体验。")
    return out


CSS = """
@page {
  size:A4; margin:18mm 18mm 18mm;
  @top-left {content:"老记 / 项目说明与学术汇报";font-family:"Noto Sans CJK SC",sans-serif;font-size:8pt;color:#718185;}
  @bottom-right {content:counter(page);font-family:"Noto Sans CJK SC",sans-serif;font-size:9pt;color:#246e74;}
}
@page:first {@top-left {content:none;}}
body {font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-size:11.6pt;
  line-height:1.78;color:#182d36;margin:0;}
.page {break-before:page;}
.page:first-child {break-before:auto;}
.eyebrow {font-size:9pt;letter-spacing:.6pt;color:#246e74;margin:0 0 3mm;}
h1 {font-size:22pt;line-height:1.42;font-weight:700;margin:0 0 6mm;}
h3 {font-size:12.6pt;line-height:1.6;margin:5mm 0 2.3mm;break-after:avoid;}
p {margin:0 0 4.3mm;text-align:left;orphans:2;widows:2;}
strong {font-weight:700;color:#163f47;}
figure {margin:5mm 0;break-inside:avoid;}
figure img {width:100%;display:block;}
figcaption {font-size:9.1pt;line-height:1.55;color:#587079;margin-top:2mm;}
a {color:#246e74;text-decoration:none;}
.cover {padding-top:9mm;}
.cover h1 {font-size:46pt;line-height:1.4;margin:13mm 0 5mm;}
.cover .subtitle {font-size:21pt;line-height:1.6;font-weight:500;color:#246e74;margin-bottom:7mm;}
.cover .lead {font-size:14pt;line-height:1.8;}
.cover-rule {height:3px;background:#246e74;margin:9mm 0;}
.cover-bottom {margin-top:10mm;border-top:.7pt solid #ccdcda;padding-top:5mm;color:#587079;font-size:10pt;}
.qa h1 {font-size:22pt;}
.qa h3 {font-size:12.4pt;}
.qa p {font-size:11.5pt;line-height:1.8;margin-bottom:5mm;}
.pitch p {font-size:11.4pt;line-height:1.8;margin-bottom:4.3mm;}
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--render", action="store_true")
    args = parser.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    diagrams = figures()
    content = SOURCE.read_text(encoding="utf-8")
    pattern = re.compile(r"<!-- PAGE: ([^|]+)\|([^|]+)\|([^>]+) -->")
    pieces = pattern.split(content)
    md = MarkdownIt("commonmark", {"html": True}).enable("table")
    pages = []
    fig_count = 0
    for i in range(1, len(pieces), 4):
        key, section, title, text = (v.strip() for v in pieces[i:i+4])
        def figure_html(match):
            nonlocal fig_count
            key = match.group(1)
            uri, caption = diagrams[key]
            fig_count += 1
            caption = re.sub(r"^图 \d+", f"图 {fig_count}", caption)
            return f'<figure><img src="{uri}"/><figcaption>{escape(caption)}</figcaption></figure>'
        text = re.sub(r"\[\[FIGURE:([A-Z]+)\]\]", figure_html, text)
        classes = "page " + ("qa" if key.startswith("qa") else key)
        heading = "" if key == "cover" else f'<div class="eyebrow">{escape(section)}</div><h1>{escape(title)}</h1>'
        pages.append(f'<section id="{key}" class="{classes}">{heading}{md.render(text)}</section>')
    html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' \
        '<title>老记：项目说明与学术汇报</title><meta name="author" content="老记项目">' \
        f'<style>{CSS}</style></head><body>' + ''.join(pages) + '</body></html>'
    (WORK / "guide.html").write_text(html, encoding="utf-8")
    rendered = HTML(string=html, base_url=str(ROOT)).render()
    rendered.write_pdf(OUTPUT, pdf_tags=True)
    pdf = fitz.open(OUTPUT)
    expected = len(pages)
    review = {"source_pages": expected, "pdf_pages": len(pdf), "figures": fig_count,
              "bookmarks": len(pdf.get_toc()), "page_checks": [], "output": str(OUTPUT)}
    for i, page in enumerate(pdf):
        text = page.get_text()
        spans = [span for block in page.get_text("dict")["blocks"] if "lines" in block
                 for line in block["lines"] for span in line["spans"]]
        bad = [s["text"] for s in spans if s["bbox"][0] < 0 or s["bbox"][2] > page.rect.width + 1
               or s["bbox"][1] < 0 or s["bbox"][3] > page.rect.height + 1]
        review["page_checks"].append({"page": i+1, "characters": len(text),
                                      "out_of_page": bad, "replacement_glyph": "\ufffd" in text})
        if args.render:
            folder=WORK / "pages"
            folder.mkdir(exist_ok=True)
            page.get_pixmap(matrix=fitz.Matrix(1.35,1.35)).save(folder/f"page-{i+1:02d}.png")
    (WORK / "verification.json").write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k:v for k,v in review.items() if k != "page_checks"}, ensure_ascii=False))
    if len(pdf) != expected:
        raise SystemExit(f"Page overflow: expected {expected}, rendered {len(pdf)}. Inspect and reflow source.")
    if any(p["out_of_page"] or p["replacement_glyph"] for p in review["page_checks"]):
        raise SystemExit("Text geometry or glyph verification failed.")


if __name__ == "__main__":
    main()
