# Dockerfile
FROM node:20-bookworm

# Chrome/Chromium runtime libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcrypt1 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libuuid1 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
    libxrender1 libxshmfence1 libxtst6 wget xdg-utils \
 && rm -rf /var/lib/apt/lists/*

# Optional: common fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-dejavu fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Download Chrome into the image at build time (no runtime download needed)
ENV PUPPETEER_CACHE_DIR=/home/pptr-cache
RUN mkdir -p ${PUPPETEER_CACHE_DIR} && npx puppeteer browsers install chrome

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]