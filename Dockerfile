FROM debian:bookworm-slim

# Install Node.js
RUN apt-get update && \
    apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Xvfb, VNC, window manager and dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    xvfb \
    x11-utils \
    x11-common \
    openbox \
    tightvncserver \
    novnc \
    websockify \
    fonts-dejavu \
    ca-certificates \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy project files
COPY package*.json ./
RUN npm install

# Install Chrome for Puppeteer
RUN npx puppeteer browsers install chrome

# Copy rest of the project
COPY . .

# Make start script executable
RUN chmod +x start.sh

# Set environment variables
ENV DISPLAY=:99
ENV NODE_ENV=production

# Expose ports: 3070 (HSN runner), 5900 (VNC), 6080 (noVNC web)
EXPOSE 3070 5900 6080

# Start the application
CMD ["bash", "start.sh"]
