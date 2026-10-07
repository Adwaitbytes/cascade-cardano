# Cascade launch film (30 s)

HyperFrames composition for the 30-second launch video. Output: `demo/out/cascade-launch-30s.mp4` (1920x1080, 60 fps).

```bash
npm install
node capture-parts.mjs 4b50da32cf987ecdccbf0b421b5269161e3ac84651476ed30bb045bf   # fresh product stills (real Chrome)
./mix.sh                                   # synthesize score + SFX, add voiceover, normalize to about -18 LUFS
npx hyperframes check
../../scripts/heavy.sh npx hyperframes render --quality delivery --fps 60 --workers 1 --output ../out/cascade-launch-30s.mp4
```

Beats: hook (0 to 4.3 s), reveal (4.3 to 8.3 s), the tree builds from real explorer node cards (8.3 to 15.6 s), receipt and closing tx on chain (15.6 to 20.3 s), ecosystem (20.3 to 25 s), URL bar and logo outro (25 to 30 s). See `STORYBOARD.md`. Licences in `CREDITS.md`.
