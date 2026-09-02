#!/usr/bin/env python3
"""Generate tests/sample.pcap: the deterministic fixture for the Phase 1 gate.

Stdlib only. Every packet, timestamp and sequence number is fixed, so the
expected output of `downlink-tap --replay` is known in advance and can be
asserted byte-for-byte.

Contents (24 packets, epoch base 1700000000.000000):
  8 completed handshakes, 1 SYN with no reply, 1 SYN-ACK with a wrong
  ack_seq, 2 IPv6 SYNs, 3 QUIC-shaped UDP/443 datagrams.
Expected: 7 rtt events (one handshake is debounced, one has a bad ack_seq).
"""
import struct
import sys

T0 = 1700000000
LOCAL = "192.168.1.50"
LOCAL_MAC = bytes.fromhex("020000000001")
PEER_MAC = bytes.fromhex("020000000002")


def ip2b(s):
    return bytes(int(x) for x in s.split("."))


def csum(b):
    if len(b) & 1:
        b += b"\x00"
    s = 0
    for i in range(0, len(b), 2):
        s += (b[i] << 8) | b[i + 1]
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return (~s) & 0xFFFF


def frame(payload, ethertype=0x0800, egress=True):
    dst, src = (PEER_MAC, LOCAL_MAC) if egress else (LOCAL_MAC, PEER_MAC)
    return dst + src + struct.pack("!H", ethertype) + payload


def ipv4(src, dst, proto, payload, ident):
    h = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(payload), ident, 0,
                    64, proto, 0, ip2b(src), ip2b(dst))
    return h[:10] + struct.pack("!H", csum(h)) + h[12:] + payload


def tcp(src, dst, sport, dport, seq, ack, flags):
    h = struct.pack("!HHIIBBHHH", sport, dport, seq, ack, 5 << 4, flags,
                    64240, 0, 0)
    pseudo = ip2b(src) + ip2b(dst) + struct.pack("!BBH", 0, 6, len(h))
    return h[:16] + struct.pack("!H", csum(pseudo + h)) + h[18:]


def udp(src, dst, sport, dport, payload):
    ln = 8 + len(payload)
    h = struct.pack("!HHHH", sport, dport, ln, 0)
    pseudo = ip2b(src) + ip2b(dst) + struct.pack("!BBH", 0, 17, ln)
    c = csum(pseudo + h + payload) or 0xFFFF
    return struct.pack("!HHHH", sport, dport, ln, c) + payload


IDENT = [0x1000]


def ident():
    IDENT[0] += 1
    return IDENT[0]


PKTS = []  # (sec, usec, bytes)


def add(ms, raw):
    PKTS.append((T0 + ms // 1000, (ms % 1000) * 1000, raw))


def syn(ms, dst, sport, dport, seq):
    add(ms, frame(ipv4(LOCAL, dst, 6,
                       tcp(LOCAL, dst, sport, dport, seq, 0, 0x02), ident())))


def synack(ms, dst, sport, dport, ack, seq=0x20000000):
    add(ms, frame(ipv4(dst, LOCAL, 6,
                       tcp(dst, LOCAL, dport, sport, seq, ack, 0x12), ident()),
                  egress=False))


# --- 8 handshakes we expect to resolve (one of which is debounced) ---
# (syn_ms, rtt_ms, dst, sport, dport, seq)
FLOWS = [
    (0,    12,  "1.1.1.1",         40001, 443, 0x10001000),
    (100,  24,  "8.8.8.8",         40002, 853, 0x10002000),
    (200,  38,  "151.101.1.140",   40003, 443, 0x10003000),
    (300,  89,  "13.107.42.14",    40004, 443, 0x10004000),
    (400,  147, "104.244.42.1",    40005, 443, 0x10005000),
    (500,  210, "203.0.113.7",     40006,  22, 0x10006000),
    (2000, 13,  "1.1.1.1",         40007, 443, 0x10007000),  # debounced
    (9000, 31,  "8.8.8.8",         40008, 443, 0x10008000),  # window expired
]
for syn_ms, rtt_ms, dst, sp, dp, seq in FLOWS:
    syn(syn_ms, dst, sp, dp, seq)
    synack(syn_ms + rtt_ms, dst, sp, dp, seq + 1)

# --- SYN with no reply: must never emit ---
syn(1000, "198.51.100.9", 40009, 443, 0x10009000)

# --- SYN-ACK with a wrong ack_seq: must be rejected, not measured ---
syn(3000, "192.0.2.55", 40010, 443, 0x1000A000)
synack(3050, "192.0.2.55", 40010, 443, 0x1000A000 + 999)

# --- IPv6: explicitly skipped, counted ---
V6_SRC = bytes.fromhex("fd000000000000000000000000000050")
V6_DST = bytes.fromhex("26000000000000000000000000000001")
for i, ms in enumerate((1500, 1600)):
    l4 = struct.pack("!HHIIBBHHH", 40100 + i, 443, 0x30000000, 0,
                     5 << 4, 0x02, 64240, 0, 0)
    v6 = struct.pack("!IHBB", 6 << 28, len(l4), 6, 64) + V6_SRC + V6_DST
    add(ms, frame(v6 + l4, 0x86DD))

# --- QUIC-shaped UDP/443: counted as unmeasured traffic ---
for ms in (1700, 1800, 1900):
    add(ms, frame(ipv4(LOCAL, "8.8.8.8", 17,
                       udp(LOCAL, "8.8.8.8", 50000, 443, b"\xab" * 1200),
                       ident())))

PKTS.sort(key=lambda p: (p[0], p[1]))

out = sys.argv[1] if len(sys.argv) > 1 else "tests/sample.pcap"
with open(out, "wb") as f:
    # classic pcap, microsecond, DLT_EN10MB
    f.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, 1))
    for sec, usec, b in PKTS:
        f.write(struct.pack("<IIII", sec, usec, len(b), len(b)))
        f.write(b)

sizes = {}
for _, _, b in PKTS:
    sizes[len(b)] = sizes.get(len(b), 0) + 1
print("wrote %s: %d packets, sizes %s" % (out, len(PKTS), sizes))
