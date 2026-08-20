export function HeroSkeleton() {
  return (
    <div className="relative h-[82dvh] overflow-hidden bg-panel">
      <div className="absolute inset-0 animate-pulse bg-linear-to-br from-white/[0.08] via-white/[0.03] to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-b from-transparent to-background" />
      <div className="absolute bottom-20 left-6 w-full max-w-[620px] space-y-5 sm:left-10">
        <div className="h-16 w-3/4 rounded-lg bg-white/10" />
        <div className="h-5 w-1/3 rounded bg-white/10" />
        <div className="space-y-3">
          <div className="h-4 w-full rounded bg-white/10" />
          <div className="h-4 w-5/6 rounded bg-white/10" />
        </div>
        <div className="h-11 w-36 rounded-full bg-white/10" />
      </div>
    </div>
  );
}

export function MediaRowSkeleton() {
  return (
    <section className="space-y-5">
      <div className="h-7 w-48 animate-pulse rounded bg-white/10" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="aspect-[2/3] w-[38vw] shrink-0 animate-pulse rounded-xl bg-white/[0.07] sm:w-[24vw] md:w-[14vw] xl:w-[11vw]"
          />
        ))}
      </div>
    </section>
  );
}

export function MediaRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-10 px-6 py-4 sm:px-10">
      {Array.from({ length: rows }).map((_, index) => (
        <MediaRowSkeleton key={index} />
      ))}
    </div>
  );
}

export function MediaGridSkeleton({ count = 16 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="aspect-[2/3] animate-pulse rounded-xl bg-white/[0.07]" />
      ))}
    </div>
  );
}

export function TitleSkeleton() {
  return (
    <main className="relative h-dvh overflow-hidden bg-background text-white">
      <div className="absolute inset-0 animate-pulse bg-linear-to-r from-[#111] via-[#1c1c1c] to-[#111]" />
      <div className="absolute inset-0 bg-linear-to-r from-black via-black/70 to-black/20" />
      <div className="absolute inset-0 bg-linear-to-t from-background via-transparent to-black/30" />

      <section className="relative z-10 flex h-dvh max-w-[760px] flex-col justify-center px-6 py-24 sm:px-10 md:px-20">
        <div className="h-16 w-[72%] rounded-lg bg-white/10" />
        <div className="mt-7 flex items-center gap-3">
          <div className="h-6 w-24 rounded bg-white/10" />
          <div className="h-6 w-16 rounded bg-white/10" />
          <div className="h-6 w-28 rounded bg-white/10" />
        </div>
        <div className="mt-8 space-y-3">
          <div className="h-6 w-28 rounded bg-white/10" />
          <div className="flex gap-3">
            <div className="h-10 w-24 rounded-full bg-white/10" />
            <div className="h-10 w-28 rounded-full bg-white/10" />
            <div className="h-10 w-20 rounded-full bg-white/10" />
          </div>
        </div>
        <div className="mt-10 space-y-3">
          <div className="h-6 w-32 rounded bg-white/10" />
          <div className="h-4 w-[72%] rounded bg-white/10" />
          <div className="h-4 w-[66%] rounded bg-white/10" />
          <div className="h-4 w-[58%] rounded bg-white/10" />
        </div>
        <div className="mt-10 flex items-center gap-4">
          <div className="h-14 w-60 rounded-full bg-white/10" />
          <div className="h-14 w-14 rounded-full bg-white/10" />
        </div>
      </section>
    </main>
  );
}
