FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ .

ENV STORAGE_DIR=/data/storage

EXPOSE 8000
# ${PORT} -- Render's Docker runtime injects PORT and expects the app to
# bind to it; falls back to 8000 for local `docker run` / docker-compose,
# which don't set it. server.js already reads process.env.PORT itself, so
# this just needs to be present in the container's environment.
CMD ["node", "src/server.js"]
