/**
 * The shared shell for the four post-profile stage pages.
 *
 * Deliberately plain. These are states an applicant sits in, not surfaces to
 * be designed around yet — the page they matter on is the one the server
 * routes them to, and getting the ROUTING right is what this task is for.
 */
export function StageNotice({
  title,
  body,
  detail,
}: {
  title: string;
  body: string;
  detail?: string | null;
}) {
  return (
    <main id="main-content" className="flex-1 px-5 py-16 sm:py-24">
      <div className="mx-auto max-w-[640px] text-center">
        <h1 className="text-[28px] font-bold text-ink">{title}</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">{body}</p>
        {detail ? (
          <p className="mt-6 rounded-[var(--radius-token-card)] border border-line bg-surface px-5 py-4 text-[14px] text-ink">
            {detail}
          </p>
        ) : null}
      </div>
    </main>
  );
}
