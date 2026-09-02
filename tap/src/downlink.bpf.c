// SPDX-License-Identifier: GPL-2.0
/*
 * Downlink passive tap.
 *
 * Attached to clsact on the WAN-facing interface, both directions,
 * direct-action. One RTT sample per TCP connection: egress SYN is stamped,
 * the matching ingress SYN-ACK closes it out.
 *
 * No vmlinux.h, no CO-RE relocations: this program only ever touches
 * struct __sk_buff (uapi) and packet bytes via direct packet access. There
 * are no kernel-internal structs to relocate, so CO-RE would buy nothing
 * and only add a BTF dependency at build time.
 *
 * VERIFY: tc-BPF programs see the Ethernet header at skb->data on BOTH
 *         clsact hooks (ingress runs after skb_push(skb, mac_len)).
 *         If this is wrong on ingress, every SYN-ACK is mis-parsed and
 *         rtt_emitted stays 0 while syn_tracked climbs.
 * CHECK:  make verify-phase1 (replay exercises both hooks), then live:
 *         tcpdump -c1 on the WAN iface vs. a non-zero rtt_emitted.
 */
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/in.h>
#include <linux/ip.h>
#include <linux/pkt_cls.h>
#include <linux/tcp.h>
#include <linux/udp.h>

#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>

#include "downlink.h"

char LICENSE[] SEC("license") = "GPL";

/* ---- configuration, set by the loader before load() via .rodata ---- */

/* Per-destination emit debounce. Enforced here, in kernel space, so a
 * chatty host cannot flood the ring buffer. */
const volatile __u64 rl_window_ns = 5000000000ULL;

/* 1 => take the timestamp from skb->cb[] (fed by the pcap replay harness)
 * instead of the clock. Dead-code-eliminated by the verifier in live mode. */
const volatile __u32 replay_mode = 0;

/* Anything above this is a stale LRU entry colliding with a new handshake,
 * not a real RTT. */
#define DL_RTT_MAX_NS 10000000000ULL

/* ---- maps ---- */

struct flow_key {
	__u32 saddr;	/* LAN side (post-SNAT as seen on the WAN iface) */
	__u32 daddr;
	__u16 sport;	/* network byte order, both */
	__u16 dport;
};	/* exactly 12 bytes, no padding -- important for hash key equality */

struct flow_val {
	__u64 ts_ns;
	__u32 seq;	/* host byte order SYN sequence number */
	__u32 _pad;
};

/* 65536 in-flight handshakes. A busy household peaks in the low thousands of
 * concurrent flows; entries live only from SYN to SYN-ACK (single-digit ms
 * typically) so this is ~30x headroom and LRU eviction handles the rest.
 * Cost: 65536 * (12 + 16 + overhead) ~ 6 MB. */
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 65536);
	__type(key, struct flow_key);
	__type(value, struct flow_val);
} flows SEC(".maps");

/* NOT a bloom filter: we need per-key aging and overwrite, which a bloom
 * filter cannot do (no delete, no per-entry timestamp). */
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 8192);
	__type(key, __u32);	/* destination IPv4, network byte order */
	__type(value, __u64);	/* ns of last emitted event */
} ratelimit SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 8192);
	__type(key, __u32);	/* remote IPv4, network byte order */
	__type(value, __u64);	/* bytes seen, both directions */
} bytes_by_dst SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} events SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, DL_ST__MAX);
	__type(key, __u32);
	__type(value, __u64);
} stats SEC(".maps");

/* ---- helpers ---- */

static __always_inline void bump(__u32 k, __u64 v)
{
	__u64 *p = bpf_map_lookup_elem(&stats, &k);

	if (p)
		*p += v;	/* per-cpu, no atomic needed */
}

static __always_inline __u64 now_ns(struct __sk_buff *skb)
{
	/* VERIFY: __sk_buff.cb[] round-trips through BPF_PROG_TEST_RUN's
	 *         ctx_in for BPF_PROG_TYPE_SCHED_CLS.
	 * CHECK:  make verify-phase1 -- without cb[] every replay RTT is zero and
	 *         no event is emitted. */
	if (replay_mode)
		return ((__u64)skb->cb[1] << 32) | (__u64)skb->cb[0];
	/* CLOCK_MONOTONIC. Deliberately not bpf_ktime_get_boot_ns(), which
	 * needs kernel >= 5.7. Downstream only uses the elapsed RTT. */
	return bpf_ktime_get_ns();
}

/* ---- core ---- */

