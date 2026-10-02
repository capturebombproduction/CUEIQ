import * as React from "react";

import { cn } from "@/lib/utils";

// Spec §E.8: a table is one slab, its rows divided by hairlines, the current row
// marked by a 4 px band rail. Below md a table with more than four columns should
// render as stacked slab rows instead (Library, Overview, Admin users, Crew) — that
// is each page's job.
//
// NOTHING IS PAINTED ON A <tr>. The spec drew the hairlines and the rail as box-shadow
// on the row, which WebKit — every iPhone browser, iPad Safari — does not paint on a
// table-row box (webkit.org/b/74156, inset: b/44654). The run sheet is usually
// exported from a phone, by that same engine, so the JPG would lose every line too.
// So the hairline is a border on each CELL (WebKit paints those, and a border still
// prints with "background graphics" off, where a box-shadow is dropped), and the rail
// is an inset shadow on the FIRST cell, separate from the hairline so neither
// replaces the other. A row background (hover, selected, a caller's tint) is fine.

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  // Scrolls sideways below md, clips sideways from md. ANY overflow other than
  // visible / clip makes this box the scroll container of everything sticky inside
  // it, and it never scrolls vertically — so the header below never stuck to the
  // page. `clip` clips sideways without becoming a scroll container (overflow-y
  // stays visible), like <main>'s own sideways clip. The price: from md a table
  // wider than its slab is cut, not scrolled, so every table on this primitive (the
  // Library, the Event summary's setlist) has to fit at 768. Where `clip` is not
  // supported (Safari < 16) the sideways scroll stands at every width, and the
  // header's offset below is withheld with it (it is gated on the same support).
  <div className="relative w-full overflow-x-auto rounded-[2px] bg-card shadow-edge md:overflow-x-clip">
    {/* border-separate + spacing 0 draws the same lines as the collapsed model (every
        line is a bottom border on a cell) but keeps the header's underline attached
        to the header once it sticks: collapsed borders belong to the table, stay put
        and let the rows slide under a header with no line below it. */}
    <table
      ref={ref}
      className={cn("w-full caption-bottom border-separate border-spacing-0 text-sm", className)}
      {...props}
    />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  // Sticks UNDER the fixed app header (the Event page's tab row uses the same offset),
  // not at the viewport's top edge where the header would cover it. Solid bg-card, not
  // /95: rows scroll under it and 5 % of a bright cover tile still ghosts through.
  //
  // The offset is for md+ ONLY, and only where the wrapper's sideways clip took (see
  // Table). Anywhere the wrapper still scrolls sideways — every phone, a window under
  // 768, Safari < 16 at any width — the wrapper is this header's scroll container, so
  // `top` is measured from the WRAPPER: a 52 px offset there pushes the header down
  // onto row 1 (on screen, in the summary JPG a phone exports, in print). A zero top
  // there is a header that stays in its own place. Static in print, for the same
  // reason at md+: a printed page is ≥ 768 px wide, and a sticky box offset from the
  // top of a printed page has no app header to sit under.
  <thead
    ref={ref}
    className={cn(
      "sticky top-0 md:supports-[overflow:clip]:top-[calc(var(--header-h)+var(--offline-strip-h,0px)+env(safe-area-inset-top))] print:static z-10 bg-card [&_tr]:h-10 [&_th]:border-b [&_th]:border-border [&_tr]:hover:bg-transparent",
      className
    )}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    // The slab's own edge closes the last row. Only the hairline goes: the rail is a
    // shadow, not a border, so a current last row keeps it.
    className={cn("[&>tr:last-child>td]:border-b-0", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

/**
 * `data-current` marks the live / selected-for-action row: a 4 px band rail, drawn as
 * an inset shadow on the row's first cell (see the note at the top: never on the <tr>).
 * One arbitrary variant, `[&[data-current=true]>td:first-child]`: the stacked form
 * `data-[current=true]:[&>td:first-child]` compiles to `>td:first-child[data-current]`,
 * i.e. it looks for the attribute on the cell and never matches.
 */
const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { "data-current"?: boolean | "true" | "false" }
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "h-14 transition-colors hover:bg-muted/50 data-[state=selected]:bg-primary/[.08] [&>td]:border-b [&>td]:border-border/70 [&[data-current=true]>td:first-child]:shadow-[inset_4px_0_0_hsl(var(--primary))]",
      className
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

/** Column heads are English chrome: display caps, tracked, muted. */
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-10 px-3 text-left align-middle font-display text-[12.5px] font-bold uppercase tracking-[.1em] text-muted-foreground [font-synthesis:none] [&:has([role=checkbox])]:pr-0",
      className
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

/** Numeric columns add `num text-right text-[15px]`. */
const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("px-3 py-2.5 align-middle [&:has([role=checkbox])]:pr-0", className)}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
