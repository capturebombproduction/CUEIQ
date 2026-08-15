// A LOCAL STUB of Supabase Realtime, for the two-device smoke.
//
//   import { attachSmokeRealtime } from "./smoke-realtime.mjs";
//   const realtime = attachSmokeRealtime(httpServer);   // takes over "upgrade"
//   …two app processes join realtime:live:<event> and talk to each other…
//   realtime.close();
//
// WHY THIS EXISTS. desktop/scripts/smoke-backend.mjs answers the HTTP half of
// Supabase and REFUSES the websocket upgrade, which is the honest simulation of a
// venue with no internet — and it is why every scenario so far has been about ONE
// device. The remaining hand-run item on this project is the opposite case: two
// devices, both online, one running the show and one joining it. Its logic is
// covered by unit tests (lib/live-arbitration.ts) and its wiring by jsdom tests,
// but nothing has ever run the two halves as two real processes over a real
// socket — and the worst bug this project has shipped lived exactly there (a phone
// that merely OPENED the live page could win the arbitration against a PA that had
// reloaded mid-show, and stop the music).
//
// So: speak enough of the wire protocol that the app's own realtime client joins,
// broadcasts and receives without knowing anything changed. Nothing about the app
// is modified — main.cjs points the socket here the same way it points the REST
// calls at the HTTP stub.
//
// ⚠️ IT IS A TEST FIXTURE, NOT A PRODUCT.
//   • plain node:http + node:crypto, zero dependencies, and nothing under
//     desktop/src or lib/ may import it (desktop/src/data/smoke-realtime.test.ts
//     asserts that, the same way it is asserted for smoke-backend.mjs);
//   • it implements the SLICE of the protocol this app uses — join, leave,
//     heartbeat, access_token, and broadcast relay. Presence and postgres_changes
//     are NOT implemented, and a join asking for them is answered loudly rather
//     than with a silent empty subscription;
//   • it authorizes nothing. Every join succeeds. RLS-backed topic authorization
//     (0040_realtime_authorization.sql) is a server property and cannot be proved
//     by a stub that IS the server — asserting on it here would be a test grading
//     its own homework.
//
// ── THE WIRE FORMAT, WHICH IS TWO FORMATS ───────────────────────────────────
// @supabase/realtime-js 2.108's Serializer encodes MOST messages as a JSON array
// `[join_ref, ref, topic, event, payload]` — but a client→server BROADCAST push is
// encoded as BINARY (kind byte 3) with a packed header of one-byte lengths. Decode
// both or the show state simply never arrives, and the failure looks like "the
// other device is silent" rather than like a parser that gave up. Server→client
// may always be the JSON array form: the same serializer's decode() accepts a
// string for every event, including broadcast.
import crypto from "node:crypto";

/** RFC 6455's magic GUID, concatenated with the client key to form the accept. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** The serializer's binary "user broadcast push" kind, and its header layout.
 *  Mirrors _encodeUserBroadcastPush in @supabase/realtime-js/lib/serializer.js —
 *  kept as named constants so a future version bump that changes the layout fails
 *  on a named constant rather than on an off-by-one in a slice(). */
const BROADCAST_PUSH_KIND = 3;
const BROADCAST_RELAY_KIND = 4; // server→client binary form; we do not emit it
const ENCODING_JSON = 1;

/**
 * Decode one client→server frame payload into `{join_ref, ref, topic, event, payload}`.
 *
 * Exported for desktop/src/data/smoke-realtime.test.ts, which feeds it the output
 * of the REAL serializer rather than hand-built bytes — the only way to notice a
 * dependency bump changing the format, which would otherwise show up as a
 * two-device test that hangs for reasons nothing in this repo explains.
 */
export function decodeClientMessage(data, isBinary) {
  if (!isBinary) {
    const [join_ref, ref, topic, event, payload] = JSON.parse(data.toString("utf8"));
    return { join_ref, ref, topic, event, payload };
  }
  const kind = data.readUInt8(0);
  if (kind !== BROADCAST_PUSH_KIND) {
    throw new Error(
      `smoke-realtime: binary message kind ${kind} is not implemented ` +
        `(only ${BROADCAST_PUSH_KIND} = user broadcast push)`
    );
  }
  const joinRefLen = data.readUInt8(1);
  const refLen = data.readUInt8(2);
  const topicLen = data.readUInt8(3);
  const eventLen = data.readUInt8(4);
  const metaLen = data.readUInt8(5);
  const encoding = data.readUInt8(6);
  let offset = 7;
  const take = (n) => {
    const slice = data.subarray(offset, offset + n).toString("utf8");
    offset += n;
    return slice;
  };
  const join_ref = take(joinRefLen);
  const ref = take(refLen);
  const topic = take(topicLen);
  const userEvent = take(eventLen);
  const meta = take(metaLen);
  const body = data.subarray(offset);
  if (encoding !== ENCODING_JSON) {
    // An ArrayBuffer payload. The app never sends one (every broadcast in
    // components/event/live-mode.tsx is a plain object), and guessing at bytes is
    // how a stub starts lying about what it received.
    throw new Error("smoke-realtime: binary broadcast payloads are not implemented");
  }
  return {
    join_ref: join_ref || null,
    ref: ref || null,
    topic,
    event: "broadcast",
    payload: {
      type: "broadcast",
      event: userEvent,
      payload: body.length > 0 ? JSON.parse(body.toString("utf8")) : {},
      ...(metaLen > 0 ? { meta: JSON.parse(meta) } : {}),
    },
  };
}

