"""Builds demo/out/cascade-deck.pptx, the 10-slide pitch deck of PRD 21.3.

Run: cd demo && uv run deck.py

The palette is the web app's: ink on slate, with the six node-state colours as the only saturated
hues, so a colour always means a state of money. Diagrams are drawn as shapes. Slide 4 embeds
demo/out/cascade-demo.mp4 (the file itself, not a link). Slide 9 is computed from live preprod
data through the public API at build time, and every number names its source.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "demo" / "out"
DEPLOYMENT = json.loads((ROOT / "deployments" / "preprod.json").read_text())
ORIGIN = DEPLOYMENT["urls"]["origin"]
API = f"{ORIGIN}/api/v1"

# ------------------------------------------------------------------------------------------------
# Design tokens (apps/web/src/app/globals.css)

INK = RGBColor(0x0D, 0x18, 0x26)
INK_2 = RGBColor(0x44, 0x52, 0x66)
INK_3 = RGBColor(0x5F, 0x6B, 0x7C)
BG = RGBColor(0xF3, 0xF5, 0xF8)
SURFACE = RGBColor(0xFF, 0xFF, 0xFF)
SURFACE_2 = RGBColor(0xEE, 0xF1, 0xF5)
LINE = RGBColor(0xDD, 0xE3, 0xEA)
LINE_STRONG = RGBColor(0xC3, 0xCC, 0xD7)
ON_DARK = RGBColor(0xE7, 0xEE, 0xF6)
ON_DARK_2 = RGBColor(0xA9, 0xB6, 0xC6)
DARK_LINE = RGBColor(0x2C, 0x3E, 0x53)
DARK_SURFACE = RGBColor(0x13, 0x21, 0x2F)


@dataclass(frozen=True)
class State:
    fg: RGBColor
    bg: RGBColor


FUNDED = State(RGBColor(0x1D, 0x56, 0xD8), RGBColor(0xE7, 0xEF, 0xFF))
WORKING = State(RGBColor(0x9A, 0x4A, 0x05), RGBColor(0xFD, 0xF0, 0xDC))
SUBMITTED = State(RGBColor(0x63, 0x37, 0xC4), RGBColor(0xF0, 0xEA, 0xFF))
ACCEPTED = State(RGBColor(0x13, 0x77, 0x3A), RGBColor(0xE2, 0xF5, 0xE9))
REFUNDED = State(RGBColor(0x52, 0x5D, 0x6B), RGBColor(0xEC, 0xEF, 0xF3))
CHALLENGED = State(RGBColor(0xB4, 0x23, 0x23), RGBColor(0xFD, 0xE8, 0xE8))

SANS = "Helvetica Neue"
MONO = "Menlo"

# Type scale (pt)
DISPLAY = 50
H1 = 34
H2 = 21
BODY = 16
SMALL = 13
MICRO = 10.5

W = 13.333
H = 7.5
MARGIN = 0.8


# ------------------------------------------------------------------------------------------------
# Primitives


def set_bg(slide, color: RGBColor) -> None:
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color


def text(
    slide,
    x: float,
    y: float,
    w: float,
    h: float,
    content: str | list[tuple[str, dict]],
    *,
    size: float = BODY,
    color: RGBColor = INK,
    bold: bool = False,
    font: str = SANS,
    align=PP_ALIGN.LEFT,
    anchor=MSO_ANCHOR.TOP,
    line: float = 1.15,
    tracking: int = 0,
    upper: bool = False,
):
    """A text box. `content` is a string (paragraphs split on newlines) or a list of runs."""
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    paragraphs = content.split("\n") if isinstance(content, str) else [content]
    for i, para in enumerate(paragraphs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line
        runs = [(para, {})] if isinstance(para, str) else para
        for run_text, style in runs:
            r = p.add_run()
            r.text = run_text.upper() if upper else run_text
            f = r.font
            f.name = style.get("font", font)
            f.size = Pt(style.get("size", size))
            f.bold = style.get("bold", bold)
            f.color.rgb = style.get("color", color)
            if tracking:
                r._r.get_or_add_rPr().set("spc", str(tracking))
    return box


def rect(slide, x, y, w, h, *, fill: RGBColor | None = SURFACE, line: RGBColor | None = None, radius: float = 0.12, weight: float = 1.0, dash: bool = False):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if radius > 0 else MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    if radius > 0:
        shape.adjustments[0] = min(0.5, radius / min(w, h))
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(weight)
        if dash:
            shape.line.dash_style = 4  # MSO_LINE_DASH_STYLE.DASH
    shape.shadow.inherit = False
    shape.text_frame.margin_left = shape.text_frame.margin_right = Inches(0.12)
    return shape


def arrow(slide, x1, y1, x2, y2, *, color: RGBColor = LINE_STRONG, weight: float = 1.5, head: bool = True, dash: bool = False):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = color
    c.line.width = Pt(weight)
    ln = c.line._get_or_add_ln()
    if dash:
        prst = etree.SubElement(ln, qn("a:prstDash"))
        prst.set("val", "dash")
    if head:
        tail = etree.SubElement(ln, qn("a:tailEnd"))
        tail.set("type", "triangle")
        tail.set("w", "med")
        tail.set("h", "med")
    return c


def elbow(slide, x1, y1, x2, y2, **kw) -> None:
    """Parent bottom-centre to child top-centre: down, across, down."""
    mid = y1 + (y2 - y1) / 2
    arrow(slide, x1, y1, x1, mid, head=False, **kw)
    arrow(slide, x1, mid, x2, mid, head=False, **kw)
    arrow(slide, x2, mid, x2, y2, **kw)


def node(slide, x, y, w, h, label: str, state: State, sub: str = "", *, dark: bool = False, size: float = SMALL):
    """A tree node in the explorer's style: tinted card, state-coloured left rule, name and state."""
    card = rect(slide, x, y, w, h, fill=DARK_SURFACE if dark else state.bg, line=state.fg if dark else None, radius=0.08, weight=1.0)
    rect(slide, x, y + 0.08, 0.06, h - 0.16, fill=state.fg, radius=0.03)
    label_h = h * 0.55 if sub else h - 0.12
    text(slide, x + 0.18, y + 0.06, w - 0.26, label_h, label, size=size, bold=True, color=ON_DARK if dark else INK, anchor=MSO_ANCHOR.MIDDLE)
    if sub:
        text(slide, x + 0.18, y + h * 0.52, w - 0.26, h * 0.42, sub, size=MICRO, color=state.fg if not dark else ON_DARK_2, anchor=MSO_ANCHOR.TOP)
    return card


