import { Children, isValidElement, type ReactNode } from "react";

// The redesign's display faces (Barlow Condensed, caps, italic) are for ENGLISH chrome.
// Barlow has no Thai glyphs, so Thai inside a display element falls through to Kanit
// glyph by glyph — upright, but still carrying the display tracking, the poster size
// and the tight line-height that clips Kanit's tall tone marks. Primitives whose
// default is display type (CardTitle, DialogTitle, PageTitle, the title slab) ask
// this instead of trusting every one of ~100 call sites to remember a `th` class.

/** Any character in the Thai block (U+0E00–U+0E7F): consonants, vowels, tone marks, digits. */
export const THAI_RE = /[\u0E00-\u0E7F]/;

/**
 * True when any text in `node` — strings and numbers, at any depth of element
 * children — contains Thai. Elements are walked through their `children` prop only:
 * an icon or a component that renders its own text from other props is not text
 * the caller wrote into this title, so it does not count.
 */
export function hasThai(node: ReactNode): boolean {
  let found = false;
  Children.forEach(node, (child) => {
    if (found) return;
    if (typeof child === "string" || typeof child === "number") {
      found = THAI_RE.test(String(child));
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      found = hasThai(child.props.children);
    }
  });
  return found;
}
