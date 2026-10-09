# Player UI, progress, and library

## Progress and resume

- Intentional seeks are persisted before the asynchronous seek starts. Keep
  the old-player teardown guards, but never treat an explicit backward seek
  as an accidental rewind. `ProgressWriter` permits one in-flight POST and
  coalesces queued snapshots to the newest, preserving accumulated watch
  time.
- Progress sends `progressUpdatedAt` and `progressDeviceId`; Core rejects
  older observations from the same browser. `lastWatchedAt` remains server
  receipt time for library recency. Do not compare observation clocks
  across devices. Legacy clients without these optional fields retain their
  existing behavior.
- An earlier episode only takes a show back from the later one being
  watched after a minute of real playback in one sitting
  (`sessionWatchSeconds`); until then Core saves its playhead but keeps its
  old `lastWatchedAt`, so a stale tab, refresh, or immediate back does not
  rewind the show.
- `POST /v1/library/progress` returns `204 No Content` (not the library
  snapshot) — progress ticks are hot-path.

## Skip windows

- From a show's second episode on, detected intros skip themselves after a
  short countdown on the Skip intro button (Watch intro cancels), once per
  intro window. The player settings toggle "Auto-skip intro" turns it off;
  episode 1 always plays its intro.
- Recaps and previews come from Core's sections when it has them, otherwise
  from the English subtitles' narrator lead-ins ("Previously on…", "Coming
  soon on…", `recap-preview.ts`). Skip recap shares the intro skipper (no
  auto-skip); a preview opens the credits prompt.

## Controls

- The captions button and the Subtitles settings row only show when the
  title has subtitle tracks.
- Custom UI over native controls: use `ConfirmDialog` and `Dropdown` from
  `apps/web/components` instead of `window.confirm` / `<select>`.
- No new color tokens without approval; reuse the theme in
  `packages/ui/src/theme.css`.
- Native scrolling only — Lenis was removed on purpose; do not reintroduce
  scroll-hijacking.

## Library and browsing

- Air-date labels past tomorrow always carry the date ("Airs Fri, Oct 9"):
  a bare weekday reads as the past when that day already went by this week.
- The Library schedule (`release-schedule.tsx`) covers every TV show in the
  history, not just Continue Watching, built from the cached TMDB details
  and next-episode season queries. Keep it to Week / Month / List views.
- Featured heroes rotate across eligible catalog titles (last decade only),
  using recent history shared across Home, Movies, and TV. Each page holds
  its choice for several hours across refreshes; never revert to always
  taking item zero.
