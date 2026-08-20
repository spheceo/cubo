import { Outlet, Route, Routes } from 'react-router';
import { CoreProvider } from '@/components/core-provider';
import { DesktopWindowFrame } from '@/components/desktop-window-frame';
import { MotionProvider } from '@/components/motion-provider';
import { ScrollToTop } from '@/components/scroll-to-top';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { CatalogPage } from '@/pages/catalog';
import { HomePage } from '@/pages/home';
import { LibraryPage } from '@/pages/library';
import { NotFoundPage } from '@/pages/not-found';
import { SearchPage } from '@/pages/search';
import { TitlePage } from '@/pages/title';
import { WatchPage } from '@/pages/watch';

function SiteLayout() {
  return (
    <>
      <SiteHeader />
      <Outlet />
      <SiteFooter />
    </>
  );
}

export function App() {
  return (
    <>
      <DesktopWindowFrame />
      <MotionProvider>
        <CoreProvider>
          <ScrollToTop />
          <Routes>
            <Route element={<SiteLayout />}>
              <Route index element={<HomePage />} />
              <Route path="movies" element={<CatalogPage mediaType="movie" />} />
              <Route path="tv-shows" element={<CatalogPage mediaType="tv" />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="library" element={<LibraryPage />} />
              <Route path="movie/:id" element={<TitlePage mediaType="movie" />} />
              <Route path="tv/:id" element={<TitlePage mediaType="tv" />} />
            </Route>
            <Route path="watch/:mediaType/:id" element={<WatchPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </CoreProvider>
      </MotionProvider>
    </>
  );
}
