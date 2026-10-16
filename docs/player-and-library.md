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
  soon on…", `recap-preview.ts`). Skip recap shares the intro skipper.
  Arriving from the previous episode's Next episode (router state
  `continuedEpisode`, cleared from the history entry once read) jumps past
  the recap silently, once, and only when playback starts inside the
  recap (a player reconnecting mid-episode briefly reads 0:00); opening or
  resuming the episode any other way offers Skip recap instead.
- A preview that comes before the credits ends the episode: it gets the
  credits takeover (Next episode countdown, "Watch preview") and marks the
  episode done. With no next episode the preview just plays; only real
  credits take over.
- The Next episode countdown only runs while someone is around: after
  two hours with no input on the page (pointer, keys, wheel, touch, or a
  media-key play), playback pauses at the credits instead of rolling on
  into the next episode (`viewer-activity.ts`). The episode still counts as
  watched there; pressing play resumes the countdown.
- Reaching the end window means the playhead (or a seek's target) is in
  it. A drag across the bar that has not been let go does not count: it
  would mark the episode done and could run out the countdown.

## Controls

- The captions button and the Subtitles settings row only show when the
  title has subtitle tracks.
- Subtitle cues honour a leftover ASS `{\anN}` tag: 7–9 go to the top
  (below the top chrome when it shows), 4–6 to the middle, left/centre/right
  by column. Every other `{\…}` override is stripped, and `\N` becomes a
  line break.
- The player chrome never fades while a menu is open (settings, the
  Episodes drawer via `menuOpen`); moving over it does not re-arm the
  fade, which resumes once the menu closes.
- Custom UI over native controls: use `ConfirmDialog` and `Dropdown` from
  `apps/web/components` instead of `window.confirm` / `<select>`.
- No new color tokens without approval; reuse the theme in
  `packages/ui/src/theme.css`.
- Side drawers (`.drawer-dialog`, `useDrawerDialog`) clip with
  `overflow: clip`, never `overflow-hidden`: `showModal` focuses the first
  control and a hidden-overflow dialog scrolls the off-screen panel into
  view, so a right-side drawer snaps open instead of sliding.
- Native scrolling only — Lenis was removed on purpose; do not reintroduce
  scroll-hijacking.

## Library and browsing

- Continue Watching (`continueWatchingEntries` in `lib/library.ts`) has
  one card per title, from the last episode touched. An unfinished
  episode resumes. A finished one moves the card on to the next aired
  episode, so a show stays until there is nothing left to watch.
  Finishing the final aired episode of an ended or canceled show
  finishes it, in whatever order it was watched. A caught-up show that
  is still airing (TMDB "Returning Series", "In Production", "Planned",
  or a scheduled next episode) stays with its next air date ("S1 E8 ·
  Airs Thu, Oct 22", or "Caught up"). That card opens the title page.
- The "New episode" pill (frosted dark, white dot) means the season the
  viewer is on got an episode after they finished theirs. Catching up
  on an older season while a later one airs gets no pill. Cards with
  the pill lead the row.
- Air-date labels past tomorrow always carry the date ("Airs Fri, Oct 9"):
  a bare weekday reads as the past when that day already went by this week.
- The Library schedule (`release-schedule.tsx`) covers every TV show in the
  history, not just Continue Watching, built from the cached TMDB details
  and next-episode season queries. Keep it to Week / Month / List views.
- Featured heroes rotate across eligible catalog titles (last decade only),
  using recent history shared across Home, Movies, and TV. Each page holds
  its choice for several hours across refreshes; never revert to always
  taking item zero.
