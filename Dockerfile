FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ backend/

WORKDIR /app/backend
ENV STORAGE_DIR=/data/storage

EXPOSE 8000
# Shell form (not exec form) so ${PORT} expands -- Render's Docker runtime
# injects PORT and expects the app to bind to it; falls back to 8000 for
# local `docker run` / docker-compose, which don't set it.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
