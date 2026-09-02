"""Geolocation, with two backends.

MaxMind GeoLite2 is a manual prerequisite: since December 2019 the direct
downloads are gone and it requires a free account plus a licence key. See
README. If DOWNLINK_GEOIP_DB points at a .mmdb, that is used; otherwise the
resolver falls back to a checked-in fixture table so the Phase 2 gate runs
with no credentials and no network.
"""
import json
import os


class Geo:
    def __init__(self, mmdb_path=None, fixture_path=None):
        self.reader = None
        self.fixture = {}
        if mmdb_path and os.path.exists(mmdb_path):
            import geoip2.database  # lazy: only a real deployment needs it
            self.reader = geoip2.database.Reader(mmdb_path)
        if fixture_path:
            with open(fixture_path) as f:
                for row in json.load(f)["destinations"]:
                    self.fixture[row["ip"]] = row

    @property
    def source(self):
        return "maxmind" if self.reader else "fixture"

    def lookup(self, ip):
        """-> {lat, lon, city, accuracy_km} or None."""
        if self.reader:
            try:
                r = self.reader.city(ip)
            except Exception:
                return None
            if r.location.latitude is None:
                return None
            return {
                "lat": r.location.latitude,
                "lon": r.location.longitude,
                "city": r.city.name or (r.country.name or "?"),
                # MaxMind's own stated radius. Carried into confidence rather
                # than discarded -- a 1000 km radius is not a coordinate.
                "accuracy_km": r.location.accuracy_radius or 100,
            }
        row = self.fixture.get(ip)
        if not row:
            return None
        return {
            "lat": row["lat"], "lon": row["lon"], "city": row["city"],
            "accuracy_km": row.get("accuracy_km", 50),
        }
