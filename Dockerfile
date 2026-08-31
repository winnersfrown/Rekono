# Pinned by digest, not just tag: "node:22-slim" is a moving target that
# repoints on every base-image rebuild, so a floating tag alone means two
# builds of the same commit can pull different underlying images. Dependabot
# (.github/dependabot.yml) keeps this digest current.
FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146

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