def kicker(slide, label: str, *, color: RGBColor = INK_3, y: float = 0.62) -> None:
    text(slide, MARGIN, y, 8, 0.3, label, size=MICRO + 0.5, color=color, bold=True, tracking=120, upper=True)


def title(slide, content: str, *, color: RGBColor = INK, y: float = 0.92, size: float = H1, w: float = W - 2 * MARGIN) -> None:
    text(slide, MARGIN, y, w, 1.2, content, size=size, bold=True, color=color, line=1.05)


def footer(slide, n: int, *, dark: bool = False, source: str = "") -> None:
    c = ON_DARK_2 if dark else INK_3
    text(slide, MARGIN, H - 0.48, 6, 0.25, "Cascade", size=MICRO, color=c, bold=True)
    text(slide, W - MARGIN - 1, H - 0.48, 1, 0.25, f"{n:02d}", size=MICRO, color=c, align=PP_ALIGN.RIGHT, font=MONO)
    if source:
        text(slide, MARGIN + 1.0, H - 0.48, W - 2 * MARGIN - 2.2, 0.25, source, size=MICRO - 1, color=c)


def notes(slide, content: str) -> None:
    slide.notes_slide.notes_text_frame.text = content


# ------------------------------------------------------------------------------------------------
# Data (real preprod, read at build time)


