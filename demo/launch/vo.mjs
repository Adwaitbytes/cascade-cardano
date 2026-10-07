// One line of voiceover through OpenRouter (openai/gpt-audio-mini). Reads the key from the env
// file passed as argv[2] and never prints it. Writes assets/audio/vo.wav (24 kHz mono PCM16).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const envFile = process.argv[2];
const voice = process.argv[3] ?? "shimmer";
const key = readFileSync(envFile, "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!key) throw new Error("OPENROUTER_API_KEY missing from env file");

const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "openai/gpt-audio-mini",
    modalities: ["text", "audio"],
    audio: { voice, format: "pcm16" },
    stream: true,
    messages: [
      { role: "system", content: "You are a voice actor for a premium technology launch film. Read the user's line exactly as written, nothing else. Warm, calm, confident, unhurried, natural. A short pause after the first word." },
      { role: "user", content: "Cascade. Live on Cardano." },
    ],
  }),
});
if (!res.ok) throw new Error(`OpenRouter returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

const chunks = [];
let transcript = "";
let usage = null;
const decoder = new TextDecoder();
let buf = "";
for await (const part of res.body) {
  buf += decoder.decode(part, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    const evt = JSON.parse(data);
    if (evt.usage) usage = evt.usage;
    const audio = evt.choices?.[0]?.delta?.audio;
    if (audio?.data) chunks.push(Buffer.from(audio.data, "base64"));
    if (audio?.transcript) transcript += audio.transcript;
  }
}
const pcm = Buffer.concat(chunks);
if (pcm.length === 0) throw new Error("no audio returned");
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
mkdirSync("assets/audio", { recursive: true });
writeFileSync(`assets/audio/vo-${voice}.wav`, Buffer.concat([header, pcm]));
console.log(JSON.stringify({ voice, seconds: pcm.length / 48000, transcript, usage }));
