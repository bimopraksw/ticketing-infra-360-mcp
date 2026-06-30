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
echo "  Done! You're on the latest version."
echo ""
echo "  No need to do anything else. From now on this"
echo "  updates itself automatically in the background,"
echo "  so you normally won't need to run this again."
echo "================================================"
echo ""
read -p "Press Enter to close this window..."
