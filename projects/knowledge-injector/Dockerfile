FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY config.py .
COPY api/ ./api/
COPY injector/ ./injector/
COPY providers/ ./providers/
COPY storage/ ./storage/

RUN mkdir -p /app/data

# 默认以 REST API 模式启动（固定 3610，避免与 data-service 8765 冲突）
# 如需纯定时注入器，改用: ["python", "main.py"]
CMD ["python", "main.py", "--api", "--port", "3610"]