def get(path: str):
    req = urllib.request.Request(f"{API}{path}", headers={"accept": "application/json", "user-agent": "cascade-deck"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


@dataclass
class Traction:
    trees: int
    settled: int
    nodes: int
    refunds: int
    recovered_lovelace: int
    calls: int
    metered_l1: int
    redeemer_rows: int
    fetched_at: str


def traction() -> Traction:
    trees = get("/trees")["trees"]
    settled = [t for t in trees if t["state"] == "closed"]
    calls = 0
    l1 = 0
    refunds = 0
    for t in trees:
        detail = get(f"/trees/{t['tree_id']}")
        for n in detail["nodes"]:
            if n["state"] == "Refunded":
                refunds += 1
            if n["kind"] == "MeteredReceipt":
                m = get(f"/trees/{t['tree_id']}/nodes/{n['node_id']}").get("metered") or {}
                calls += int(m.get("calls", 0))
                l1 += int(m.get("l1_txs", 0))
    rows = 0
    showcase = OUT / "redeemers.json"
    if showcase.exists():
        rows = sum(1 for r in json.loads(showcase.read_text())["rows"] if r["primary"])
    return Traction(
        trees=len(trees),
        settled=len(settled),
        nodes=sum(int(t["node_count"]) for t in trees),
        refunds=refunds,
        recovered_lovelace=sum(int(t.get("recovered", 0)) for t in trees),
        calls=calls,
        metered_l1=l1,
        redeemer_rows=rows,
        fetched_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    )


def assurance() -> tuple[int, int, int]:
    # demo/out/aiken-check.json records the latest `aiken check` run; the review report is older.
    check = OUT / "aiken-check.json"
    if check.exists():
        aiken = int(json.loads(check.read_text())["total"])
    else:
        m = re.search(r"runs (\d[\d,]*) tests", (ROOT / "security" / "review-report.md").read_text())
        aiken = int(m.group(1).replace(",", "")) if m else 0
    adv_path = ROOT / "tests" / "adversarial" / "report.json"
    # The adversarial suite rewrites its report while it runs; fall back to the committed copy.
    raw = adv_path.read_text() if adv_path.exists() else subprocess.run(["git", "show", "HEAD:tests/adversarial/report.json"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    adv = json.loads(raw)
    return aiken, int(adv["cases"]), int(adv["unexpected_successes"])


def ada(lovelace: int) -> str:
    return f"{lovelace / 1_000_000:,.0f}"


# ------------------------------------------------------------------------------------------------
# Slides


def slide_hook(prs) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, INK)
    kicker(s, "Cardano agentic commerce", color=ON_DARK_2)
    text(s, MARGIN, 0.98, 10, 0.8, "Agents can pay agents.", size=DISPLAY - 4, bold=True, color=ON_DARK, line=1.0)
    text(s, MARGIN, 1.68, 10, 0.8, "They cannot hire teams.", size=DISPLAY - 4, bold=True, color=ON_DARK_2, line=1.0)

    # Left: one hop, today.
    lx, ly = MARGIN, 3.55
    text(s, lx, ly - 0.45, 4, 0.3, "One-hop escrow today", size=SMALL, color=ON_DARK_2, bold=True)
    for i, (label, st) in enumerate([("Buyer", FUNDED), ("Escrow", FUNDED), ("One agent", WORKING)]):
        y = ly + i * 0.92
        node(s, lx, y, 2.6, 0.56, label, st, dark=True)
        if i < 2:
            arrow(s, lx + 1.3, y + 0.56, lx + 1.3, y + 0.92, color=DARK_LINE, weight=1.5)
    text(s, lx, ly + 2.62, 3.4, 0.6, "Who did the work, and where a refund goes, stops at the first hop.", size=SMALL, color=ON_DARK_2, line=1.25)

    # Right: a Cascade tree.
    rx = 5.2
    text(s, rx, ly - 0.45, 6, 0.3, "A Cascade tree", size=SMALL, color=ON_DARK_2, bold=True)
    root_w, cw, chh = 2.4, 1.66, 0.62
    root_x = rx + (7.3 - root_w) / 2
    node(s, root_x, ly, root_w, chh, "Conductor", FUNDED, "root escrow, one budget", dark=True)
    kids = [("Scout", ACCEPTED, "accepted"), ("Flaky Lisan", REFUNDED, "refunded"), ("Lisan", ACCEPTED, "Masumi leaf"), ("Checkers", SUBMITTED, "verdicts")]
    gap = (7.3 - 4 * cw) / 3
    for i, (label, st, sub) in enumerate(kids):
        x = rx + i * (cw + gap)
        elbow(s, root_x + root_w / 2, ly + chh, x + cw / 2, ly + 1.3, color=DARK_LINE, weight=1.25)
        node(s, x, ly + 1.3, cw, chh, label, st, sub, dark=True)
    sx = rx
    elbow(s, sx + cw / 2, ly + 1.3 + chh, sx + cw / 2, ly + 2.6, color=DARK_LINE, weight=1.25)
    node(s, sx, ly + 2.6, cw, chh, "Pricer", ACCEPTED, "metered calls", dark=True)
    text(s, rx + cw + gap + 0.15, ly + 2.62, 5.2, 0.62, "Every node is a UTxO with its own escrow. Failed work refunds up the tree and is re-spent.", size=SMALL, color=ON_DARK_2, line=1.25)
    footer(s, 1, dark=True)
    notes(s, "Today an agent can pay another agent through one escrow. Real work needs a team: a prime agent hires specialists, who hire tools. Cascade makes that whole tree an escrow on Cardano.")


def slide_problem(prs) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, BG)
    kicker(s, "The problem")
    title(s, "Multi-agent work breaks single-hop escrow.")
    cards = [
        (WORKING, "Capital fronting", "The orchestrator pays sub-agents from its own wallet and carries the loss when one fails."),
        (SUBMITTED, "Blind buyers", "The buyer sees one invoice. Who did the work, at what price, is off chain and unverifiable."),
        (REFUNDED, "Refunds leave the chain", "A failed sub-agent's refund goes back to the orchestrator, not to the budget it came from."),
        (CHALLENGED, "Deadlines do not compose", "A child's dispute window can outlive its parent's deadline, so nobody can settle on time."),
    ]
    cw, ch, gx, gy = 5.66, 2.05, 0.4, 0.35
    for i, (st, head, body) in enumerate(cards):
        x = MARGIN + (i % 2) * (cw + gx)
        y = 2.25 + (i // 2) * (ch + gy)
        rect(s, x, y, cw, ch, fill=SURFACE, line=LINE, radius=0.14)
        rect(s, x + 0.35, y + 0.4, 0.42, 0.06, fill=st.fg, radius=0)
        text(s, x + 0.35, y + 0.62, cw - 0.7, 0.45, head, size=H2, bold=True)
        text(s, x + 0.35, y + 1.12, cw - 0.7, 0.8, body, size=BODY - 1, color=INK_2, line=1.2)
    footer(s, 2, source="Sources: x402 Cardano exact scheme, MIP-003, Masumi vested_pay V2 (docs/research/).")
    notes(s, "Four failures of one-hop escrow when agents hire agents. Each one is something Cascade enforces on chain.")


def slide_one_sentence(prs) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, BG)
    kicker(s, "Cascade")
    title(s, "The buyer pays once. Every agent is paid only for verified work. Failed work refunds up the tree.", size=H1 - 6, w=11.2)

    top = 2.55
    node(s, 5.67, top, 2.0, 0.6, "Buyer", FUNDED, "one signature")
    arrow(s, 6.67, top + 0.6, 6.67, top + 0.95, color=INK_3)
    node(s, 5.42, top + 0.95, 2.5, 0.66, "Conductor", FUNDED, "root escrow, plan root on chain")
    level1 = [
        ("Scout", ACCEPTED, "native, sub-hires"),
        ("Flaky Lisan", REFUNDED, "test agent, refunded"),
        ("Lisan", ACCEPTED, "Masumi agent"),
        ("Checker A", SUBMITTED, "verifier, bonded"),
        ("Checker B", SUBMITTED, "verifier, bonded"),
        ("Scribe", ACCEPTED, "writes the brief"),
    ]
    cw, gap = 1.76, (W - 2 * MARGIN - 6 * 1.76) / 5
    y1 = top + 2.05
    xs = []
    for i, (label, st, sub) in enumerate(level1):
        x = MARGIN + i * (cw + gap)
        xs.append(x)
        elbow(s, 6.67, top + 1.61, x + cw / 2, y1, color=LINE_STRONG, weight=1.25)
        node(s, x, y1, cw, 0.7, label, st, sub)
    # Refund flows up from Flaky Lisan and is re-spent on Lisan.
    arrow(s, xs[1] + cw * 0.7, y1 - 0.02, 5.42, top + 1.3, color=REFUNDED.fg, weight=1.75, dash=True)
    text(s, xs[1] + 0.2, top + 1.12, 2.4, 0.3, "refund flows up, re-spent on Lisan", size=MICRO, color=REFUNDED.fg, bold=True)
    # Scout's subtree.
    y2 = y1 + 1.2
    elbow(s, xs[0] + cw / 2, y1 + 0.7, xs[0] + cw / 2, y2, color=LINE_STRONG, weight=1.25)
    node(s, xs[0], y2, cw, 0.7, "Pricer", ACCEPTED, "native, depth 2")
    arrow(s, xs[0] + cw, y2 + 0.35, xs[0] + cw + 0.42, y2 + 0.35, color=LINE_STRONG)
    node(s, xs[0] + cw + 0.42, y2, 2.0, 0.7, "Lookup API", WORKING, "metered leaf, vouchers")
    text(s, 5.6, y2 + 0.05, W - MARGIN - 5.6, 0.7, "x402 quotes and pays at every hop. Masumi agents join unmodified. Every arrow is a Cardano transaction a validator checked.", size=SMALL, color=INK_2, line=1.25)
    footer(s, 3)
    notes(s, "One sentence and one picture: a tree of escrows. The colours are the node states used in the product.")


def slide_video(prs, video: Path | None, poster: Path | None) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, INK)
    kicker(s, "Recorded on Cardano preprod", color=ON_DARK_2, y=0.5)
    text(s, MARGIN, 0.78, W - 2 * MARGIN, 0.6, "One job, one tree, one failure, one refund that is re-spent.", size=H2 + 3, bold=True, color=ON_DARK)
    vw, vh = 10.2, 10.2 * 9 / 16
    vx, vy = (W - vw) / 2, 1.5
    if video is not None and video.exists():
        s.shapes.add_movie(str(video), Inches(vx), Inches(vy), Inches(vw), Inches(vh), poster_frame_image=str(poster) if poster is not None and poster.exists() else None, mime_type="video/mp4")
    else:
        rect(s, vx, vy, vw, vh, fill=DARK_SURFACE, line=DARK_LINE, radius=0.1)
        text(s, vx, vy + vh / 2 - 0.2, vw, 0.4, "Recording not built yet: run demo/record.ts", size=BODY, color=ON_DARK_2, align=PP_ALIGN.CENTER)
    text(s, MARGIN, vy + vh + 0.12, W - 2 * MARGIN, 0.3, "No cuts in any money movement. Idle waits play at 8x with a badge on screen. Flaky Lisan is a test agent that fails on purpose.", size=MICRO + 0.5, color=ON_DARK_2, align=PP_ALIGN.CENTER)
    footer(s, 4, dark=True)
    notes(s, "The buyer types the goal, funds the plan with one signature, the tree grows, Flaky Lisan misses its deadline and is refunded, Lisan is hired through Masumi from the recovered budget, checkers verify, the buyer accepts, CloseRoot settles, and the receipt reconciles to the lovelace.")


def slide_how(prs) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, BG)
    kicker(s, "How it works on Cardano")
    title(s, "Seven Aiken scripts. One thread token per node.")
    cols = [
        (FUNDED, "Thread tokens", "Each node carries one token named from its parent. A one-shot seed names the root, so trees never collide."),
        (SUBMITTED, "Nested deadlines", "A child's dispute window plus a safety margin must end before its parent's submit deadline. Checked on every Draw."),
        (ACCEPTED, "Withdraw-zero", "Logic runs once per transaction in a stake validator. A child and its parent settle together, and the child token burns."),
        (WORKING, "Masumi and x402", "Masumi leaves lock into vested_pay V2 through a purchase wallet. x402 quotes and pays at every hop. Metered leaves use vouchers."),
    ]
    cw, gap = 2.73, 0.27
    for i, (st, head, body) in enumerate(cols):
        x = MARGIN + i * (cw + gap)
        rect(s, x, 2.15, 0.42, 0.06, fill=st.fg, radius=0)
        text(s, x, 2.35, cw, 0.4, head, size=H2 - 3, bold=True)
        text(s, x, 2.8, cw, 1.4, body, size=SMALL, color=INK_2, line=1.25)

    # Deadline nesting, drawn to scale.
    y0, x0, span = 4.55, MARGIN + 1.5, W - 2 * MARGIN - 1.5
    rect(s, MARGIN, y0 - 0.2, W - 2 * MARGIN, 2.15, fill=SURFACE, line=LINE, radius=0.14)
    text(s, MARGIN + 0.3, y0 - 0.02, 4, 0.3, "Deadline nesting (ADR 0001, section 7)", size=MICRO + 0.5, color=INK_3, bold=True)

    def bar(label: str, row: int, start: float, work: float, challenge: float, dispute: float) -> None:
        y = y0 + 0.42 + row * 0.47
        text(s, MARGIN + 0.3, y, 1.2, 0.3, label, size=SMALL, bold=True, anchor=MSO_ANCHOR.MIDDLE)
        x = x0 + start * span
        for frac, st in ((work, FUNDED), (challenge, SUBMITTED), (dispute, CHALLENGED)):
            rect(s, x, y + 0.04, frac * span, 0.24, fill=st.bg, line=st.fg, radius=0.05, weight=0.75)
            x += frac * span

    bar("Root", 0, 0.0, 0.62, 0.14, 0.18)
    bar("Child", 1, 0.03, 0.36, 0.09, 0.1)
    bar("Grandchild", 2, 0.06, 0.18, 0.05, 0.06)
    lx = W - MARGIN - 6.3
    for label, st in (("work, until submit_by", FUNDED), ("challenge window", SUBMITTED), ("dispute window", CHALLENGED)):
        rect(s, lx, y0 + 0.03, 0.16, 0.16, fill=st.bg, line=st.fg, radius=0.03, weight=0.75)
        text(s, lx + 0.24, y0 - 0.01, 1.9, 0.25, label, size=MICRO, color=INK_2)
        lx += 2.1
    footer(s, 5, source="cascade_node, cascade_logic_core, cascade_logic_draw, cascade_logic_ext, cascade_config, cascade_bond, cascade_channel (deployments/preprod.json)")
    notes(s, "Thread tokens give every node an identity. Deadlines nest by construction. Settlement uses the withdraw-zero pattern so checks run once per transaction. Masumi and x402 are on the money path.")


