#!/bin/bash

# Go to the project folder (same folder as this script)
cd "$(dirname "$0")"

echo ""
echo "================================================"
echo "  Updating ticketing-infra-360-mcp..."
echo "================================================"
echo ""

# Pull latest code from GitHub
echo "[1/2] Downloading latest update..."
git pull

echo ""
echo "[2/2] Building..."
npm run build

echo ""
echo "================================================"
echo "  Done! Please QUIT and REOPEN Claude Desktop."
echo "================================================"
echo ""
read -p "Press Enter to close this window..."
