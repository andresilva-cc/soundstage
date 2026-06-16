# Golden Test Coverage — ffmpeg Footguns (§9)

Each row maps a documented footgun (architecture.md §9 / §5.4 / §5.5) to its covering test.

| Footgun | Risk | Covering test | Assertion |
|---------|------|---------------|-----------|
| `amix normalize=0` — default `normalize=1` silently divides each input by N, attenuating the voice lane | High | `compiler-core.test.ts` · "amix normalize=0 preserves voice lane level" | voice RMS in 2-clip render ≈ 1-clip render ±0.5 dB |
| Sidechain ducking depth/recovery — bed not attenuated during voice-present, or not recovering in gap | High | `compiler-ducking.test.ts` · "ducking RMS band test" | bed RMS during voice ≥6 dB below gap bed; gap bed within 3 dB of ref |
| Voice NOT attenuated by sidechain — wrong `asplit` topology ducts voice through the compressor | High | `compiler-ducking.test.ts` · "voice not attenuated by ducking" | voice band (880 Hz) in mix within 1 dB of voice-only render |
| Two-pass loudnorm I target — single-pass or dynamic fallback → non-deterministic, wrong level | High | `loudnorm.test.ts` · "loudnorm golden: output measures within target bounds" | I = −16 ± 1 LUFS (ebur128) |
| Two-pass loudnorm TP — true peak exceeds −1.5 dBTP | High | `loudnorm.test.ts` · "loudnorm golden: output measures within target bounds" | TP ≤ −1.5 dBTP (ebur128) |
| Loudnorm `linear=true` missing → non-deterministic dynamic fallback | High | `loudnorm.test.ts` · "loudnorm: linear=true is in pass-2 argv" | `buildPass2Argv` includes `linear=true` |
| Implicit `-ar` causes loudnorm to resample to wrong rate | Medium | `loudnorm.test.ts` · "loudnorm: -ar is explicitly set in pass-2 argv" | `-ar 48000` present in pass-2 argv |
| `-bitexact` missing → WAV master not byte-identical | High | `loudnorm.test.ts` · "loudnorm + encode: -bitexact present in both invocations" | `-bitexact` appears ≥2× in pass-2 argv |
| Byte-identical WAV master determinism — warm-cache renders differ | High | `loudnorm.test.ts` · "determinism: byte-identical WAV master from warm cache" | SHA-256 of two renders of same IR are equal |
| Crossfade total-duration math — overlap not subtracted | High | `compiler-core.test.ts` · "AC9: golden — crossfade reduces total duration by overlap" | output duration = A+B−overlap ±100 samples (ffprobe) |
| Concat sample-rate uniformity — 24kHz input passes through without resampling | High | `compiler-core.test.ts` · "intermediate output format" | output WAV sample_rate=48000, channels=1, sample_fmt=flt |
| Sample-exact silence — float-second duration drifts ±1 sample | High | `compiler-core.test.ts` · "silence sample-exact" | 48001-sample silence renders to exactly 48001 samples |
| Bed loop — short bed goes silent after EOF instead of looping | High | `compiler-ducking.test.ts` · "looping bed fills full span" | late-gap RMS > −60 dBFS (past one source length + release tail) |
| Bed non-loop pad — early EOF cutoff when bed shorter than span | High | `compiler-ducking.test.ts` · "non-loop short bed is silence-padded to fill span" | output duration = span ±500 samples; late window (past 2× bed source length) contains voice2 audio so is non-silent (proves render didn't stop at bed EOF) |
| CTOC omission — ffmpeg #7940: CTOC missing from mp3 output | High | `chapters.test.ts` · "chapters golden: CHAP + CTOC round-trip" | `node-id3.read()` returns `tableOfContents` with all chapter IDs |
| Last chapter endMs not pinned to real total — players loop/skip past end | Medium | `chapters.test.ts` · "chapters golden: CHAP + CTOC round-trip" | `ch.endTimeMs` = Math.round(ffprobedTotalSamples / SR × 1000) |
| `node-id3.update()` accumulates CHAP/CTOC on re-render | Medium | `test/unit/chapters.test.ts` · "calling writeChapterTags twice on the same mp3 does not double chapters"; `test/golden/chapters.test.ts` · "chapters golden: CHAP + CTOC round-trip" (via `runChapterPostPass`) | chapter count stays 1 after two `writeChapterTags` calls; `runChapterPostPass` calls `write()` not `update()` |
| `E_CROSSFADE_BOUNDARY` — crossfade at sibling boundary without neighbors | High | `test/validation.test.ts` · "Crossfade boundary" | throws `E_CROSSFADE_BOUNDARY` |

## What is NOT a golden test

Some risks are covered by unit tests rather than golden (real-ffmpeg) tests:

- Cache-key correctness (canonicalJSON, float serializer, NFC) → `test/unit/canonical.test.ts`, `test/unit/cache-key.test.ts`
- IR schema + validation → `test/validation.test.ts`, `test/unit/phase-b.test.ts`
- `E_CROSSFADE_BOUNDARY` → `test/validation.test.ts` (pure logic, no ffmpeg needed)

These are intentionally unit tests: they test deterministic logic, not ffmpeg behavior.