/** Server→client, always the JSON array form (see the header). */
export function encodeServerMessage({ join_ref = null, ref = null, topic, event, payload }) {
  return JSON.stringify([join_ref, ref, topic, event, payload]);
}

// ---------------------------------------------------------------------------
// The websocket itself — handshake and framing, by hand
// ---------------------------------------------------------------------------

/** Frame a server→client message. Server frames are never masked. */
function frame(opcode, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(length, 1);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Pull complete frames out of a growing buffer.
 *
 * Returns `{ frames, rest }`. Continuation frames ARE assembled: a show-state
 * broadcast carrying a long setlist is comfortably under any sane fragmentation
 * threshold today, but a test harness that silently dropped the tail of a message
 * would produce exactly the symptom this whole scenario is meant to detect.
 */
function readFrames(buffer, partial) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer.readUInt8(offset);
    const second = buffer.readUInt8(offset + 1);
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("smoke-realtime: frame too large");
      length = Number(big);
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const body = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    cursor += length;
    offset = cursor;

    if (opcode === OPCODES.continuation) {
      if (!partial.opcode) throw new Error("smoke-realtime: continuation with nothing to continue");
      partial.chunks.push(body);
      if (fin) {
        frames.push({ opcode: partial.opcode, body: Buffer.concat(partial.chunks) });
        partial.opcode = 0;
        partial.chunks = [];
      }
      continue;
    }
    if (!fin && (opcode === OPCODES.text || opcode === OPCODES.binary)) {
      partial.opcode = opcode;
      partial.chunks = [body];
      continue;
    }
    frames.push({ opcode, body });
  }
  return { frames, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// The realtime server
// ---------------------------------------------------------------------------

/**
 * Take over an http.Server's "upgrade" event and speak realtime on it.
 *
 * @param {import("node:http").Server} server  the HTTP stub's server, so the app
 *        reaches both halves of Supabase at ONE host — which is what lets main.cjs
 *        point the socket at the stub with the same host rewrite it already uses.
 * @param {object} [options]
 * @param {string} [options.path="/realtime/v1/websocket"]
 *
 * ⚠️ NO `@returns` annotation on purpose: this file is plain .mjs and its callers
 * are typechecked (desktop/tsconfig.json includes "scripts", allowJs). A
 * hand-written return type here is a second declaration that drifts — the first
 * cut of it omitted `broadcastsOf` and turned a working call into five tsc errors.
 * Inference off the returned object is always in step.
 */
export function attachSmokeRealtime(server, options = {}) {
  const { path: wsPath = "/realtime/v1/websocket" } = options;

  /** Every decoded client→server message, in order. The two-device scenario reads
   *  this to prove the devices really talked THROUGH here — a pass built on
   *  messages that never crossed the socket would be a pass built on nothing.
   *
   *  Typed by hand because an empty array literal infers as never[], and every
   *  read of `m.event` downstream would then be an error rather than a check.
   *  `DECODE_ERROR` / `PARSE_ERROR` ride the same list: a message this stub could
   *  not read is a finding, and putting it anywhere else would let it be missed.
   *  @type {Array<{
   *    client: number,
   *    topic?: string,
   *    event: string,
   *    payload?: { type?: string, event?: string, payload?: unknown },
   *    error?: string,
   *  }>} */
  const messages = [];
  /** Sockets, keyed by an id, each with the set of topics it has joined. */
  const clients = new Map();
  let nextId = 1;

  const send = (client, message) => {
    if (client.socket.destroyed) return;
    client.socket.write(frame(OPCODES.text, encodeServerMessage(message)));
  };

  /** A phoenix reply on the message's own ref. Absent one of these, the client's
   *  join push times out after 10s and the channel reports CHANNEL_ERROR — which
   *  the app handles gracefully, so the scenario would go green while proving the
   *  OFFLINE path a second time instead of the two-device one. */
  const reply = (client, message, response, status = "ok") =>
    send(client, {
      join_ref: message.join_ref ?? null,
      ref: message.ref ?? null,
      topic: message.topic,
      event: "phx_reply",
      payload: { status, response },
    });

  function handleMessage(client, message) {
    messages.push({ client: client.id, topic: message.topic, event: message.event, payload: message.payload });

    if (message.topic === "phoenix" && message.event === "heartbeat") {
      reply(client, message, {});
      return;
    }

    switch (message.event) {
      case "phx_join": {
        const config = message.payload?.config ?? {};
        // Loud rather than silently empty: a channel that asked for presence or
        // postgres_changes and got `{}` back subscribes happily and then never
        // fires, which is indistinguishable from a bug in the app.
        if (config.presence?.enabled) {
          reply(client, message, { reason: "smoke-realtime does not implement presence" }, "error");
          return;
        }
        if (Array.isArray(config.postgres_changes) && config.postgres_changes.length > 0) {
          reply(
            client,
            message,
            { reason: "smoke-realtime does not implement postgres_changes" },
            "error"
          );
          return;
        }
        client.topics.add(message.topic);
        client.joinRefs.set(message.topic, message.join_ref ?? null);
        // The real server answers a join with the postgres_changes it bound, and
        // realtime-js reads exactly that field off the response.
        reply(client, message, { postgres_changes: [] });
        return;
      }
      case "phx_leave": {
        client.topics.delete(message.topic);
        reply(client, message, {});
        return;
      }
      case "access_token": {
        // The client re-sends its JWT on every token refresh. Nothing here
        // verifies it (see the header), but a missing reply would leave a push
        // pending forever in the client's buffer.
        reply(client, message, {});
        return;
      }
      case "broadcast": {
        // THE ONE THAT MATTERS. Relay to every OTHER socket joined to this topic.
        // Never back to the sender: every call site in the app sets
        // `broadcast: { self: false }` and applies its own change locally first,
        // so echoing would deliver each device its own state as if a peer had
        // sent it — the exact shape of the bug this scenario hunts.
        for (const peer of clients.values()) {
          if (peer === client) continue;
          if (!peer.topics.has(message.topic)) continue;
          send(peer, {
            join_ref: peer.joinRefs.get(message.topic) ?? null,
            ref: null,
            topic: message.topic,
            event: "broadcast",
            payload: message.payload,
          });
        }
        // An ack is only expected when the push asked for one (config.broadcast.ack),
        // which this app never sets — but the ref is there when it does, and replying
        // on a ref the client is not waiting on is harmless.
        if (message.ref) reply(client, message, {});
        return;
      }
      default:
        // Unknown events are RECORDED and answered rather than ignored: silence
        // here would show up as a client stuck waiting, twenty seconds away from
        // a timeout no message explains.
        if (message.ref) reply(client, message, { reason: `unhandled event ${message.event}` }, "error");
    }
  }

  function onUpgrade(req, socket) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== wsPath || !key) {
      // Not ours — refuse the same way the HTTP stub used to refuse everything, so
      // a path that quietly changed upstream is a failed connection here rather
      // than a socket that hangs.
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const client = {
      id: nextId++,
      socket,
      topics: new Set(),
      joinRefs: new Map(),
      vsn: url.searchParams.get("vsn") ?? "",
    };
    clients.set(client.id, client);

    let buffer = Buffer.alloc(0);
    const partial = { opcode: 0, chunks: [] };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frames;
      try {
        ({ frames, rest: buffer } = readFrames(buffer, partial));
      } catch (e) {
        messages.push({ client: client.id, event: "PARSE_ERROR", error: String(e) });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.opcode === OPCODES.close) {
          socket.end(frame(OPCODES.close, Buffer.alloc(0)));
          return;
        }
        if (f.opcode === OPCODES.ping) {
          socket.write(frame(OPCODES.pong, f.body));
          continue;
        }
        if (f.opcode === OPCODES.pong) continue;
        try {
          handleMessage(client, decodeClientMessage(f.body, f.opcode === OPCODES.binary));
        } catch (e) {
          // A message this stub cannot read is a FINDING, not a crash: it is how a
          // dependency bump that changed the wire format would announce itself.
          messages.push({ client: client.id, event: "DECODE_ERROR", error: String(e) });
        }
      }
    });
    const drop = () => clients.delete(client.id);
    socket.on("close", drop);
    socket.on("error", drop);
  }

  // Replace whatever the HTTP stub installed (it destroys every upgrade). Removing
  // the old listeners rather than adding to them is deliberate: two listeners would
  // race, and the destroy would usually win.
  const previous = server.listeners("upgrade");
  server.removeAllListeners("upgrade");
  server.on("upgrade", onUpgrade);

  return {
    messages,
    sockets: () => clients.size,
    topics: () => [...new Set([...clients.values()].flatMap((c) => [...c.topics]))],
    /** Count of relayed user broadcasts of one event name — the anti-vacuity check
     *  a scenario uses to prove the devices spoke through this server. */
    broadcastsOf(eventName) {
      return messages.filter((m) => m.event === "broadcast" && m.payload?.event === eventName).length;
    },
    close() {
      for (const client of clients.values()) client.socket.destroy();
      clients.clear();
      server.removeListener("upgrade", onUpgrade);
      for (const listener of previous) server.on("upgrade", listener);
    },
  };
}
