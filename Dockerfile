# Step 1: Use Node.js as the base image
FROM node:18-slim

# Step 2: Install Chrome dependencies and FFmpeg
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Step 3: Install Google Chrome Stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Step 4: Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Step 5: Set the working directory inside the container
WORKDIR /app

# Step 6: Copy your project files into the container
COPY . /app

# Step 7: Install dependencies for the backend
WORKDIR /app/Backend
RUN npm install

# Step 8: Create temp directory for video processing
RUN mkdir -p /app/Backend/temp && chmod 777 /app/Backend/temp

# Step 9: Expose the port that the backend is listening on
EXPOSE 3000

# Step 10: Start the backend app when the container is run
CMD ["npm", "run", "start"]