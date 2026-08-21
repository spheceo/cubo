import { useEffect, useState } from 'react';
import {
  FALLBACK_LEGAL,
  fetchPublishedLegal,
  legalDocFrom,
  splitInlineMarkdown,
  type LegalDoc,
} from '../../../legal';
import { useDocumentTitle } from '@/lib/use-document-title';

function useLegalDoc(): LegalDoc {
  const [doc, setDoc] = useState(() => legalDocFrom(FALLBACK_LEGAL));
  useEffect(() => {
    let cancelled = false;
    void fetchPublishedLegal().then((live) => {
      if (!cancelled && live) setDoc(live);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return doc;
}

function LegalInlineText({ text }: { text: string }) {
  return (
    <>
      {splitInlineMarkdown(text).map((part, index) =>
        part.type === 'link' ? (
          <a
            key={index}
            href={part.href}
            rel="noreferrer"
            className="text-fg underline underline-offset-[3px] hover:text-muted"
          >
            {part.label}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}

export function LegalPage() {
  useDocumentTitle('Legal');
  const doc = useLegalDoc();

  return (
    <main className="min-h-dvh bg-background px-6 pt-28 pb-8 text-fg">
      <div className="mx-auto w-full max-w-[1080px]">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-faint">Legal</p>
        <h1 className="mt-3 text-[clamp(2.4rem,5.5vw,3.6rem)] font-bold leading-[1.03] tracking-[-0.035em]">
          {doc.title}
        </h1>
        <p className="mt-6 max-w-xl text-[1.05rem] leading-relaxed text-pretty text-muted">
          <LegalInlineText text={doc.lede} />
        </p>

        <section className="mt-12 border-t border-line">
          {doc.sections.map((section) => (
            <article key={section.title} className="border-b border-line py-7">
              <h2 className="text-[1.02rem] font-semibold tracking-[-0.012em]">{section.title}</h2>
              {section.paragraphs.map((paragraph) => (
                <p
                  key={paragraph}
                  className="mt-2.5 max-w-[62ch] text-[0.95rem] leading-relaxed text-pretty text-muted"
                >
                  <LegalInlineText text={paragraph} />
                </p>
              ))}
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
