# Source selection and audio

## Remembering sources

Successful playback remembers the exact torrent and file per movie/episode
(`source-affinity.ts`). Reopening tries that source while alternatives load
in parallel. Seeder-count changes alone must not switch releases. Failed
sources are forgotten and excluded from further automatic attempts in the
same session; an explicit retry resets that exclusion.

## Eligibility

- Automatic playback and previews exclude positively identified foreign
  dubs, burned-in subtitles, cinema captures, and stereoscopic 3D (SBS/OU)
  encodes, which rank last. Unknown language is still eligible: release
  metadata is heuristic and does not prove the audio track's language. Keep
  direct-play precedence within the established quality tiers.
- Foreign-script titles (Cyrillic, CJK, …) and Russian voice-over studios
  are dubs for other-language originals unless the release says it carries
  the original track; Chinese burned-in caption markers (中英双字 …) are
  hardsubs. A 🇬🇧 flag beside other flags proves nothing.

## Original audio or English dub

Titles not made in English ask once per title, before the first play,
whether to watch the original (with English subtitles, the default) or an
English dub. The prompt only appears when an English-audio source exists
(`lib/audio-choice.ts`).

- The choice drives ranking (dub mode prefers named English audio such as
  "GER-ENG", then 🇬🇧 flags that subtitles don't explain, then unlabelled
  DUAL/MULTI releases) and is sent to Core as `audioLanguage`.
- Core plays that track, or falls back to the default track (never the
  English preference) when the file lacks it.
- In dub mode, a ready file without English is held back while the other
  sources race. It only plays, with a notice, if none of them has English,
  and it is never remembered as that episode's source.
- MP4s whose chosen track is not the first audio track are remuxed.
- The player's settings menu switches audio: the same file restarts when it
  has both tracks, otherwise sources are re-ranked and raced from the
  current position.
