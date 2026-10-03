import { backdropUrl, posterUrl, titleHref, type LibraryItem } from '@cubo/core';
import { useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { IoChevronBack, IoChevronForward } from 'react-icons/io5';
import { Dropdown } from '@/components/dropdown';
import { Link } from '@/components/link';
import { tmdbQueries } from '@/lib/queries';
import {
  addDays,
  dayKey,
  entriesByDay,
  monthGrid,
  scheduleEntries,
  startOfDay,
  watchingShowIds,
  type ScheduleEntry,
} from '@/lib/schedule';

type View = 'week' | 'month' | 'list';

const VIEW_OPTIONS: { value: View; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'list', label: 'List' },
];

const VIEW_STORAGE_KEY = 'cubo.schedule-view.v1';

function loadView(): View {
  try {
    const value = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return value === 'month' || value === 'list' ? value : 'week';
  } catch {
    return 'week';
  }
}

function saveView(view: View): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Private-mode quota errors are fine to ignore; the view just won't stick.
  }
}

/** "Today", "Tomorrow", or the weekday — always shown beside the date. */
function relativeDay(date: Date, today: Date): string {
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}

/** "Oct 9", or "Jul 8, 2027" outside the current year. */
function shortDate(date: Date): string {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function episodeCode(entry: ScheduleEntry): string {
  return `S${entry.season} E${entry.episode}`;
}

/**
 * Upcoming episodes of every show the viewer has started, as a week strip,
 * a month calendar, or a plain list. Data comes from the same cached TMDB
 * details/season queries the title pages use.
 */
export function ReleaseSchedule({ history }: { history: LibraryItem[] }) {
  const showIds = useMemo(() => watchingShowIds(history), [history]);
  const details = useQueries({
    queries: showIds.map((id) => tmdbQueries.details('tv', id)),
  });
  const nextSeasons = details.map((query) =>
    query.data?.nextEpisode ? { id: query.data.id, season: query.data.nextEpisode.seasonNumber } : null,
  );
  const seasons = useQueries({
    queries: nextSeasons
      .filter((entry): entry is { id: number; season: number } => entry !== null)
      .map((entry) => tmdbQueries.season(entry.id, entry.season)),
  });

  const today = startOfDay(new Date());
  const loading = details.some((query) => query.isPending);
  // Seasons were requested in the same order as the shows that have a
  // next episode, so walk both together.
  let seasonIndex = 0;
  const shows = details.flatMap(({ data }) => {
    if (!data?.nextEpisode) return [];
    const episodes = seasons[seasonIndex]?.data;
    seasonIndex += 1;
    return [{ details: data, episodes }];
  });
  const entries = scheduleEntries(shows, today);
  const byDay = entriesByDay(entries);

  const [view, setView] = useState<View>(() => loadView());
  const pickView = (next: View) => {
    setView(next);
    saveView(next);
  };

  if (showIds.length === 0) return null;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Schedule</h2>
          <p className="mt-1 text-sm text-faint">New episodes of the shows you're watching</p>
        </div>
        <Dropdown
          ariaLabel="Schedule view"
          value={view}
          options={VIEW_OPTIONS}
          onChange={pickView}
          className="w-32 text-sm"
        />
      </div>

      {loading && entries.length === 0 ? (
        <div className="mt-6 h-40 animate-pulse rounded-xl bg-surface" aria-busy="true" />
      ) : view === 'month' ? (
        <MonthView byDay={byDay} today={today} />
      ) : entries.length === 0 ? (
        <p className="mt-6 border-t border-line pt-6 text-sm text-faint">
          Nothing announced yet. New episodes show up here as soon as they're scheduled.
        </p>
      ) : view === 'week' ? (
        <WeekView byDay={byDay} today={today} />
      ) : (
        <ListView entries={entries} today={today} />
      )}
    </section>
  );
}

