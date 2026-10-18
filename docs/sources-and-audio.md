# Source selection and audio

## Remembering sources

Successful playback remembers the exact torrent and file per movie/episode
(`source-affinity.ts`). Reopening tries that source while alternatives load
in parallel. Seeder-count changes alone must not switch releases; a better
quality tier does. Only a remembered top-tier (1080p) source starts before
Torrentio answers. A lower one waits for the list and leads only if nothing
ranks in a better tier, so a 480p that won one race is not replayed forever. Failed
sources are forgotten and excluded from further automatic attempts in the
same session; an explicit retry resets that exclusion.

A show's next episode plays from the release its last episode played from
(`preferContinuity`): the same season pack when it carries the episode (its
torrent is already known, often with peers), else the same scene group's
episode ("…-KONTRAST"). Only within the leading quality tier and never onto
a near-dead swarm. An episode's own remembered source still wins.

## Swarm health

Seeder counts are stale tracker scrapes, so among usable swarms they only
break ties. A near-dead one (under 5 seeders) ranks below every usable
source of its quality tier, ahead of pack, size and direct-play preferences
(`weakSwarmRank`): a 4-seeder single episode delivered 0.19 Mbps of the
0.87 it needed while a 54-seeder pack sat lower in the list.

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
  has both tracks (still Cubo's pick, so a starving source can be switched
  away from), otherwise sources are re-ranked and raced from the current
  position.
