import {
  BookOpen,
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  CircleX,
  Hourglass,
  NotebookText,
  OctagonAlert,
  StickyNote,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { MetaIconKey } from "@/lib/types";

/**
 * The lucide icon behind each `icon` key in lib/types.ts's *_META maps
 * (STATUS_META, COPYRIGHT_META, PRACTICE_CATEGORY_META). Each key is the icon's own
 * kebab-case name, so `lucide-<key>` is also the class the rendered svg carries.
 */
export const META_ICONS: Record<MetaIconKey, LucideIcon> = {
  "circle-dashed": CircleDashed,
  "circle-dot-dashed": CircleDotDashed,
  hourglass: Hourglass,
  "circle-check": CircleCheck,
  "circle-x": CircleX,
  "octagon-alert": OctagonAlert,
  "sticky-note": StickyNote,
  "triangle-alert": TriangleAlert,
  "notebook-text": NotebookText,
  "book-open": BookOpen,
};

/**
 * The icon a *_META entry names, for the place that also says its word (status is
 * icon + word, never colour or an emoji alone), so it is hidden from screen readers.
 * Inside a chip (`<Badge>`) `.chip svg` sizes it; elsewhere pass a size class.
 * A missing or unknown key (an offline cached row without the field) draws nothing.
 */
export function MetaIcon({ icon, className }: { icon: MetaIconKey | undefined; className?: string }) {
  const Icon = icon && Object.prototype.hasOwnProperty.call(META_ICONS, icon) ? META_ICONS[icon] : null;
  return Icon ? <Icon aria-hidden className={className} /> : null;
}
