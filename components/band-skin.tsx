import { skinCss } from "@/lib/skin";

/**
 * Server-injected band skin. When a band has a `skin` hex, its event pages and
 * share run sheet are themed to it (overrides the per-device accent while on that
 * band's pages — the branding moment). No hex = render nothing.
 */
export function BandSkin({ hex }: { hex?: string | null }) {
  if (!hex) return null;
  return <style id="cueiq-band-skin" dangerouslySetInnerHTML={{ __html: skinCss(hex) }} />;
}
