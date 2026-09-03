# Pinned to a multi-arch manifest-list digest, resolved 2026-09-03.
# Refresh with `make pin-base IMAGE=python:3.11-slim-bookworm`.
FROM python@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip list

COPY *.py *.json ./
EXPOSE 8081
CMD ["python", "-u", "server.py"]
