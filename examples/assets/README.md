# examples/assets

Self-generated assets — no third-party audio; all files are CC0 / freely reproducible.

## theme.wav

A soft layered-sine pad: three sine tones (220 Hz, 330 Hz, 440 Hz) mixed at low
volumes, low-pass filtered at 800 Hz, with 3-second fade-in and fade-out. 30s,
48 kHz mono, PCM s16le.

Reproduce with:

```sh
ffmpeg -y \
  -f lavfi -i "sine=frequency=220:sample_rate=48000" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -filter_complex "\
    [0:a]volume=0.25[a0];\
    [1:a]volume=0.18[a1];\
    [2:a]volume=0.12[a2];\
    [a0][a1][a2]amix=inputs=3:normalize=0,\
    afade=t=in:st=0:d=3,\
    afade=t=out:st=27:d=3,\
    lowpass=f=800,\
    atrim=end=30,\
    asetpts=PTS-STARTPTS\
  " \
  -ar 48000 -ac 1 -c:a pcm_s16le \
  examples/assets/theme.wav
```

## bed.wav

A brighter C-major layered-sine pad for the `hello-world` example: three sine
tones (261.63 Hz, 329.63 Hz, 392 Hz) mixed at low volumes, low-pass filtered at
1000 Hz, with 2-second fade-in and fade-out. 20s, 48 kHz mono, PCM s16le.

Reproduce with:

```sh
ffmpeg -y \
  -f lavfi -i "sine=frequency=261.63:sample_rate=48000" \
  -f lavfi -i "sine=frequency=329.63:sample_rate=48000" \
  -f lavfi -i "sine=frequency=392.00:sample_rate=48000" \
  -filter_complex "\
    [0:a]volume=0.25[a0];\
    [1:a]volume=0.16[a1];\
    [2:a]volume=0.12[a2];\
    [a0][a1][a2]amix=inputs=3:normalize=0,\
    afade=t=in:st=0:d=2,\
    afade=t=out:st=18:d=2,\
    lowpass=f=1000,\
    atrim=end=20,\
    asetpts=PTS-STARTPTS\
  " \
  -ar 48000 -ac 1 -c:a pcm_s16le \
  examples/assets/bed.wav
```