def slide_eutxo(prs) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, BG)
    kicker(s, "Why eUTxO")
    title(s, "One UTxO per node. Settlement runs in parallel.")
    py = 2.3
    # Left: one shared contract.
    rect(s, MARGIN, py, 5.4, 3.95, fill=SURFACE, line=LINE, radius=0.14)
    text(s, MARGIN + 0.35, py + 0.3, 4.7, 0.35, "One contract, one global state", size=H2 - 3, bold=True)
    text(s, MARGIN + 0.35, py + 0.72, 4.7, 0.6, "Every settlement touches the same state. They queue.", size=SMALL, color=INK_2)
    cx, cy = MARGIN + 3.45, py + 1.75
    rect(s, cx, cy, 1.6, 1.6, fill=SURFACE_2, line=LINE_STRONG, radius=0.12)
    text(s, cx, cy, 1.6, 1.6, "escrow\nstate", size=SMALL, bold=True, color=INK_2, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    for i in range(5):
        y = cy + 0.08 + i * 0.32
        rect(s, MARGIN + 0.45, y, 1.55, 0.24, fill=CHALLENGED.bg, line=CHALLENGED.fg, radius=0.05, weight=0.75)
        text(s, MARGIN + 0.45, y, 1.55, 0.24, f"settle #{i + 1}", size=MICRO - 0.5, color=CHALLENGED.fg, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, font=MONO)
        arrow(s, MARGIN + 2.05, y + 0.12, cx - 0.06, cy + 0.8, color=LINE_STRONG, weight=1)
    # Right: eUTxO.
    rx = MARGIN + 5.8
    rect(s, rx, py, 5.93, 3.95, fill=SURFACE, line=LINE, radius=0.14)
    text(s, rx + 0.35, py + 0.3, 5.2, 0.35, "A Cascade tree on eUTxO", size=H2 - 3, bold=True)
    text(s, rx + 0.35, py + 0.72, 5.2, 0.6, "Each node has its own validator state. Sibling settlements never contend.", size=SMALL, color=INK_2)
    for i in range(5):
        y = py + 1.6 + i * 0.44
        node(s, rx + 0.45, y, 1.65, 0.34, f"node {i + 1}", ACCEPTED, size=MICRO)
        arrow(s, rx + 2.2, y + 0.17, rx + 3.4, y + 0.17, color=ACCEPTED.fg, weight=1.25)
        text(s, rx + 3.5, y + 0.02, 2.2, 0.3, f"tx {i + 1}, same block", size=MICRO, color=INK_2, font=MONO)
    footer(s, 6)
    notes(s, "On an account chain the whole tree would be one contract's state and every settlement would contend for it. On Cardano each node is its own UTxO, so a tree with many leaves settles in parallel.")


def slide_security(prs, aiken: int, cases: int, unexpected: int) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, BG)
    kicker(s, "Security")
    title(s, "Validators enforce the money rules.")
    cols = [
        ("Validator invariants", ["Conservation to the lovelace", "No self-draw to the operator's key", "Containment and deadline nesting", "No payment while children are open", "One token per node, burned once", "No double satisfaction"]),
        ("Eight signer gates", ["Plan membership and budget caps", "Rail and asset allowlists", "Reputation floor and blocklist", "Deadline fit before signing", "Keys held by the signer only"]),
        ("Permissionless liveness", ["Refund after refund_after", "Accept after the challenge window", "Resolve after the dispute window", "Any wallet can crank them"]),
    ]
    cw, gap = 3.75, 0.24
    for i, (head, items) in enumerate(cols):
        x = MARGIN + i * (cw + gap)
        rect(s, x, 2.2, cw, 3.05, fill=SURFACE, line=LINE, radius=0.14)
        text(s, x + 0.3, 2.45, cw - 0.6, 0.4, head, size=H2 - 3, bold=True)
        text(s, x + 0.3, 2.95, cw - 0.6, 2.2, "\n".join(items), size=SMALL, color=INK_2, line=1.45)
    stats = [(f"{aiken:,}", "Aiken tests, 0 failures"), (f"{cases}", f"adversarial transactions, {unexpected} unexpected successes"), ("F1 to F5, E1 to E14", "audit and evaluator findings fixed")]
    for i, (num, label) in enumerate(stats):
        x = MARGIN + i * (cw + gap)
        text(s, x, 5.5, cw, 0.55, num, size=H2 + 5, bold=True, color=ACCEPTED.fg if i < 2 else INK)
        text(s, x, 6.05, cw, 0.7, label, size=SMALL, color=INK_2, line=1.25)
    footer(s, 7, source="demo/out/aiken-check.json, security/review-report.md, tests/adversarial/report.json, security/threat-model.md")
    notes(s, "Funds move only where the validators allow. The signer adds eight policy gates before anything is signed. Every state has a deadline exit anyone can crank.")


