# Built inside tap/Dockerfile (Debian 12 bookworm). Pinned tool names, not
# metapackages, so a distro default flip cannot silently change the compiler.
CLANG   ?= clang-14
BPFTOOL ?= bpftool
CC      ?= gcc

# uapi headers under -target bpf need the multiarch asm/ tree for
# __LITTLE_ENDIAN_BITFIELD (struct iphdr/tcphdr bitfields).
MULTIARCH := $(shell $(CC) -print-multiarch)
ARCH      := $(shell uname -m | sed 's/x86_64/x86/;s/aarch64/arm64/;s/armv7l/arm/')

BPF_CFLAGS := -g -O2 -Wall -Werror -target bpf -D__TARGET_ARCH_$(ARCH) \
              -I/usr/include/$(MULTIARCH) -Isrc
CFLAGS     := -g -O2 -Wall -Wextra -Wno-unused-parameter -Isrc -I.
LDLIBS     := -lbpf -lelf -lz -lpcap

all: downlink-tap

src/downlink.bpf.o: src/downlink.bpf.c src/downlink.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

downlink.skel.h: src/downlink.bpf.o
	$(BPFTOOL) gen skeleton $< > $@

downlink-tap: src/main.c downlink.skel.h src/downlink.h
	$(CC) $(CFLAGS) src/main.c -o $@ $(LDLIBS)

clean:
	rm -f downlink-tap downlink.skel.h src/downlink.bpf.o

.PHONY: all clean
