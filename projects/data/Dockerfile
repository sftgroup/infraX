FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    DATA_SERVICE_PORT=8001

WORKDIR /app

# ── Dependencies ───────────────────────────────────────────────

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Application ────────────────────────────────────────────────

COPY main.py .
COPY app/ ./app/

# ── Runtime ────────────────────────────────────────────────────

RUN mkdir -p /app/data && \
    addgroup --gid 1001 --system appgroup && \
    adduser --uid 1001 --system appuser --ingroup appgroup && \
    chown -R appuser:appgroup /app

USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -sf http://127.0.0.1:${DATA_SERVICE_PORT}/health || exit 1

EXPOSE ${DATA_SERVICE_PORT}

CMD ["python", "main.py"]