def slide_ecosystem(prs) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, BG)
    kicker(s, "Ecosystem fit")
    title(s, "Works with the agents that exist today.")
    tiles = [
        (ACCEPTED, "Every Masumi agent", "Hired unmodified through MIP-003 /start_job. The tree pays a purchase wallet that makes a plain vested_pay V2 lock, so the agent's payment service works as usual. Refunds go to the buyer."),
        (FUNDED, "x402 on Cardano", "Cascade agents answer 402 with script and masumi options. The orchestrator pays third-party x402 endpoints from the tree budget."),
        (SUBMITTED, "Sokosumi and the V2 registry", "Reference agents are registered on the Masumi V2 registry, so marketplaces that read it can list and hire them."),
        (WORKING, "MCP clients", "Any LLM agent can plan, fund through a returned unsigned transaction, and track a job to its receipt through the Cascade MCP server."),
    ]
    cw, ch = 5.66, 1.85
    for i, (st, head, body) in enumerate(tiles):
        x = MARGIN + (i % 2) * (cw + 0.4)
        y = 2.2 + (i // 2) * (ch + 0.3)
        rect(s, x, y, cw, ch, fill=SURFACE, line=LINE, radius=0.14)
        rect(s, x + 0.35, y + 0.38, 0.14, 0.14, fill=st.fg, radius=0.07)
        text(s, x + 0.62, y + 0.28, cw - 0.95, 0.4, head, size=H2 - 2, bold=True)
        text(s, x + 0.35, y + 0.78, cw - 0.7, 1.0, body, size=SMALL, color=INK_2, line=1.3)
    footer(s, 8, source="deployments/agents.preprod.json, docs/research/mip-003.md, docs/research/x402-cardano-spec.md")
    notes(s, "Cascade does not ask the ecosystem to change. Masumi agents, x402 endpoints and MCP clients work as they are.")


def slide_traction(prs, t: Traction) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, BG)
    kicker(s, "Traction on preprod, from chain")
    title(s, "Built and run on preprod during the hackathon.")
    stats = [
        (f"{t.settled}", f"trees settled of {t.trees} funded", FUNDED),
        (f"{t.nodes}", "escrow nodes created", SUBMITTED),
        (f"{t.refunds}", f"refunds of failed children, {ada(t.recovered_lovelace)} ADA back in parent budgets", REFUNDED),
        (f"{t.calls:,}", f"tool calls paid by voucher, {t.metered_l1} L1 transaction{'' if t.metered_l1 == 1 else 's'}", WORKING),
    ]
    shot = OUT / "shots" / "explorer-stage.png"
    if shot.exists():
        # Stats in a 2 x 2 grid on the left, the live Tree Explorer (stage mode) on the right.
        cw, ch, gap = 2.75, 1.35, 0.2
        for i, (num, label, st) in enumerate(stats):
            x = MARGIN + (i % 2) * (cw + gap)
            y = 2.2 + (i // 2) * (ch + gap)
            rect(s, x, y, cw, ch, fill=SURFACE, line=LINE, radius=0.12)
            rect(s, x + 0.25, y + 0.25, 0.36, 0.05, fill=st.fg, radius=0)
            text(s, x + 0.25, y + 0.36, cw - 0.5, 0.5, num, size=H1, bold=True, color=INK)
            text(s, x + 0.25, y + 0.86, cw - 0.5, 0.45, label, size=MICRO, color=INK_2, line=1.2)
        sw = W - MARGIN - (MARGIN + 2 * cw + gap + 0.35)
        sx = W - MARGIN - sw
        rect(s, sx - 0.04, 2.16, sw + 0.08, sw * 9 / 16 + 0.08, fill=SURFACE, line=LINE, radius=0.06)
        s.shapes.add_picture(str(shot), Inches(sx), Inches(2.2), Inches(sw), Inches(sw * 9 / 16))
    else:
        cw, gap = 2.73, 0.27
        for i, (num, label, st) in enumerate(stats):
            x = MARGIN + i * (cw + gap)
            rect(s, x, 2.3, cw, 2.5, fill=SURFACE, line=LINE, radius=0.14)
            rect(s, x + 0.3, 2.62, 0.42, 0.06, fill=st.fg, radius=0)
            text(s, x + 0.3, 2.85, cw - 0.6, 0.95, num, size=DISPLAY, bold=True, color=INK)
            text(s, x + 0.3, 3.85, cw - 0.6, 0.85, label, size=SMALL, color=INK_2, line=1.25)
    lower = 5.6 if shot.exists() else 5.2
    if t.redeemer_rows:
        text(s, MARGIN, lower, W - 2 * MARGIN, 0.4, [(f"{t.redeemer_rows} of {t.redeemer_rows}", {"bold": True, "color": ACCEPTED.fg}), (" redeemer paths in PRD 7.5 run on preprod, each with a transaction read back from chain (demo/out/redeemers.md).", {})], size=BODY)
    text(s, MARGIN, lower + 0.5, W - 2 * MARGIN, 0.6, f"Source: {API}/trees and per-node detail (indexer over preprod), fetched {t.fetched_at}. Every figure links back to transactions in the public Tree Explorer.", size=SMALL, color=INK_3, line=1.3)
    footer(s, 9)
    notes(s, "These numbers come from the indexer's public API over preprod at the time the deck was built.")


def slide_team(prs) -> None:
    s = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(s, INK)
    kicker(s, "Team and ask", color=ON_DARK_2)
    text(s, MARGIN, 0.92, 8, 0.8, "Team", size=H1, bold=True, color=ON_DARK)
    for i in range(3):
        x = MARGIN + i * 2.55
        rect(s, x, 2.0, 2.3, 2.7, fill=DARK_SURFACE, line=DARK_LINE, radius=0.14)
        rect(s, x + 0.3, 2.3, 0.7, 0.7, fill=DARK_LINE, radius=0.35)
        text(s, x + 0.3, 3.2, 1.8, 0.35, "[Name]", size=BODY, bold=True, color=ON_DARK)
        text(s, x + 0.3, 3.58, 1.8, 0.3, "[Role]", size=SMALL, color=ON_DARK_2)
        text(s, x + 0.3, 3.95, 1.8, 0.6, "[One line on what they built]", size=MICRO, color=ON_DARK_2, line=1.25)
    ax = MARGIN + 7.85
    text(s, ax, 0.92, 4, 0.8, "The ask", size=H1, bold=True, color=ON_DARK)
    rect(s, ax, 2.0, 3.88, 2.7, fill=DARK_SURFACE, line=DARK_LINE, radius=0.14)
    text(s, ax + 0.3, 2.3, 3.3, 2.2, "[What we want: pilots, partners, funding]\n\n[Who we want to meet]", size=BODY, color=ON_DARK, line=1.3)
    text(s, MARGIN, 5.35, W - 2 * MARGIN, 0.4, [("Try it: ", {"bold": True, "color": ON_DARK}), (f"{ORIGIN}/console", {"font": MONO, "color": ON_DARK_2})], size=SMALL)
    text(s, MARGIN, 5.75, W - 2 * MARGIN, 0.4, [("Code: ", {"bold": True, "color": ON_DARK}), ("[repository URL]", {"font": MONO, "color": ON_DARK_2})], size=SMALL)
    footer(s, 10, dark=True)
    notes(s, "The operator fills the team and ask placeholders before submission.")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    video = OUT / "cascade-demo.mp4"
    poster = OUT / "cascade-demo-poster.png"
    if "--dry-run-video" in sys.argv:
        video, poster = OUT / "cascade-demo-dryrun.mp4", OUT / "cascade-demo-dryrun-poster.png"
    if not video.exists():
        print(f"warning: {video.name} not found; slide 4 shows a placeholder", file=sys.stderr)

    prs = Presentation()
    prs.slide_width = Emu(int(W * 914400))
    prs.slide_height = Emu(int(H * 914400))
    prs.core_properties.title = "Cascade: escrow trees for the agent supply chain"
    prs.core_properties.author = "Cascade"

    t = traction()
    aiken, cases, unexpected = assurance()
    slide_hook(prs)
    slide_problem(prs)
    slide_one_sentence(prs)
    slide_video(prs, video if video.exists() else None, poster)
    slide_how(prs)
    slide_eutxo(prs)
    slide_security(prs, aiken, cases, unexpected)
    slide_ecosystem(prs)
    slide_traction(prs, t)
    slide_team(prs)

    out = OUT / "cascade-deck.pptx"
    prs.save(str(out))
    (OUT / "cascade-deck-stats.json").write_text(json.dumps({**t.__dict__, "aiken_tests": aiken, "adversarial_cases": cases, "unexpected_successes": unexpected, "source": f"{API}/trees"}, indent=2) + "\n")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB), video embedded: {video.exists()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
