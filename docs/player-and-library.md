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
  intro window. Episode 1 always plays its intro.
- The player settings' Auto-skip pane holds both automatic skips: "Skip
  intros" and "Play next episode". With the latter off, the credits still
  take over with Next episode, but there is no countdown and nothing
  advances on its own. Both default on and persist locally.
- Credits must never start while the story is still going: ending early
  skips story, a late prompt only costs seconds of credits. Crowd databases
  time credits on someone else's copy, and IntroDB starts Wayward Pines'
  credits 60–100 s before the Blu-ray rips roll them. Core moves crowd
  credits that land mid-chapter to a short final chapter (10 s–5 min,
  running to the end) starting up to 3 min later
  (`align_credits_to_chapters`), since releases mark the credits with a
  chapter even when they leave it unnamed. The player then moves them past
  English dialogue that runs on from their start (a line within 30 s,
  ignoring lyrics, sound tags and the subtitler's credit;
  `creditsAfterDialogue`). Both only ever move credits later.
- Crowd intros are timed on someone else's copy as well (IntroDB's single
  Wayward Pines submissions sit 8–17 s early in the Blu-ray rips). When the
  file has a chapter about as long as the crowd intro (within 10 s and
  30%) starting within 30 s of it, that chapter is the intro
  (`align_intro_to_chapters`): rips mark the title sequence even when the
  chapter is unnamed.
- TheIntroDB is read through its v4 API (v2/v3 are frozen and being
  removed), addressed by TMDB id with TMDB's own season/episode numbers,
  which v4 resolves server-side, so no `mapping`. Core sends the file's
  probed duration (`duration_ms`) so the release version nearest this cut
  answers. A null `start_ms` means the segment starts at 0.
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
- Turning captions on picks the viewer's last-picked caption language,
  else English wherever it sits in the provider's list, else the first
  track (`preferredSubtitleId`). The menu keeps the provider's order and
  caps at 18 languages, but never cuts English.
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
- New screens speak the existing type and component language rather
  than inventing their own: heroes use `HeroTitle` (bold, colon split),
  the "Kind • detail • detail" line (`text-xl font-semibold` kind),
  white synopsis, `WatchPlayLink` and the `bg-control` circle buttons
  (or reuse `FeaturedHero` outright, with its `kind`); rows use
  `SectionRow`/`MediaRow` headings (`text-3xl font-bold`). No mono
  eyebrows, light-weight display type, tight negative tracking or
  bespoke pill buttons.
- Side drawers (`.drawer-dialog`, `useDrawerDialog`) clip with
  `overflow: clip`, never `overflow-hidden`: `showModal` focuses the first
  control and a hidden-overflow dialog scrolls the off-screen panel into
  view, so a right-side drawer snaps open instead of sliding.
- Native scrolling only — Lenis was removed on purpose; do not reintroduce
  scroll-hijacking.
- Sideways rows use `ScrollRow` (`@cubo/ui`): it scrolls sideways only
  (a bare `overflow-x-auto` also scrolls vertically by whatever pokes out,
  so a trackpad swipe wobbles it), keeps end-of-row swipes from turning
  into browser back/forward, and pages with the fading edge arrows.

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
- Home's hero is the episode strip while a show is in progress: the
  first Continue Watching card that is a show with an episode out to
  play (so a new episode leads) and that the viewer is really into
  (`investedInShow`: an episode finished, or 20 minutes in across its
  episodes; ten seconds of a pilot does not count), with that season's
  aired episodes along the bottom (`episode-strip-hero.tsx`). A show
  caught up and waiting on its next episode gives way to the next one. Picking an episode moves the hero
  onto it without leaving the page; Play starts the picked one. That
  show's card stays out of the Continue Watching row below. Without one,
  Home falls back to the rotating featured hero. The hero waits for the
  library so it never swaps a moment after the page appears.
- The strip and backdrop move on transforms and crossfades only
  (`CrossfadeImage` keeps the old picture until the new one covers it),
  slowly (about 0.9 s): keep new motion off layout properties. Keep the
  hero sparse: episode number and name under each thumbnail, nothing
  more, and no counters. Its text is FeaturedHero's: the show's title,
  then "Episode name • S1 E10 • 21m left" on one line (a long name
  truncates, full name on hover; the rest never wraps), the synopsis, and
  "Continue S1 E10" / "Watch S1 E8".
- `CrossfadeImage` fades each new picture in with the Web Animations API
  after `decode()`, never by flipping a class on load: a cached picture
  loads before its first frame paints, so a CSS transition skips to the
  end and pops. Pictures underneath stay until the newest covers them.
- The strip drags (mouse or touch, with a little fling on release) and
  takes trackpad sideways swipes, without changing the picked episode.
  It opens on the viewer's episode, then stays where they leave it:
  picking an episode, or stepping with the arrows or keys, only nudges
  it by the least amount that shows that card in full.
- Hero stills are TMDB's w1280 (the originals are about 2 MB each) and
  strip thumbnails w780, which stay sharp on 2x screens when the picked
  one scales up. Its images are not
  draggable, and a drag's closing click is not a pick.
- Once the page is idle, the strip preloads every episode's full-size
  still (nearest the picked one first, two at a time) so stepping along
  it never waits on the network.
- Pages fade in when the path changes (`.route-enter`, opacity only:
  a transform would trap fixed overlays inside the page).
- "Your services" are the services the viewer picked, in their order,
  stored locally (`lib/streaming-services.ts`) and managed in the
  Library's "Your services" section (Home's row is only the tiles: no edit
  link, no add tile, no modal). Any service TMDB lists in any country can
  be picked; TMDB ids that share a name are one service (Amazon Prime
  Video is 9 and 119). Until the viewer picks, the tiles are Netflix,
  Apple TV, Disney Plus and Amazon Prime Video. Tiles take the logo's own
  background colour (sampled from its corner) so no colour tokens are
  added per brand.
- The viewer's country (time zone first, then browser languages, or the
  Library's "Rank by") only orders things: its services list first, and
  a service page's Top 10 ranks by it. It never limits what a catalogue
  shows.
- A service page (`/services/:id`) reads the service's subscription
  catalogue (`with_watch_monetization_types=flatrate`) in the viewer's
  country plus the big ones (US, UK) where the service runs, and merges
  them (`mergeCatalog`): TMDB only filters by service within one country
  per request, and without a country it ignores the filter. A service in
  none of those reads its own leading countries. The services row hides
  when the metadata source has none (Cinemeta).
- A service page is a few grouped rows, not one long grid: Top 10
  (ranked, viewer's country), new (Continue Watching's card: logo over
  the still, date pill), top rated, and two genre rows that only fetch
  as they near the viewport and drop out when empty. Keep it to that;
  the genre menu reaches the rest. Picking a genre narrows the first
  three rows to it and drops the genre rows. The header is one bar of
  the viewer's services' logos: the one on screen lit and named, the
  rest dim until hovered.
- Featured heroes rotate across eligible catalog titles (last decade only),
  using recent history shared across Home, Movies, and TV. Each page holds
  its choice for several hours across refreshes; never revert to always
  taking item zero.
