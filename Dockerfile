FROM node:20-slim

WORKDIR /opt/sfedits

# Install system dependencies for native rendering (satori + resvg)
RUN apt-get update && apt-get install -y \
    fonts-noto-core \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

CMD ["node", "page-watch.js"]