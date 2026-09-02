# Known unknowns

These checks require the deployment hardware or human judgment. Automated
gates cover everything else.

## Gateway

- `make probe` must confirm BTF and `clsact` on the target kernel.
- After one minute live, `syn_tracked` and `rtt_emitted` must both increase.
  If only SYNs increase, the chosen interface or NAT ordering is wrong.
- After one hour, `rb_dropped` should remain zero.
- Compare ingress/egress byte totals with a known packet size to confirm the
  target kernel includes the Ethernet header consistently in `skb->len`.

## Route model

- Compare named candidates with traceroutes from the installation site.
- Treat IXP nodes as metro anchors unless a traceroute independently supports
  the exchange crossing.
- Treat every terrestrial edge as modeled, not known carrier fibre.
- The loader skips records marked `is_tbd`, but the public geometry is not a
  live status feed. Do not call a candidate available without operator data.

## Kiosk

- Run `/?soak=1&speed=10` for an hour with the browser offline.
- Confirm trails render, frame rate stays stable, and browser/WebGL memory does
  not trend upward.
- Confirm no dormant dependency URL is fetched while offline.

## Geolocation

- A real MaxMind database still needs validation against the fixture path.
- Anycast and router geolocation remain inference; the speed-of-light test can
  reject impossible coordinates but cannot make an uncertain coordinate true.
