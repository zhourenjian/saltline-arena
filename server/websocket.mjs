// Minimal RFC 6455 WebSocket server side for the duel relay (no dependencies).
// Supports text frames, fragmentation, ping/pong and close; rejects binary data and oversize
// messages. Clients (browsers) always mask; the server never does.
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key) {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

// Completes the HTTP upgrade and returns a small socket wrapper, or null if the request is not a
// valid WebSocket handshake (the socket is answered with 400 and closed).
export function acceptWebSocket(req, socket, { maxPayload = 16384 } = {}) {
  const key = req.headers["sec-websocket-key"];
  if (
    !key ||
    String(req.headers.upgrade || "").toLowerCase() !== "websocket" ||
    req.headers["sec-websocket-version"] !== "13"
  ) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0),
    fragments = [],
    fragmentBytes = 0,
    closed = false,
    lastSeen = Date.now();
  const ws = {
    onmessage: null,
    onclose: null,
    get lastSeen() {
      return lastSeen;
    },
    get closed() {
      return closed;
    },
    send(text) {
      if (closed) return;
      socket.write(frame(0x1, Buffer.from(String(text), "utf8")));
    },
    ping() {
      closed || socket.write(frame(0x9, Buffer.alloc(0)));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      const r = Buffer.from(String(reason).slice(0, 100), "utf8"),
        body = Buffer.alloc(2 + r.length);
      (body.writeUInt16BE(code, 0), r.copy(body, 2));
      socket.write(frame(0x8, body));
      finish(code);
      socket.end();
    },
  };

  function finish(code) {
    if (closed) return;
    closed = true;
    try {
      ws.onclose && ws.onclose(code);
    } catch (e) {
      console.error("[ws] onclose threw", e);
    }
  }

  function frame(opcode, payload) {
    const n = payload.length;
    let head;
    if (n < 126) ((head = Buffer.alloc(2)), (head[1] = n));
    else if (n < 65536)
      ((head = Buffer.alloc(4)), (head[1] = 126), head.writeUInt16BE(n, 2));
    else
      ((head = Buffer.alloc(10)),
        (head[1] = 127),
        head.writeBigUInt64BE(BigInt(n), 2));
    head[0] = 0x80 | opcode;
    return Buffer.concat([head, payload]);
  }

  function parse() {
    while (buffer.length >= 2) {
      const b0 = buffer[0],
        b1 = buffer[1],
        fin = (b0 & 0x80) !== 0,
        opcode = b0 & 0x0f,
        masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f,
        off = 2;
      if (b0 & 0x70) return ws.close(1002, "reserved bits");
      if (!masked) return ws.close(1002, "client frames must be masked");
      if (len === 126) {
        if (buffer.length < 4) return;
        ((len = buffer.readUInt16BE(2)), (off = 4));
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) return ws.close(1009, "too big");
        ((len = Number(big)), (off = 10));
      }
      if (len > maxPayload) return ws.close(1009, "too big");
      if (buffer.length < off + 4 + len) return;
      const mask = buffer.subarray(off, off + 4),
        payload = Buffer.from(buffer.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(off + 4 + len);
      lastSeen = Date.now();

      if (opcode === 0x8) {
        // echo the close and finish
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        closed || socket.write(frame(0x8, payload.subarray(0, 2)));
        finish(code);
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        closed || socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x2) return ws.close(1003, "text only");
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1 && fragments.length)
          return ws.close(1002, "unexpected new message");
        if (opcode === 0x0 && !fragments.length)
          return ws.close(1002, "unexpected continuation");
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (fragmentBytes > maxPayload) return ws.close(1009, "too big");
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString("utf8");
        ((fragments = []), (fragmentBytes = 0));
        try {
          ws.onmessage && ws.onmessage(text);
        } catch (e) {
          console.error("[ws] onmessage threw", e);
        }
        continue;
      }
      return ws.close(1002, "unknown opcode");
    }
  }

  socket.on("data", (chunk) => {
    if (closed) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    parse();
  });
  socket.on("close", () => finish(1006));
  socket.on("error", () => finish(1006));
  return ws;
}
