// SPDX-License-Identifier: GPL-2.0
/*
 * Downlink tap loader.
 *
 * Two modes, one executable, one BPF object:
 *
 *   --iface eth0          attach clsact ingress+egress and stream live
 *   --replay f.pcap       feed a capture through the *same* verified program
 *                         via BPF_PROG_TEST_RUN
 *
 * The replay path is not a re-implementation of the parser. It loads the
 * identical bytecode into the identical maps and drives it packet by packet,
 * so any behaviour difference between replay and live is a bug in one of
 * exactly two places: direction classification, or the timestamp source.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <getopt.h>
#include <linux/bpf.h>
#include <net/if.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
/* libpcap's pcap/bpf.h declares classic-BPF struct bpf_insn, which collides
 * with the one in linux/bpf.h that libbpf pulls in. This is the macro
 * libpcap documents for the case where the BPF structs already exist. */
#define PCAP_DONT_INCLUDE_PCAP_BPF_H 1
#include <pcap/dlt.h>   /* DLT_* live in pcap/bpf.h, excluded above */
#include <pcap/pcap.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <bpf/bpf.h>
#include <bpf/libbpf.h>

#include "downlink.h"
#include "downlink.skel.h"

static volatile sig_atomic_t stop;

/* ---- output sink ----
 *
 * eBPF cannot write to a socket; the loader is the forwarder. This is that
 * boundary, made explicit: every event line goes to stdout, and additionally
 * to a TCP sink when --sink is given. Same bytes, same order, one line per
 * event -- the stream server parses exactly what you see in the terminal.
 */
static const char *sink_spec;
static int sink_fd = -1;
static time_t sink_retry_at;

