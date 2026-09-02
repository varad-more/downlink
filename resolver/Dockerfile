# VERIFY: pin to a digest before deployment -- CHECK: make pin-base
FROM python:3.11-slim-bookworm

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip list

COPY *.py *.json ./
EXPOSE 8081
CMD ["python", "-u", "server.py"]
