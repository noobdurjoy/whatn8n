#!/usr/bin/env python3
"""SSH over WebSocket bridge (standard library only).

Listens on 127.0.0.1 only; nginx forwards wss://support.wamsg.site/_ops/ssh
here. Each WebSocket connection is spliced to the local SSH server, so login
still needs an authorized SSH key: this adds no new way to authenticate, it
only carries SSH over HTTPS for clients that cannot reach port 22.
Enable/disable with deploy/vps/remote-access.sh.
"""
import asyncio
import base64
import hashlib
import os
import struct

LISTEN_PORT = int(os.environ.get("BRIDGE_PORT", "8022"))
TARGET_HOST = os.environ.get("BRIDGE_TARGET_HOST", "127.0.0.1")
TARGET_PORT = int(os.environ.get("BRIDGE_TARGET_PORT", "22"))
PATH = "/_ops/ssh"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_CLIENTS = 4
active = 0


def frame(opcode, payload=b""):
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return head + payload


async def ws_to_tcp(reader, ws_writer, tcp_writer):
    while True:
        b1, b2 = await reader.readexactly(2)
        opcode, masked, n = b1 & 0x0F, b2 & 0x80, b2 & 0x7F
        if n == 126:
            n = struct.unpack("!H", await reader.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", await reader.readexactly(8))[0]
        if not masked or n > 16 * 1024 * 1024:
            return
        mask = await reader.readexactly(4)
        data = bytearray(await reader.readexactly(n))
        for i in range(n):
            data[i] ^= mask[i % 4]
        if opcode in (0x0, 0x1, 0x2):
            tcp_writer.write(bytes(data))
            await tcp_writer.drain()
        elif opcode == 0x8:
            return
        elif opcode == 0x9:
            ws_writer.write(frame(0xA, bytes(data)))
            await ws_writer.drain()


async def tcp_to_ws(tcp_reader, ws_writer):
    while True:
        data = await tcp_reader.read(65536)
        if not data:
            return
        ws_writer.write(frame(0x2, data))
        await ws_writer.drain()


async def handle(reader, writer):
    global active
    tcp_writer = None
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        lines = head.decode("latin-1").split("\r\n")
        method, path = (lines[0].split(" ") + ["", ""])[:2]
        headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
        key = headers.get("sec-websocket-key")
        if method != "GET" or path != PATH or not key or "websocket" not in headers.get("upgrade", "").lower() or active >= MAX_CLIENTS:
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            return
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        tcp_reader, tcp_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").encode())
        await writer.drain()
        active += 1
        try:
            tasks = [asyncio.ensure_future(ws_to_tcp(reader, writer, tcp_writer)), asyncio.ensure_future(tcp_to_ws(tcp_reader, writer))]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            for t in done:
                t.exception()  # a closed connection is normal; nothing to report
            try:
                writer.write(frame(0x8))
            except Exception:
                pass
        finally:
            active -= 1
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, asyncio.LimitOverrunError, ConnectionError, OSError):
        pass
    finally:
        for w in (tcp_writer, writer):
            if w is not None:
                try:
                    w.close()
                except Exception:
                    pass


async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", LISTEN_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
