import { IoArrowBack } from 'react-icons/io5';
import { useNavigate } from 'react-router';
import { useDocumentTitle } from '@/lib/use-document-title';

export function LegalPage() {
  useDocumentTitle('Legal');
  const navigate = useNavigate();
  const currentYear = new Date().getFullYear();

  return (
    <main className="min-h-dvh bg-[#0f0f0f] px-6 py-24 text-white">
      <article className="mx-auto max-w-2xl">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mb-10 flex cursor-pointer items-center gap-2 text-sm text-white/40 transition-colors hover:text-white/70"
        >
          <IoArrowBack size={16} />
          Back
        </button>

        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">Legal</p>
        <h1 className="mt-3 text-4xl font-bold">Legal Information</h1>

        <div className="mt-12 space-y-8 text-[15px] leading-relaxed text-white/60">
          <p>
            Cubo is a content discovery interface. It does not upload, store, or host any media
            files. Catalogue information comes from publicly available metadata APIs, and playback
            is handled entirely by Cubo Core running on hardware you control.
          </p>

          <p>
            Because Cubo hosts nothing, it has no technical ability to remove content from networks
            or servers it does not operate. Removal requests must be sent to the platforms where the
            material actually resides — only those platforms can act on their own files.
          </p>

          <p>
            Cubo respects intellectual property rights. If you are a rights holder seeking to report
            content, we will assist by pointing you to the source where the material was indexed, and
            we will cooperate with legitimate legal requests to the extent that is technically
            possible.
          </p>

          <p>
            Cubo maintains no ownership or control over any media content. Users are solely
            responsible for how they configure Cubo Core and for how they interact with the
            third-party services reached through it, including compliance with the laws that apply
            where they live.
          </p>
        </div>

        <p className="mt-20 text-sm text-white/25">
          &copy; {currentYear} Cubo. All rights reserved.
        </p>
      </article>
    </main>
  );
}
