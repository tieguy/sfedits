#!/bin/bash
# Deploy script - pulls latest code on droplet and rebuilds containers
# with aggressive memory management to prevent OOM

set -e

# Load .env file
if [ ! -f .env ]; then
  echo "Error: .env file not found"
  echo "Please create .env with DROPLET_IP set"
  exit 1
fi

source .env

if [ -z "$DROPLET_IP" ]; then
  echo "Error: DROPLET_IP not set in .env"
  exit 1
fi

echo "Deploying to $DROPLET_IP..."

ssh root@$DROPLET_IP << 'EOF'
  set -e
  cd /root/sfedits

  echo "=== Comprehensive cleanup ==="

  # Stop ALL containers first (compose + any strays)
  echo "Stopping all containers..."
  docker-compose down || true
  docker stop $(docker ps -a -q) 2>/dev/null || true
  docker rm -f $(docker ps -a -q) 2>/dev/null || true

  # Remove ALL Docker resources
  echo "Cleaning Docker..."
  docker system prune -af --volumes
  docker image prune -af
  docker builder prune -af

  # Clean apt cache and archives (~400MB)
  echo "Cleaning apt..."
  apt-get clean
  rm -rf /var/cache/apt/archives/*.deb
  rm -rf /var/cache/apt/archives/partial/*.deb
  apt-get autoclean
  apt-get autoremove -y

  # Clean logs aggressively
  echo "Cleaning logs..."
  journalctl --vacuum-time=2d
  find /var/log -type f -name "*.log" -mtime +7 -delete
  find /var/log -type f -name "*.gz" -delete
  find /var/log -type f -name "*.old" -delete

  # Clean tmp
  rm -rf /tmp/*

  # Show space after cleanup
  echo ""
  df -h / | grep -v Filesystem

  echo ""
  echo "=== Pre-deployment checks ==="

  # Check disk space after cleanup
  DISK_USAGE=$(df / | tail -1 | awk '{print $5}' | sed 's/%//')
  echo "Disk usage after cleanup: ${DISK_USAGE}%"

  if [ "$DISK_USAGE" -gt 85 ]; then
    echo "ERROR: Disk usage still at ${DISK_USAGE}% after cleanup"
    echo "Manual cleanup required - cannot proceed with build"
    exit 1
  fi

  # Check memory
  FREE_MEM=$(free -m | awk 'NR==2{print $7}')
  echo "Available memory: ${FREE_MEM}MB"
  if [ "$FREE_MEM" -lt 100 ]; then
    echo "WARNING: Low memory (${FREE_MEM}MB) - restarting services to free memory"
    docker-compose restart
    sleep 5
  fi

  echo ""
  echo "=== Pulling latest code ==="
  git fetch origin
  git reset --hard origin/main

  # Show reclaimed space
  echo ""
  docker system df

  echo ""
  echo "=== Building services sequentially to avoid OOM ==="

  # Build and remove old images one at a time to minimize peak disk usage
  # This prevents having both old and new images for all services simultaneously

  echo "Building bot..."
  docker-compose build bot
  # Remove old bot image if it exists
  docker images | grep sfedits_bot | grep -v latest | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true

  echo "Building admin..."
  docker-compose build admin
  # Remove old admin image if it exists
  docker images | grep sfedits_admin | grep -v latest | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true

  echo ""
  echo "=== Stopping existing containers ==="
  # Remove running/stopped containers to release port allocations
  # docker system prune doesn't remove compose project containers
  docker-compose down || true

  echo ""
  echo "=== Starting services ==="
  # Start services (already built, so no memory spike)
  docker-compose up -d

  # Wait for health checks
  echo "Waiting for services to be healthy..."
  sleep 10

  echo ""
  echo "=== Deployment complete! ==="
  docker-compose ps

  echo ""
  echo "=== System resources after deployment ==="
  free -h
  df -h / | grep -v Filesystem
  docker system df
EOF
