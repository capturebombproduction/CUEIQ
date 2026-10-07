import { describe, expect, it } from "vitest";
import { isPushServiceEndpoint } from "@/lib/push-endpoint";

describe("isPushServiceEndpoint", () => {
  it("the push services browsers really use", () => {
    for (const e of [
      "https://web.push.apple.com/QGdNh8yZ", // the one in prod (an iPhone)
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://android.googleapis.com/gcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isPushServiceEndpoint(e), e).toBe(true);
    }
  });
  it("never any other host, a look-alike, plain http, a port, or credentials", () => {
    for (const e of [
      "https://evil.example/push",
      "https://push.apple.com.evil.example/x",
      "https://evilpush.apple.com.example/x",
      "https://notpush-apple.com/x",
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pw@fcm.googleapis.com/fcm/send/abc",
      "https://169.254.169.254/latest/meta-data",
      "not a url",
      null,
    ]) {
      expect(isPushServiceEndpoint(e), String(e)).toBe(false);
    }
  });
});
