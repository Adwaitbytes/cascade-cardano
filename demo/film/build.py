"""Edits the submission film from the raw shots, the voice lines and the overlay PNGs.

Usage: python3 build.py <raw_dir> <voice_dir> <overlay_dir> <work_dir> <out.mp4>
raw_dir/shots.json comes from record.ts, voice_dir holds one normalised WAV per line in lines.json,
overlay_dir holds the PNGs from overlays.ts. Writes <out.mp4> and <out>.json (the timeline).

Each scene plays its voice lines in order with short pauses; its visual segments are cut from the
raw shots (offsets are seconds after a recorded mark) and joined with crossfades. A segment with
dur None fills what is left of the scene.
"""
import json
import os
import subprocess
import sys

RAW, VOICE, OVL, WORK, OUT = sys.argv[1:6]
FPS = 30
XF = 0.45  # crossfade seconds
GAP = 0.38  # pause between lines
os.makedirs(WORK, exist_ok=True)
# Shots whose browser frame came out shorter than the video (a grey strip at the bottom): w, h, x, y to keep.
SHOT_CROP = {"resultHash": (1765, 993, 77, 0), "fundRoot": (1765, 993, 77, 0)}

# (shot, mark, offset, dur, speed, zoom) ; zoom = (cx, cy, scale) static punch-in, or None
S = lambda shot, dur=None, mark="ready", off=0.0, speed=1.0, zoom=None: dict(shot=shot, mark=mark, off=off, dur=dur, speed=speed, zoom=zoom)