function Stepper({
  label,
  onPrev,
  onNext,
  prevDisabled,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
}) {
  const button =
    'flex size-8 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-control hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="mt-6 flex items-center gap-1">
      <button type="button" aria-label="Previous" onClick={onPrev} disabled={prevDisabled} className={button}>
        <IoChevronBack size={16} />
      </button>
      <button type="button" aria-label="Next" onClick={onNext} className={button}>
        <IoChevronForward size={16} />
      </button>
      <p className="ml-2 text-sm font-medium text-muted">{label}</p>
    </div>
  );
}

/** Seven days from today, one column each, episodes as backdrop cards. */
function WeekView({ byDay, today }: { byDay: Map<string, ScheduleEntry[]>; today: Date }) {
  const [offset, setOffset] = useState(0);
  const start = addDays(today, offset * 7);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const end = days[6]!;

  return (
    <>
      <Stepper
        label={`${shortDate(start)} – ${shortDate(end)}`}
        onPrev={() => setOffset((value) => Math.max(0, value - 1))}
        onNext={() => setOffset((value) => value + 1)}
        prevDisabled={offset === 0}
      />
      <div className="mt-4 lg:hidden">
        {days.map((day) => {
          const key = dayKey(day);
          const isToday = key === dayKey(today);
          const items = byDay.get(key) ?? [];
          return (
            <div key={key} className="grid grid-cols-[4.5rem_1fr] gap-3 border-t border-line py-3">
              <p className={`text-sm font-medium ${isToday ? 'text-white' : items.length ? 'text-muted' : 'text-faint'}`}>
                {isToday ? 'Today' : day.toLocaleDateString(undefined, { weekday: 'short' })}
                <span className="ml-1.5 text-faint">{day.getDate()}</span>
              </p>
              {items.length ? (
                <ul className="space-y-3">
                  {items.map((entry) => (
                    <EntryRow key={entry.key} entry={entry} />
                  ))}
                </ul>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 hidden grid-cols-7 gap-3 lg:grid">
        {days.map((day) => {
          const key = dayKey(day);
          const isToday = key === dayKey(today);
          const items = byDay.get(key) ?? [];
          return (
            <div key={key} className={`border-t pt-3 ${isToday ? 'border-white' : 'border-line'}`}>
              <p className={`text-xs font-semibold uppercase tracking-wide ${isToday ? 'text-white' : 'text-faint'}`}>
                {isToday ? 'Today' : day.toLocaleDateString(undefined, { weekday: 'short' })}
              </p>
              <p className={`text-2xl font-semibold ${items.length ? 'text-white' : 'text-white/30'}`}>
                {day.getDate()}
              </p>
              <div className="mt-3 space-y-4">
                {items.map((entry) => (
                  <Link key={entry.key} href={titleHref({ id: entry.showId, mediaType: 'tv' })} className="group block">
                    <div className="relative aspect-video overflow-hidden rounded-lg bg-surface">
                      {entry.backdropPath ? (
                        <img
                          src={backdropUrl(entry.backdropPath, 'w780')}
                          alt=""
                          loading="lazy"
                          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        />
                      ) : null}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/55 transition-colors group-hover:bg-black/45">
                        <span className="text-3xl font-bold tracking-tight text-white xl:text-4xl">
                          {episodeCode(entry)}
                        </span>
                      </div>
                    </div>
                    <p className="mt-2 truncate text-sm font-medium">{entry.title}</p>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Classic month calendar. Wide screens list titles in each cell; narrow
 *  ones show dots and list the tapped day underneath. */
function MonthView({ byDay, today }: { byDay: Map<string, ScheduleEntry[]>; today: Date }) {
  const [offset, setOffset] = useState(0);
  const month = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const days = monthGrid(month);
  const todayKey = dayKey(today);
  const [selected, setSelected] = useState(todayKey);
  const selectedItems = byDay.get(selected) ?? [];
  const weekdays = days.slice(0, 7).map((day) => day.toLocaleDateString(undefined, { weekday: 'short' }));

  return (
    <>
      <Stepper
        label={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        onPrev={() => setOffset((value) => Math.max(0, value - 1))}
        onNext={() => setOffset((value) => value + 1)}
        prevDisabled={offset === 0}
      />
      <div className="mt-4 grid grid-cols-7">
        {weekdays.map((label) => (
          <p key={label} className="pb-2 text-xs font-semibold uppercase tracking-wide text-faint">
            {label}
          </p>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const items = byDay.get(key) ?? [];
          const inMonth = day.getMonth() === month.getMonth();
          const isToday = key === todayKey;
          return (
            <div
              key={key}
              onClick={() => setSelected(key)}
              className={`flex min-h-16 cursor-pointer flex-col items-start gap-1 border-t border-line px-1 py-2 text-left sm:min-h-28 sm:cursor-default sm:px-1.5 ${
                selected === key ? 'bg-white/[0.03] sm:bg-transparent' : ''
              }`}
            >
              <span className={`contents ${inMonth ? '' : '[&>*]:opacity-30'}`}>
              <span
                className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
                  isToday ? 'bg-white text-black' : items.length ? 'text-white' : 'text-faint'
                }`}
              >
                {day.getDate()}
              </span>
              {items.length > 0 ? (
                <>
                  <span className="flex gap-1 pl-1.5 sm:hidden" aria-hidden>
                    {items.slice(0, 3).map((entry) => (
                      <span key={entry.key} className="size-1.5 rounded-full bg-white" />
                    ))}
                  </span>
                  <span className="hidden w-full min-w-0 space-y-1 sm:block">
                    {items.slice(0, 3).map((entry) => (
                      <Link
                        key={entry.key}
                        href={titleHref({ id: entry.showId, mediaType: 'tv' })}
                        className="block truncate rounded-md bg-control px-2 py-1 text-xs text-white transition-colors hover:bg-control-hover"
                      >
                        {entry.title}
                        <span className="ml-1 text-faint">E{entry.episode}</span>
                      </Link>
                    ))}
                    {items.length > 3 ? (
                      <span className="block px-2 text-xs text-faint">+{items.length - 3} more</span>
                    ) : null}
                  </span>
                </>
              ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 border-t border-line pt-4 sm:hidden">
        <p className="text-sm font-medium">
          {relativeDay(parseKey(selected), today)}
          <span className="ml-2 text-faint">{shortDate(parseKey(selected))}</span>
        </p>
        {selectedItems.length ? (
          <ul className="mt-3 space-y-3">
            {selectedItems.map((entry) => (
              <EntryRow key={entry.key} entry={entry} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-faint">No new episodes.</p>
        )}
      </div>
    </>
  );
}

function parseKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year!, month! - 1, day!);
}

/** Every upcoming episode, grouped by day. */
function ListView({ entries, today }: { entries: ScheduleEntry[]; today: Date }) {
  const groups = [...entriesByDay(entries).values()];
  return (
    <div className="mt-6">
      {groups.map((items) => {
        const date = items[0]!.date;
        return (
          <div key={items[0]!.airDate} className="grid gap-3 border-t border-line py-4 sm:grid-cols-[12rem_1fr]">
            <p className="text-sm font-medium">
              {relativeDay(date, today)}
              <span className="ml-2 text-faint">{shortDate(date)}</span>
            </p>
            <ul className="space-y-3">
              {items.map((entry) => (
                <EntryRow key={entry.key} entry={entry} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function EntryRow({ entry }: { entry: ScheduleEntry }) {
  return (
    <li>
      <Link
        href={titleHref({ id: entry.showId, mediaType: 'tv' })}
        className="group flex items-center gap-3"
      >
        <div className="aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-md bg-surface">
          {entry.posterPath ? (
            <img src={posterUrl(entry.posterPath, 'w185')} alt="" loading="lazy" className="size-full object-cover" />
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium transition-colors group-hover:text-muted">{entry.title}</p>
          <p className="truncate text-xs text-faint">
            {episodeCode(entry)}
            {entry.name && !/^episode \d+$/i.test(entry.name) ? ` · ${entry.name}` : ''}
          </p>
        </div>
      </Link>
    </li>
  );
}
