#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found in PATH. Install Node.js 20 or newer, then run this script again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found in PATH. Install Node.js 20 or newer, then run this script again." >&2
  exit 1
fi

if [ ! -d "node_modules/electron" ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ ! -f "dist/main/main.js" ]; then
  echo "Building translation-workshop..."
  npm run build
fi

echo "Starting translation-workshop..."
npm start
