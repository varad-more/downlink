# PostGIS 3.4 on PostgreSQL 16, plus pgRouting from PGDG (already configured
# in the postgis image, so this is one apt line rather than a build).
# VERIFY: the package name is postgresql-16-pgrouting on PGDG bookworm.
# CHECK:  docker compose build db  -- apt fails loudly if it is wrong.
FROM postgis/postgis:16-3.4

RUN apt-get update && apt-get install -y --no-install-recommends \
        postgresql-16-pgrouting \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l postgresql-16-pgrouting | tail -n +6
