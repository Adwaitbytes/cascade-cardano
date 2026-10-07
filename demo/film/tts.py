"""Voiceover for the demo film through OpenRouter's audio models.

Reads OPENROUTER_API_KEY from the env file given in OPENROUTER_ENV (never printed), streams PCM16
audio for each line and writes a WAV per line. Usage:
  python3 tts.py <model> <voice> <out_dir> <lines.json>
lines.json is a list of {"id": str, "text": str, "style": str?}.
"""
import base64
import json
import os
import sys
import urllib.request
import wave

STYLE = (
    "You are a professional voiceover artist recording a product demo. Read the user's text aloud "
    "exactly as written, word for word, adding nothing and skipping nothing. Speak as a warm, calm, "
    "confident woman in her thirties, natural conversational pace, slight smile in the voice, clear "
    "diction, small natural pauses at commas and full stops. Not salesy, not robotic."
)


def api_key() -> str:
    path = os.environ["OPENROUTER_ENV"]
    with open(path) as fh:
        for line in fh:
            if line.startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("OPENROUTER_API_KEY missing")


def speak(key: str, model: str, voice: str, text: str, style: str) -> tuple[bytes, str, dict]:
    body = {
        "model": model,
        "modalities": ["text", "audio"],
        "audio": {"voice": voice, "format": "pcm16"},
        "stream": True,
        "usage": {"include": True},
        "messages": [
            {"role": "system", "content": STYLE + (" " + style if style else "")},
            {"role": "user", "content": "Read this aloud exactly:\n\n" + text},
        ],
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    pcm = bytearray()
    transcript = []
    usage: dict = {}
    with urllib.request.urlopen(req, timeout=180) as res:
        for raw in res:
            line = raw.decode().strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            chunk = json.loads(line[6:])
            if chunk.get("usage"):
                usage = chunk["usage"]
            for choice in chunk.get("choices", []):
                audio = (choice.get("delta") or {}).get("audio") or {}
                if audio.get("data"):
                    pcm += base64.b64decode(audio["data"])
                if audio.get("transcript"):
                    transcript.append(audio["transcript"])
    return bytes(pcm), "".join(transcript), usage


def main() -> None:
    model, voice, out_dir, lines_path = sys.argv[1:5]
    only = set(sys.argv[5].split(",")) if len(sys.argv) > 5 else None
    os.makedirs(out_dir, exist_ok=True)
    key = api_key()
    total = 0.0
    for line in json.load(open(lines_path)):
        if only and line["id"] not in only:
            continue
        pcm, transcript, usage = speak(key, model, voice, line["text"], line.get("style", ""))
        if not pcm:
            raise SystemExit(f"no audio for {line['id']}")
        with wave.open(os.path.join(out_dir, line["id"] + ".wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(pcm)
        cost = float(usage.get("cost") or 0)
        total += cost
        json.dump({"text": line["text"], "transcript": transcript, "usage": usage}, open(os.path.join(out_dir, line["id"] + ".json"), "w"), indent=1)
        print(f"{line['id']}: {len(pcm) / 48000:.1f}s cost={cost:.4f} transcript={transcript[:90]!r}")
    print(f"total cost {total:.4f}")


if __name__ == "__main__":
    main()
