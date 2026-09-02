# Pinned to a multi-arch manifest-list digest, resolved 2026-08-27.
# Refresh with `make pin-base` and paste the result here.
FROM debian@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# Versions resolved from bookworm on 2026-08-27, confirmed by the `dpkg -l`
# at the end of this layer (the build log is the version record):
#
#   clang-14      1:14.0.6-12
#   gcc           4:12.2.0-3
#   libbpf-dev    1:1.1.2-0+deb12u1   (needs >= 0.7 for bpf_tc_attach(),
#                                      >= 0.6 for bpf_prog_test_run_opts())
#   libpcap-dev   1.10.3-1
#   bpftool       7.1.0+6.1.180-1
RUN apt-get update && apt-get install -y --no-install-recommends \
        clang-14 \
        llvm-14 \
        libbpf-dev \
        libelf-dev \
        zlib1g-dev \
        libpcap-dev \
        linux-libc-dev \
        libc6-dev \
        bpftool \
        make \
        gcc \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l clang-14 libbpf-dev bpftool libpcap-dev | tail -n +6

WORKDIR /src
COPY Makefile ./
COPY src ./src
RUN make

ENTRYPOINT ["/src/downlink-tap"]
