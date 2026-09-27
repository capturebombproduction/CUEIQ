import { describe, it, expect, afterEach, vi } from "vitest";
import { isInAppBrowser } from "./platform";

// Real user agents, trimmed only of irrelevant version noise.
const UA = {
  line: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.9.1",
  facebook:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.35.108;FBBV/123]",
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.30.94 (iPhone15,2; iOS 18_5)",
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  ipadDesktopSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Safari/605.1.15",
  chromeIOS:
    "Mozilla/5.0 (iPad; CPU OS 26_5_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/149.0.7827.137 Mobile/15E148 Safari/604.1",
};

const withUA = (ua: string) => vi.stubGlobal("navigator", { userAgent: ua });
afterEach(() => vi.unstubAllGlobals());

describe("isInAppBrowser", () => {
  it.each(["line", "facebook", "instagram"] as const)("recognises %s's built-in browser", (k) => {
    withUA(UA[k]);
    expect(isInAppBrowser()).toBe(true);
  });

  it.each(["safari", "ipadDesktopSafari", "chromeIOS"] as const)(
    "does not mistake %s for one — it can add to the home screen itself",
    (k) => {
      withUA(UA[k]);
      expect(isInAppBrowser()).toBe(false);
    }
  );
});
