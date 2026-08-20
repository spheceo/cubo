import { lazy, Suspense } from 'react';
import { Outlet, Route, Routes, useLocation } from 'react-router';
import { ConnectionBanner } from '@/components/connection-banner';
import { CoreProvider } from '@/components/core-provider';
import { DesktopWindowFrame } from '@/components/desktop-window-frame';
import { ScrollToTop } from '@/components/scroll-to-top';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { CatalogPage } from '@/pages/catalog';
import { HomePage } from '@/pages/home';
import { NotFoundPage } from '@/pages/not-found';
import { SearchPage } from '@/pages/search';
import { TitlePage } from '@/pages/title';

const WatchPage = lazy(() =>
  import('@/pages/watch').then((module) => ({ default: module.WatchPage })),
);
const LibraryPage = lazy(() =>
  import('@/pages/library').then((module) => ({ default: module.LibraryPage })),
);
const LegalPage = lazy(() =>
  import('@/pages/legal').then((module) => ({ default: module.LegalPage })),
);

function SiteLayout() {
  const { pathname } = useLocation();
  const isTitlePage = /^\/(?:movie|tv)\/[^/]+\/?$/.test(pathname);

  return (
    <>
      <SiteHeader />
      <Outlet />
      {!isTitlePage ? <SiteFooter /> : null}
    </>
  );
}

function PageFallback() {
  return <div className="min-h-dvh bg-background" aria-hidden="true" />;
}

export function App() {
  return (
    <>
      <DesktopWindowFrame />
      <CoreProvider>
        <ScrollToTop />
        <ConnectionBanner />
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route element={<SiteLayout />}>
              <Route index element={<HomePage />} />
              <Route path="movies" element={<CatalogPage mediaType="movie" />} />
              <Route path="tv-shows" element={<CatalogPage mediaType="tv" />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="library" element={<LibraryPage />} />
              <Route path="legal" element={<LegalPage />} />
              <Route path="movie/:id" element={<TitlePage mediaType="movie" />} />
              <Route path="tv/:id" element={<TitlePage mediaType="tv" />} />
            </Route>
            <Route path="watch/:mediaType/:id" element={<WatchPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </CoreProvider>
    </>
  );
}
