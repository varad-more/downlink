"""Self-check for the resolver's connection pool (resolver/server.py).

Runs with no Postgres and no psycopg installed: both are stubbed, because what
is being tested is the borrow/evict/retry logic, not the driver.

    python3 tests/resolver_pool.py
"""
import os
import sys
import threading
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "resolver"))


class OperationalError(Exception):
    """Stands in for psycopg.OperationalError."""


psycopg = types.ModuleType("psycopg")
psycopg.OperationalError = OperationalError
sys.modules["psycopg"] = psycopg


class FakeConn:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeResolver:
    def __init__(self):
        self.conn = FakeConn()


builds = []


def build():
    r = FakeResolver()
    builds.append(r)
    return r


resolve_mod = types.ModuleType("resolve")
resolve_mod.build = build
sys.modules["resolve"] = resolve_mod

os.environ["DOWNLINK_POOL_SIZE"] = "4"
import server  # noqa: E402

SIZE = server.POOL_SIZE
assert SIZE == 4, SIZE


def slots():
    return server._pool.qsize()


def live():
    """Slots currently holding a built Resolver, top of the stack first.

    Puts them back in reverse so the LIFO order is exactly as it was --
    otherwise inspecting the pool would change which connection the next
    borrow gets, and the eviction check below would kill the wrong one.
    """
    held = [server._pool.get() for _ in range(SIZE)]
    for h in reversed(held):
        server._pool.put(h)
    return [h for h in held if h is not None]


# 1. Cold pool: every slot present, none built. An idle deployment must not
#    open POOL_SIZE connections just by starting up.
assert slots() == SIZE, slots()
assert builds == [], "pool built connections before the first request"

# 2. A healthy call builds exactly one connection and returns the slot.
assert server.call(lambda r: "ok") == "ok"
assert len(builds) == 1, builds
assert slots() == SIZE, "slot leaked on the happy path"

# 3. Reuse: a second call does not build again.
server.call(lambda r: None)
assert len(builds) == 1, "pool rebuilt an already-good connection"

# 4. Concurrency -- the whole point of replacing the global lock. Four callers
#    each holding a connection for 150ms must overlap, not queue.
started = threading.Barrier(SIZE)


def slow(_):
    started.wait(timeout=5)
    time.sleep(0.15)


threads = [threading.Thread(target=lambda: server.call(slow)) for _ in range(SIZE)]
t0 = time.monotonic()
for t in threads:
    t.start()
for t in threads:
    t.join(timeout=5)
elapsed = time.monotonic() - t0
assert elapsed < 0.45, "pool serialised %d callers: %.2fs" % (SIZE, elapsed)
assert slots() == SIZE, "slots leaked under concurrency"

# 5. A dead connection is closed and evicted, not handed back. This is the
#    Postgres-restart case: without eviction the process keeps a dead socket
#    forever and every later request fails.
before = live()
assert before, "expected at least one live connection to kill"
victim = before[0]


def boom(r):
    raise OperationalError("server closed the connection unexpectedly")


try:
    server.call(boom)
except OperationalError:
    pass
else:
    raise AssertionError("a permanently-dead connection must surface an error")
assert victim.conn.closed, "dead connection was not closed"
assert victim not in live(), "dead connection was returned to the pool"
assert slots() == SIZE, "slot lost when a connection died"

# 6. Retry-once: a restart costs one request, not every request. The first
#    attempt evicts, the second succeeds on a fresh connection.
calls = []


def flaky(r):
    calls.append(r)
    if len(calls) == 1:
        raise OperationalError("terminating connection due to administrator command")
    return "recovered"


assert server.call(flaky) == "recovered", "call() did not retry a dropped connection"
assert len(calls) == 2, calls
assert calls[0] is not calls[1], "retry reused the connection it just evicted"
assert slots() == SIZE

# 7. A non-OperationalError is NOT a connection problem: surface it, keep the
#    connection, and do not retry (it would just fail identically).
kept = live()
tries = []


def bug(r):
    tries.append(r)
    raise ValueError("bad query")


try:
    server.call(bug)
except ValueError:
    pass
else:
    raise AssertionError("application errors must propagate")
assert len(tries) == 1, "application error was retried"
assert not tries[0].conn.closed, "application error closed a healthy connection"
assert live() == kept, "application error disturbed the pool"
assert slots() == SIZE

# 8. Nothing is dropped on the floor. Every connection ever built is either
#    still in the pool or was closed on the way out -- an evicted-but-open
#    connection is a leaked Postgres backend, which is the failure a pool
#    exists to prevent. (`builds` is cumulative history, not a live count:
#    the eviction checks above deliberately destroyed some of these.)
resident = live()
leaked = [r for r in builds if r not in resident and not r.conn.closed]
assert not leaked, "%d connection(s) evicted without being closed" % len(leaked)
assert len(resident) <= SIZE, "pool holds %d connections for %d slots" % (
    len(resident), SIZE)

print("RESOLVER POOL PASS: %d slots, lazy build, concurrent, evicts dead "
      "connections, retries once, %d resident and 0 leaked after %d builds."
      % (SIZE, len(resident), len(builds)))
