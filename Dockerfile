FROM node:20-bookworm-slim

# ClamAV is the actual malware engine; uploads are rejected when it is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends clamav clamav-freshclam python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    CLAMSCAN_BIN=clamscan \
    AV_SCAN_REQUIRED=true
EXPOSE 3000
CMD ["sh", "-c", "freshclam || true; (while true; do sleep 21600; freshclam || true; done) & npm start"]