static __always_inline int handle(struct __sk_buff *skb, int egress)
{
	void *data = (void *)(long)skb->data;
	void *end = (void *)(long)skb->data_end;
	struct ethhdr *eth = data;
	struct iphdr *ip;
	struct tcphdr *th;
	struct flow_key k;
	__u32 ihl, remote;
	__u64 len, *bp;
	void *l4;

	bump(DL_ST_PKTS, 1);

	if ((void *)(eth + 1) > end)
		return TC_ACT_OK;

	/* IPv6 is rejected outright, not silently mis-parsed as IPv4.
	 * Counted so the UI can show what fraction of traffic is invisible. */
	if (eth->h_proto == bpf_htons(ETH_P_IPV6)) {
		bump(DL_ST_IPV6_SKIPPED, 1);
		bump(DL_ST_IPV6_BYTES, skb->len);
		return TC_ACT_OK;
	}
	if (eth->h_proto != bpf_htons(ETH_P_IP))
		return TC_ACT_OK;

	ip = (void *)(eth + 1);
	if ((void *)(ip + 1) > end)
		return TC_ACT_OK;

	ihl = (__u32)ip->ihl * 4;
	if (ihl < sizeof(*ip) || ihl > 60)
		return TC_ACT_OK;
	l4 = (void *)ip + ihl;

	/* Volume accounting, keyed on the far end. Aggregated per destination
	 * rather than per flow: that is the granularity the visualisation
	 * collapses to anyway, and it needs no flow-teardown detection. */
	remote = egress ? ip->daddr : ip->saddr;
	/* VERIFY: skb->len at tc ingress includes the 14-byte Ethernet header,
	 *         matching egress and BPF_PROG_TEST_RUN (which sets len =
	 *         data_size_in). A 14 B/packet skew here is cosmetic -- this
	 *         number only drives line thickness -- but it should be known.
	 * CHECK:  ping -c1 -s 100 8.8.8.8 with the tap live; the vol delta for
	 *         8.8.8.8 should be 2 * 142, not 142 + 128. */
	len = skb->len;
	bp = bpf_map_lookup_elem(&bytes_by_dst, &remote);
	if (bp)
		__sync_fetch_and_add(bp, len);
	else
		bpf_map_update_elem(&bytes_by_dst, &remote, &len, BPF_ANY);

	if (ip->protocol == IPPROTO_UDP) {
		struct udphdr *uh = l4;

		if ((void *)(uh + 1) > end)
			return TC_ACT_OK;
		/* QUIC. We cannot measure RTT for it (see README). Count it so
		 * the wall can show an honest "unmeasured" fraction. */
		if (uh->source == bpf_htons(443) || uh->dest == bpf_htons(443)) {
			bump(DL_ST_QUIC_PKTS, 1);
			bump(DL_ST_QUIC_BYTES, len);
		}
		return TC_ACT_OK;
	}

	if (ip->protocol != IPPROTO_TCP)
		return TC_ACT_OK;

	th = l4;
	if ((void *)(th + 1) > end)
		return TC_ACT_OK;

	bump(DL_ST_IPV4_TCP, 1);

	if (egress) {
		struct flow_val v = {};

		if (!th->syn || th->ack)
			return TC_ACT_OK;

		k.saddr = ip->saddr;
		k.daddr = ip->daddr;
		k.sport = th->source;
		k.dport = th->dest;
		v.ts_ns = now_ns(skb);
		v.seq = bpf_ntohl(th->seq);
		bpf_map_update_elem(&flows, &k, &v, BPF_ANY);
		bump(DL_ST_SYN_TRACKED, 1);
		return TC_ACT_OK;
	}

	/* ingress: only a SYN-ACK closes a sample */
	if (!th->syn || !th->ack)
		return TC_ACT_OK;

	k.saddr = ip->daddr;	/* reversed: key is always LAN-side first */
	k.daddr = ip->saddr;
	k.sport = th->dest;
	k.dport = th->source;

	{
		struct flow_val *v = bpf_map_lookup_elem(&flows, &k);
		struct dl_event *e;
		__u64 now, sent_at, dt, *last;

		if (!v)
			return TC_ACT_OK;
		if (bpf_ntohl(th->ack_seq) != v->seq + 1)
			return TC_ACT_OK;

		now = now_ns(skb);
		sent_at = v->ts_ns;
		dt = now - sent_at;
		bpf_map_delete_elem(&flows, &k);
		if (now <= sent_at || dt > DL_RTT_MAX_NS)
			return TC_ACT_OK;

		remote = ip->saddr;
		last = bpf_map_lookup_elem(&ratelimit, &remote);
		if (last && now - *last < rl_window_ns) {
			bump(DL_ST_RATE_LIMITED, 1);
			return TC_ACT_OK;
		}
		bpf_map_update_elem(&ratelimit, &remote, &now, BPF_ANY);

		e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
		if (!e) {
			bump(DL_ST_RB_DROPPED, 1);
			return TC_ACT_OK;
		}
		e->dst_ip = remote;
		e->rtt_us = (__u32)(dt / 1000);
		bpf_ringbuf_submit(e, 0);
		bump(DL_ST_RTT_EMITTED, 1);
	}
	return TC_ACT_OK;
}

SEC("tc")
int tc_egress(struct __sk_buff *skb)
{
	return handle(skb, 1);
}

SEC("tc")
int tc_ingress(struct __sk_buff *skb)
{
	return handle(skb, 0);
}
