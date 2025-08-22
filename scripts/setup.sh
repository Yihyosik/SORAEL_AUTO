#!/usr/bin/env bash
set -euo pipefail

echo "🌌 Soraiel v1.1.1 Setup Script"
echo "=============================="
echo ""

# Colors
RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[1;33m"; NC="\033[0m"

echo "Checking Node.js version..."
NODE_MAJOR=$(node -v | cut -dv -f2 | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${RED}❌ Node.js 20+ required${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Node.js version OK${NC}\n"

echo "Creating directories..."
mkdir -p data logs runs metrics backups
echo -e "${GREEN}✅ Directories ready${NC}\n"

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${YELLOW}⚠️  .env created - update your API keys${NC}\n"
fi

echo "Installing dependencies..."
npm ci
echo -e "${GREEN}✅ Dependencies installed${NC}\n"

echo "Running smoke test..."
if npm run -s test:smoke; then
  echo -e "${GREEN}✅ Smoke test passed${NC}"
else
  echo -e "${RED}❌ Smoke test failed${NC}"; exit 1
fi

echo -e "\n${GREEN}🎉 Setup completed!${NC}"
