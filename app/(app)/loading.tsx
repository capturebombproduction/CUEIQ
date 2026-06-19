// Shown instantly on every in-app navigation while the (force-dynamic) page
// renders on the server. Without it, clicking a link blocks on the server render
// and the app feels frozen; this skeleton makes navigation feel immediate.
export default function Loading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="กำลังโหลด">
      {/* title row */}
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="h-7 w-48 rounded-md bg-muted" />
          <div className="h-4 w-32 rounded bg-muted/70" />
        </div>
        <div className="h-9 w-28 rounded-md bg-muted" />
      </div>
      {/* content cards */}
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-xl border bg-card p-4">
            <div className="h-4 w-1/3 rounded bg-muted" />
            <div className="mt-2 h-3 w-1/2 rounded bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
