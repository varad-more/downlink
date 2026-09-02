/* Shared kernel/userspace contract for the Downlink tap.
 * Kept free of any kernel-internal types so it compiles in both worlds.
 */
#ifndef DOWNLINK_H
#define DOWNLINK_H

/* Ring buffer record. The visualisation only needs a destination and RTT. */
struct dl_event {
	__u32 dst_ip;
	__u32 rtt_us;
};

enum dl_stat {
	DL_ST_PKTS = 0,      /* every packet seen on either hook */
	DL_ST_IPV4_TCP,      /* IPv4 TCP packets reaching the flow logic */
	DL_ST_IPV6_SKIPPED,  /* explicitly rejected, see README limitations */
	DL_ST_IPV6_BYTES,
	DL_ST_QUIC_PKTS,     /* UDP with :443 on either side -- unmeasured traffic */
	DL_ST_QUIC_BYTES,
	DL_ST_RTT_EMITTED,
	DL_ST_RATE_LIMITED,  /* suppressed by the in-kernel per-dst debounce */
	DL_ST_RB_DROPPED,    /* ring buffer full */
	DL_ST_SYN_TRACKED,   /* egress SYNs inserted into the flow map */
	DL_ST__MAX,
};

#endif /* DOWNLINK_H */