static void sink_connect(void)
{
	char host[128], *colon;
	struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
	struct addrinfo *res = NULL;
	int one = 1;

	if (sink_fd >= 0 || !sink_spec || time(NULL) < sink_retry_at)
		return;
	sink_retry_at = time(NULL) + 2;		/* bounded reconnect, never a spin */

	snprintf(host, sizeof(host), "%s", sink_spec);
	colon = strrchr(host, ':');
	if (!colon)
		return;
	*colon = '\0';
	if (getaddrinfo(host, colon + 1, &hints, &res) || !res)
		return;
	sink_fd = socket(res->ai_family, res->ai_socktype, 0);
	if (sink_fd >= 0) {
		if (connect(sink_fd, res->ai_addr, res->ai_addrlen)) {
			close(sink_fd);
			sink_fd = -1;
		} else {
			setsockopt(sink_fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
		}
	}
	freeaddrinfo(res);
}

static void emit(const char *fmt, ...)
{
	char buf[1024];
	va_list ap;
	int n;

	va_start(ap, fmt);
	n = vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	if (n <= 0)
		return;
	if (n > (int)sizeof(buf) - 1)
		n = sizeof(buf) - 1;

	fwrite(buf, 1, n, stdout);
	fflush(stdout);

	sink_connect();
	for (int off = 0; sink_fd >= 0 && off < n;) {
		ssize_t sent = send(sink_fd, buf + off, n - off, MSG_NOSIGNAL);

		if (sent > 0) {
			off += sent;
			continue;
		}
		if (sent < 0 && errno == EINTR)
			continue;
		close(sink_fd);		/* stream restarted; reconnect next event */
		sink_fd = -1;
	}
}
static void on_sig(int _) { (void)_; stop = 1; }

static int quiet_libbpf(enum libbpf_print_level lvl, const char *fmt, va_list ap)
{
	if (lvl == LIBBPF_DEBUG)
		return 0;
	return vfprintf(stderr, fmt, ap);
}

/* ---- output ---- */

static int on_event(void *ctx, void *data, size_t len)
{
	const struct dl_event *e = data;
	char ip[INET_ADDRSTRLEN];

	(void)ctx;
	if (len < sizeof(*e))
		return 0;
	inet_ntop(AF_INET, &e->dst_ip, ip, sizeof(ip));
	emit("rtt dst=%s rtt_us=%u\n", ip, e->rtt_us);
	return 0;
}

struct vol { __u32 ip_nbo; __u64 bytes; };

static int vol_cmp(const void *a, const void *b)
{
	__u32 x = ntohl(((const struct vol *)a)->ip_nbo);
	__u32 y = ntohl(((const struct vol *)b)->ip_nbo);

	return x < y ? -1 : x > y;
}

/* Drain bytes_by_dst. Destructive: entries are removed as they are reported,
 * so each byte is emitted exactly once. */
static void drain_bytes(struct downlink_bpf *skel)
{
	int fd = bpf_map__fd(skel->maps.bytes_by_dst);
	struct vol *v = NULL;
	__u32 key, next;
	size_t n = 0, cap = 0;
	char ip[INET_ADDRSTRLEN];
	int have = 0;

	while (bpf_map_get_next_key(fd, have ? &key : NULL, &next) == 0) {
		__u64 b = 0;

		key = next;
		have = 1;
		if (bpf_map_lookup_elem(fd, &key, &b))
			continue;
		if (n == cap) {
			cap = cap ? cap * 2 : 64;
			v = realloc(v, cap * sizeof(*v));
			if (!v)
				return;
		}
		v[n].ip_nbo = key;
		v[n].bytes = b;
		n++;
	}
	for (size_t i = 0; i < n; i++)
		bpf_map_delete_elem(fd, &v[i].ip_nbo);

	qsort(v, n, sizeof(*v), vol_cmp);
	for (size_t i = 0; i < n; i++) {
		inet_ntop(AF_INET, &v[i].ip_nbo, ip, sizeof(ip));
		emit("vol dst=%s bytes=%llu\n", ip, (unsigned long long)v[i].bytes);
	}
	free(v);
}

static void print_stats(struct downlink_bpf *skel)
{
	int fd = bpf_map__fd(skel->maps.stats);
	int ncpu = libbpf_num_possible_cpus();
	__u64 tot[DL_ST__MAX] = {0};
	__u64 *vals;

	if (ncpu < 1)
		return;
	vals = calloc(ncpu, sizeof(__u64));
	if (!vals)
		return;
	for (__u32 k = 0; k < DL_ST__MAX; k++) {
		if (bpf_map_lookup_elem(fd, &k, vals))
			continue;
		for (int i = 0; i < ncpu; i++)
			tot[k] += vals[i];
	}
	free(vals);
	emit("stat pkts=%llu ipv4_tcp=%llu ipv6_skipped=%llu ipv6_bytes=%llu quic_pkts=%llu "
	       "quic_bytes=%llu rtt_emitted=%llu rate_limited=%llu "
	       "rb_dropped=%llu syn_tracked=%llu\n",
	       (unsigned long long)tot[DL_ST_PKTS],
	       (unsigned long long)tot[DL_ST_IPV4_TCP],
	       (unsigned long long)tot[DL_ST_IPV6_SKIPPED],
	       (unsigned long long)tot[DL_ST_IPV6_BYTES],
	       (unsigned long long)tot[DL_ST_QUIC_PKTS],
	       (unsigned long long)tot[DL_ST_QUIC_BYTES],
	       (unsigned long long)tot[DL_ST_RTT_EMITTED],
	       (unsigned long long)tot[DL_ST_RATE_LIMITED],
	       (unsigned long long)tot[DL_ST_RB_DROPPED],
	     (unsigned long long)tot[DL_ST_SYN_TRACKED]);
}

/* ---- replay direction classification ---- */

static __u32 local_net, local_mask;

static int parse_cidr(const char *s)
{
	char buf[64], *slash;
	struct in_addr a;
	int bits = 32;

	snprintf(buf, sizeof(buf), "%s", s);
	slash = strchr(buf, '/');
	if (slash) {
		*slash = '\0';
		bits = atoi(slash + 1);
	}
	if (inet_pton(AF_INET, buf, &a) != 1 || bits < 0 || bits > 32)
		return -1;
	local_mask = bits ? htonl(~0u << (32 - bits)) : 0;
	local_net = a.s_addr & local_mask;
	return 0;
}

/* Egress iff the IPv4 source is on our side of the tap. Everything else --
 * including IPv6 and ARP, which the program discards anyway -- is ingress. */
static int is_egress(const unsigned char *p, unsigned caplen)
{
	__u32 src;

	if (caplen < 14 + 20 || p[12] != 0x08 || p[13] != 0x00)
		return 0;
	memcpy(&src, p + 14 + 12, 4);
	return (src & local_mask) == local_net;
}

static int run_replay(struct downlink_bpf *skel, struct ring_buffer *rb,
		      const char *path)
{
	char errbuf[PCAP_ERRBUF_SIZE];
	static unsigned char out[65536];
	struct pcap_pkthdr *h;
	const unsigned char *pkt;
	pcap_t *pc;
	int fd_in, fd_eg, rc;

	pc = pcap_open_offline(path, errbuf);
	if (!pc) {
		fprintf(stderr, "pcap_open_offline: %s\n", errbuf);
		return 1;
	}
	if (pcap_datalink(pc) != DLT_EN10MB) {
		fprintf(stderr, "replay needs DLT_EN10MB, got %d\n",
			pcap_datalink(pc));
		pcap_close(pc);
		return 1;
	}
	fd_in = bpf_program__fd(skel->progs.tc_ingress);
	fd_eg = bpf_program__fd(skel->progs.tc_egress);

	while ((rc = pcap_next_ex(pc, &h, &pkt)) == 1) {
		struct __sk_buff ctx = {0}, ctx_out = {0};
		__u64 ts;
		int prog;

		if (h->caplen < 14)
			continue;
		ts = (__u64)h->ts.tv_sec * 1000000000ULL +
		     (__u64)h->ts.tv_usec * 1000ULL;
		/* cb[] is the tc scratch area and round-trips through
		 * BPF_PROG_TEST_RUN's ctx_in. skb->tstamp would be the
		 * prettier channel but its ctx support is version-dependent. */
		ctx.cb[0] = (__u32)ts;
		ctx.cb[1] = (__u32)(ts >> 32);

		LIBBPF_OPTS(bpf_test_run_opts, o,
			.data_in = pkt,
			.data_size_in = h->caplen,
			.data_out = out,
			.data_size_out = sizeof(out),
			.ctx_in = &ctx,
			.ctx_size_in = sizeof(ctx),
			.ctx_out = &ctx_out,
			.ctx_size_out = sizeof(ctx_out),
			.repeat = 1);

		prog = is_egress(pkt, h->caplen) ? fd_eg : fd_in;
		if (bpf_prog_test_run_opts(prog, &o)) {
			fprintf(stderr, "BPF_PROG_TEST_RUN: %s\n", strerror(errno));
			pcap_close(pc);
			return 1;
		}
		/* consume, not poll: keeps event order locked to packet order */
		ring_buffer__consume(rb);
	}
	if (rc == -1)
		fprintf(stderr, "pcap_next_ex: %s\n", pcap_geterr(pc));
	pcap_close(pc);
	return rc == -1 ? 1 : 0;
}

static int run_live(struct downlink_bpf *skel, struct ring_buffer *rb,
		    const char *iface)
{
	int ifindex = if_nametoindex(iface);
	time_t last = 0;
	unsigned ticks = 0;
	int created = 0, err = 0;

	if (!ifindex) {
		fprintf(stderr, "no such interface: %s\n", iface);
		return 1;
	}

	LIBBPF_OPTS(bpf_tc_hook, hook, .ifindex = ifindex,
		    .attach_point = BPF_TC_INGRESS | BPF_TC_EGRESS);
	LIBBPF_OPTS(bpf_tc_opts, a_in, .handle = 1, .priority = 1,
		    .prog_fd = bpf_program__fd(skel->progs.tc_ingress));
	LIBBPF_OPTS(bpf_tc_opts, a_eg, .handle = 1, .priority = 1,
		    .prog_fd = bpf_program__fd(skel->progs.tc_egress));

	/* VERIFY: on the WAN interface, tc egress runs after netfilter
	 *         POSTROUTING (post-SNAT) and tc ingress before PREROUTING
	 *         (pre-DNAT), so both hooks observe the same public 4-tuple.
	 *         If this is wrong, syn_tracked climbs and rtt_emitted stays 0.
	 * CHECK:  run live for 60s; rtt_emitted must be non-zero. */
	err = bpf_tc_hook_create(&hook);
	if (err == -EEXIST)
		err = 0;			/* clsact already there, use it */
	else if (!err)
		created = 1;
	if (err) {
		fprintf(stderr, "clsact create on %s: %s\n", iface, strerror(-err));
		return 1;
	}

	hook.attach_point = BPF_TC_INGRESS;
	err = bpf_tc_attach(&hook, &a_in);
	if (err) {
		fprintf(stderr, "attach ingress: %s\n", strerror(-err));
		goto out;
	}
	hook.attach_point = BPF_TC_EGRESS;
	err = bpf_tc_attach(&hook, &a_eg);
	if (err) {
		fprintf(stderr, "attach egress: %s\n", strerror(-err));
		goto out;
	}

	while (!stop) {
		int n = ring_buffer__poll(rb, 200);
		time_t now;

		if (n < 0 && n != -EINTR)
			break;
		now = time(NULL);
		if (now != last) {
			last = now;
			drain_bytes(skel);
			/* Counters every 10 s: the stream server needs a live
			 * unmeasured-traffic fraction, not one at shutdown. */
			if (++ticks % 10 == 0)
				print_stats(skel);
		}
	}

out:
	hook.attach_point = BPF_TC_INGRESS;
	a_in.prog_fd = 0; a_in.prog_id = 0; a_in.flags = 0;
	bpf_tc_detach(&hook, &a_in);
	hook.attach_point = BPF_TC_EGRESS;
	a_eg.prog_fd = 0; a_eg.prog_id = 0; a_eg.flags = 0;
	bpf_tc_detach(&hook, &a_eg);
	if (created) {
		/* only tear down the qdisc if we were the ones who made it --
		 * destroying someone else's clsact drops their filters too */
		hook.attach_point = BPF_TC_INGRESS | BPF_TC_EGRESS;
		bpf_tc_hook_destroy(&hook);
	}
	return err ? 1 : 0;
}

static void usage(const char *p)
{
	fprintf(stderr,
		"usage: %s --iface DEV [opts]\n"
		"       %s --replay FILE.pcap --local CIDR [opts]\n"
		"\n"
		"  --window-ms N   per-destination emit debounce (default 5000)\n"
		"  --sink HOST:PORT also forward every event line over TCP\n", p, p);
}

int main(int argc, char **argv)
{
	static const struct option opts[] = {
		{ "iface",     required_argument, NULL, 'i' },
		{ "replay",    required_argument, NULL, 'r' },
		{ "local",     required_argument, NULL, 'l' },
		{ "window-ms", required_argument, NULL, 'w' },
		{ "sink",      required_argument, NULL, 'k' },
		{ "help",      no_argument,       NULL, 'h' },
		{ 0 }
	};
	const char *iface = NULL, *replay = NULL, *local = NULL;
	unsigned long window_ms = 5000;
	struct downlink_bpf *skel = NULL;
	struct ring_buffer *rb = NULL;
	int rc = 1, c;

	while ((c = getopt_long(argc, argv, "i:r:l:w:k:h", opts, NULL)) != -1) {
		switch (c) {
		case 'i': iface = optarg; break;
		case 'r': replay = optarg; break;
		case 'l': local = optarg; break;
		case 'w': window_ms = strtoul(optarg, NULL, 10); break;
		case 'k': sink_spec = optarg; break;
		default:  usage(argv[0]); return 2;
		}
	}
	if (!!iface == !!replay) {
		usage(argv[0]);
		return 2;
	}
	if (replay) {
		if (!local) {
			fprintf(stderr, "--replay requires --local CIDR to tell "
					"egress from ingress\n");
			return 2;
		}
		if (parse_cidr(local)) {
			fprintf(stderr, "bad --local CIDR: %s\n", local);
			return 2;
		}
	}
	libbpf_set_print(quiet_libbpf);
	signal(SIGINT, on_sig);
	signal(SIGTERM, on_sig);

	skel = downlink_bpf__open();
	if (!skel) {
		fprintf(stderr, "open skeleton: %s\n", strerror(errno));
		return 1;
	}
	skel->rodata->rl_window_ns = (__u64)window_ms * 1000000ULL;
	skel->rodata->replay_mode = replay ? 1 : 0;

	if (downlink_bpf__load(skel)) {
		fprintf(stderr, "load/verify failed: %s\n", strerror(errno));
		goto out;
	}
	rb = ring_buffer__new(bpf_map__fd(skel->maps.events), on_event, NULL, NULL);
	if (!rb) {
		fprintf(stderr, "ring_buffer__new: %s\n", strerror(errno));
		goto out;
	}

	rc = replay ? run_replay(skel, rb, replay) : run_live(skel, rb, iface);

	ring_buffer__consume(rb);
	drain_bytes(skel);
	print_stats(skel);

out:
	ring_buffer__free(rb);
	downlink_bpf__destroy(skel);
	return rc;
}
