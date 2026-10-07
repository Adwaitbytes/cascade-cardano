"""Renders a paid Sokosumi Task from the Cascade Coworker journal as a page for the demo film.

Usage: uv run --with markdown task_page.py <journal.json> <out.html>
Only public facts from the journal are used: Task id, stages and their times, tx hashes, result text.
"""
import html
import json
import sys
from datetime import datetime, timezone

import markdown

STAGES = {
    "started": "Task picked up, status RUNNING",
    "terms-saved": "Masumi payment terms signed by Cascade",
    "awaiting-escrow": "masumiPayment posted to Sokosumi",
    "escrow-locked": "Buyer's payment locked in Masumi escrow",
    "plan-drafted": "Cascade plan drafted",
    "tree-running": "Cascade tree funded, agents hired",
    "accept-pending": "Root delivered the result",
    "result-saved": "Result written",
    "awaiting-result": "Result hash sent to Masumi",
    "complete-pending": "Result hash confirmed on chain",
    "awaiting-withdrawal": "Task COMPLETED on Sokosumi",
    "settled": "Seller collected, escrow Withdrawn",
}


def main() -> None:
    journal = json.load(open(sys.argv[1]))
    seen: set[str] = set()
    rows = []
    for entry in journal["log"]:
        stage = entry["stage"]
        if stage not in STAGES or stage in seen:
            continue
        seen.add(stage)
        at = datetime.fromtimestamp(entry["at"] / 1000, tz=timezone.utc).strftime("%H:%M UTC")
        rows.append(f'<li><span class="t">{at}</span><span class="dot"></span><span>{html.escape(STAGES[stage])}</span></li>')
    tx = lambda h: f'<a href="https://preprod.cardanoscan.io/transaction/{h}">{h[:10]}…{h[-6:]}</a>'
    facts = [
        ("Masumi escrow lock", tx(journal["escrowTx"])),
        ("Cascade root funding", tx(journal["fundTx"])),
        ("Result hash on chain", tx(journal["resultSubmitTx"])),
        ("Seller collection", tx(journal["settlement"]["txHash"])),
    ]
    body = markdown.markdown(journal["result"], extensions=["tables"])
    page = f"""<!doctype html><html><head><meta charset="utf-8"><title>Task {journal['taskId'][:8]}</title>
<style>
:root{{--ink:#0d1826;--mut:#5b6675;--line:#e6e8eb;--bg:#f6f6f4;--ok:#127a4a}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.6 "Inter Variable",Inter,system-ui,sans-serif}}
.top{{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:18px 64px;background:#fff;border-bottom:1px solid var(--line)}}
.top b{{font-weight:650;letter-spacing:-.01em}} .src{{font-size:13px;color:var(--mut)}}
.wrap{{display:grid;grid-template-columns:520px 1fr;gap:40px;padding:40px 64px;max-width:1920px}}
.card{{background:#fff;border:1px solid var(--line);border-radius:18px;padding:28px 30px;box-shadow:0 1px 2px rgba(13,24,38,.04),0 8px 30px rgba(13,24,38,.05)}}
.side{{position:sticky;top:100px;align-self:start}}
h1.task{{font-size:26px;line-height:1.25;letter-spacing:-.02em;margin:6px 0 14px}}
.k{{font:500 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}}
.pill{{display:inline-block;padding:4px 12px;border-radius:999px;background:#e5f5ec;color:var(--ok);font-weight:600;font-size:13px}}
.meta{{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:14px;margin:16px 0 4px}} .meta span:nth-child(odd){{color:var(--mut)}}
.side ol{{list-style:none;padding:0;margin:18px 0 0}} .side ol li{{display:grid;grid-template-columns:86px 14px 1fr;gap:10px;align-items:center;font-size:14.5px;padding:5px 0}}
.t{{font:500 13px ui-monospace,Menlo,monospace;color:var(--mut)}} .dot{{width:9px;height:9px;border-radius:50%;background:var(--ok)}}
.facts{{margin-top:18px;border-top:1px solid var(--line);padding-top:14px;font-size:14px}} .facts div{{display:flex;justify-content:space-between;padding:4px 0}}
a{{color:#2156c9;text-decoration:none}} .facts a{{font-family:ui-monospace,Menlo,monospace;font-size:13px}}
.res h1{{font-size:30px;letter-spacing:-.02em;line-height:1.2}} .res h2{{font-size:22px;margin-top:34px;letter-spacing:-.01em}} .res h4{{font-size:17px;margin:24px 0 6px}}
.res blockquote{{margin:0;padding:10px 16px;border-left:3px solid var(--line);color:var(--mut)}}
.res table{{border-collapse:collapse;width:100%;font-size:14.5px;margin:10px 0}} .res th,.res td{{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}}
.res th{{font-weight:600;background:#fafafa}}
</style></head><body>
<div class="top"><span><b>Sokosumi Task</b> &nbsp;{journal['taskId']}</span><span class="src">Rendered from the Cascade Coworker journal, Cardano preprod</span></div>
<div class="wrap"><aside class="side card"><div class="k">Coworker · Cascade</div>
<h1 class="task">{html.escape(journal['name'])}</h1><span class="pill">COMPLETED · paid out</span>
<div class="meta"><span>Price</span><span>1 test USDM via Masumi escrow</span><span>Cascade tree</span><span>{journal['treeId'][:8]}…{journal['treeId'][-6:]}</span></div>
<ol>{''.join(rows)}</ol><div class="facts">{''.join(f'<div><span>{k}</span>{v}</div>' for k, v in facts)}</div></aside>
<main class="card res">{body}</main></div></body></html>"""
    open(sys.argv[2], "w").write(page)


if __name__ == "__main__":
    main()
