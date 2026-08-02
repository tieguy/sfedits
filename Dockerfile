FROM node:20-slim

WORKDIR /opt/sfedits

# System fonts (belt-and-braces for Resvg fallback; renderer bundles its own TTFs)
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