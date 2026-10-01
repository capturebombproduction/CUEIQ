// Shown instantly on every in-app navigation while the (force-dynamic) page
// renders on the server. Without it, clicking a link blocks on the server render
// and the app feels frozen; this skeleton makes navigation feel immediate.
//
// Shaped like the screen most navigations land on (Home): the page title row, the
// one hero, a segmented row, then a stack of show stubs with their date tiles — so
// the page that arrives does not jump. Opacity pulse only (spec §H: no shimmer);
// the reduced-motion rule stops it.
export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="กำลังโหลด">
      {/* title row: the 56 px display H1 + a right slot */}
      <div className="flex items-end justify-between gap-3 pt-1.5">
        <div className="h-[47px] w-48 rounded-[2px] bg-muted" />
        <div className="h-9 w-24 rounded-[2px] bg-muted/70" />
      </div>
      {/* the hero */}
      <div className="space-y-3 rounded-[2px] bg-card p-4 shadow-edge">
        <div className="flex items-center justify-between">
          <div className="h-4 w-32 rounded-[2px] bg-muted" />
          <div className="h-6 w-24 rounded-[2px] bg-muted/70" />
        </div>
        <div className="h-4 w-40 rounded-[2px] bg-muted/70" />
        <div className="h-8 w-3/4 rounded-[2px] bg-muted" />
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="h-12 rounded-[3px] bg-muted" />
          <div className="h-12 rounded-[3px] bg-muted/70" />
        </div>
      </div>
      {/* a segmented row */}
      <div className="h-11 rounded-[3px] bg-muted/70" />
      {/* show stubs */}
      <div className="flex flex-col gap-[2px]">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-[92px] overflow-hidden rounded-[2px] bg-card shadow-edge">
            <div className="w-[72px] shrink-0 bg-muted" />
            <div className="flex-1 space-y-2 px-3.5 py-3">
              <div className="h-3 w-1/3 rounded-[2px] bg-muted/70" />
              <div className="h-4 w-2/3 rounded-[2px] bg-muted" />
              <div className="h-3 w-1/2 rounded-[2px] bg-muted/70" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