SCENES = [
    dict(name="hook", lines=["h1", "h2", "h3"], lead=1.6, tail=0.5,
         visual=[S("card:title", 4.6), S("landing", None, off=0.0)],
         lower=[("live", 5.2, 5.0)]),
    dict(name="what", lines=["w1", "w2", "w3", "w4"], lead=0.3, tail=0.5,
         visual=[S("landing", 9.0, off=8.0, zoom=(1450, 760, 1.25)), S("landing", 14.0, mark="scroll", off=0.0), S("economy", None, off=0.0)],
         lower=[("network", 23.6, 4.5)]),
    dict(name="task", lines=["d1", "d2"], lead=0.4, tail=0.5,
         visual=[S("task", 9.0, off=0.0, zoom=(560, 470, 1.18)), S("masumiLock", None, off=0.5)],
         lower=[("task", 0.7, 5.0), ("lock", 9.9, 5.0)]),
    dict(name="tree", lines=["d3", "d5"], lead=0.4, tail=0.6,
         visual=[S("tree", 15.0, off=2.0, speed=3.6), S("tree", None, mark="hover", off=0.0)],
         lower=[("tree", 0.7, 5.5)]),
    dict(name="console", lines=["c1"], lead=0.3, tail=0.5,
         visual=[S("console", 3.6, off=0.6, speed=2.0), S("console", 3.2, mark="plan", off=0.0), S("console", None, mark="wallet", off=0.3)],
         lower=[("console", 0.5, 4.5)], badge=True),
    dict(name="result", lines=["r1", "r2", "r3"], lead=0.3, tail=0.5,
         visual=[S("task", 6.4, mark="result", off=1.0), S("receipt", 7.0, off=0.0), S("resultHash", 3.8, off=0.3), S("withdrawn", None, off=0.3)],
         lower=[("receipt", 6.8, 4.5), ("result", 13.6, 3.6), ("payout", 17.4, 3.6)]),
    dict(name="cardano", lines=["y1", "y2"], lead=0.4, tail=0.5,
         visual=[S("fundRoot", 7.4, off=0.0), S("fundRoot", 6.0, mark="utxos", off=0.0), S("fundRoot", 6.0, mark="mints", off=0.3), S("waterfall", None, off=0.0)],
         lower=[("fund", 0.6, 5.0), ("tokens", 13.6, 5.0), ("waterfall", 19.8, 3.8)]),
    dict(name="impact", lines=["i1", "i2"], lead=0.4, tail=0.6,
         visual=[S("economy", 5.5, off=9.0), S("github", None, off=0.0)],
         lower=[("repo", 6.0, 6.0)]),
    dict(name="end", lines=["e1"], lead=0.5, tail=1.8,
         visual=[S("card:end", None)], lower=[]),
]


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def duration(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


shots = json.load(open(os.path.join(RAW, "shots.json")))
lines = {l["id"]: l for l in json.load(open(os.path.join(os.path.dirname(__file__), "lines.json")))}

# 1. Timeline: voice placement and scene lengths.
t = 0.0
voice, captions, timeline = [], [], []
for sc in SCENES:
    start = t
    at = t + sc["lead"]
    for lid in sc["lines"]:
        d = duration(os.path.join(VOICE, lid + ".wav"))
        voice.append((lid, at))
        captions.append((lid, at, at + d))
        at += d + GAP
    end = at - GAP + sc["tail"]
    sc["start"], sc["len"] = start, end - start
    timeline.append(dict(scene=sc["name"], start=round(start, 2), end=round(end, 2)))
    t = end
TOTAL = t

# 2. Visual segments, each rendered with XF extra seconds so neighbours can crossfade.
segs = []
for sc in SCENES:
    fixed = sum(v["dur"] for v in sc["visual"] if v["dur"] is not None)
    for v in sc["visual"]:
        v["len"] = v["dur"] if v["dur"] is not None else sc["len"] - fixed
        if v["len"] < 1.0:
            raise SystemExit(f"scene {sc['name']}: segment too short ({v['len']:.2f}s)")
        segs.append(v)

files = []
for i, v in enumerate(segs):
    out = os.path.join(WORK, f"seg{i:02d}.mp4")
    length = v["len"] + XF
    if v["shot"].startswith("card:"):
        png = os.path.join(OVL, "card-" + v["shot"][5:] + ".png")
        vf = f"scale=2112:-2,zoompan=z='1.0+0.05*on/({length}*{FPS})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(length * FPS) + 1}:s=1920x1080:fps={FPS},format=yuv420p"
        run(["ffmpeg", "-y", "-loop", "1", "-i", png, "-t", f"{length:.3f}", "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-r", str(FPS), out])
    else:
        rec = shots[v["shot"]]
        src_start = rec["marks"][v["mark"]] + v["off"]
        raw_len = length * v["speed"]
        filters = [f"setpts=(PTS-STARTPTS)/{v['speed']}"]
        if v["shot"] in SHOT_CROP:
            cw, ch, cx0, cy0 = SHOT_CROP[v["shot"]]
            filters.append(f"crop={cw}:{ch}:{cx0}:{cy0},scale=1920:1080:flags=lanczos")
        if v["zoom"] is not None:
            cx, cy, z = v["zoom"]
            w, h = round(1920 / z / 2) * 2, round(1080 / z / 2) * 2
            x = min(max(0, cx - w // 2), 1920 - w)
            y = min(max(0, cy - h // 2), 1080 - h)
            filters.append(f"crop={w}:{h}:{x}:{y},scale=1920:1080:flags=lanczos")
        filters += [f"fps={FPS}", "format=yuv420p"]
        run(["ffmpeg", "-y", "-ss", f"{src_start:.3f}", "-t", f"{raw_len + 0.2:.3f}", "-i", rec["video"], "-vf", ",".join(filters), "-t", f"{length:.3f}", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16", out])
        got = duration(out)
        if got < length - 0.15:
            raise SystemExit(f"segment {i} ({v['shot']}@{v['mark']}) is {got:.2f}s, needs {length:.2f}s: the raw shot ends too early")
    files.append(out)

# 3. Join with crossfades.
inputs, chain = [], []
for f in files:
    inputs += ["-i", f]
prev, offset = "[0:v]", 0.0
for i in range(1, len(files)):
    offset += segs[i - 1]["len"]
    lab = f"[x{i}]"
    chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={XF}:offset={offset:.3f}{lab}")
    prev = lab
video_only = os.path.join(WORK, "video.mp4")
run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(chain), "-map", prev, "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", video_only])

# 4. Overlays (captions, lower-thirds, speed badge) and the voice track.
ov_inputs, ov_chain, cur = [], [], "[0:v]"
items = [(f"cap-{lid}.png", a, b - a + 0.25) for lid, a, b in captions]
for sc in SCENES:
    for key, rel, dur in sc["lower"]:
        items.append((f"lt-{key}.png", sc["start"] + rel, dur))
    if sc.get("badge"):
        items.append(("badge-speed.png", sc["start"] + 0.2, sc["visual"][0]["len"] - 0.2))
for n, (png, a, d) in enumerate(items, start=1):
    ov_inputs += ["-loop", "1", "-t", f"{a + d + 0.5:.3f}", "-i", os.path.join(OVL, png)]
    ov_chain.append(f"[{n}:v]format=rgba,fade=in:st={a:.3f}:d=0.25:alpha=1,fade=out:st={a + d - 0.25:.3f}:d=0.25:alpha=1[o{n}]")
    ov_chain.append(f"{cur}[o{n}]overlay=0:0:eof_action=pass[v{n}]")
    cur = f"[v{n}]"
a0 = len(items) + 1
aud_inputs, aud_chain = [], []
for k, (lid, at) in enumerate(voice):
    aud_inputs += ["-i", os.path.join(VOICE, lid + ".wav")]
    ms = int(at * 1000)
    aud_chain.append(f"[{a0 + k}:a]adelay={ms}|{ms}[a{k}]")
aud_chain.append("".join(f"[a{k}]" for k in range(len(voice))) + f"amix=inputs={len(voice)}:normalize=0,apad,atrim=0:{TOTAL + XF:.3f},afade=t=out:st={TOTAL - 0.8:.3f}:d=1.2[aout]")
graph = ";".join(ov_chain + aud_chain)
script = os.path.join(WORK, "graph.txt")
open(script, "w").write(graph)
run(["ffmpeg", "-y", "-i", video_only, *ov_inputs, *aud_inputs, "-filter_complex_script", script, "-map", cur, "-map", "[aout]",
     "-t", f"{TOTAL:.3f}", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart",
     "-c:a", "aac", "-b:a", "192k", "-ar", "48000", OUT])

json.dump(dict(total=round(TOTAL, 2), scenes=timeline, captions=[dict(id=l, start=round(a, 2), end=round(b, 2), text=lines[l]["cap"]) for l, a, b in captions]),
          open(os.path.splitext(OUT)[0] + ".json", "w"), indent=1, ensure_ascii=False)
print(f"wrote {OUT}: {TOTAL:.1f}s")
