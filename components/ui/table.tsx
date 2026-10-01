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
  <div className="relative w-full overflow-auto rounded-[2px] bg-card shadow-edge">
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-sm", className)}
      {...props}
    />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      "sticky top-0 z-10 bg-card/95 [&_tr]:h-10 [&_th]:border-b [&_th]:border-border [&_tr]:hover:bg-transparent",
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
