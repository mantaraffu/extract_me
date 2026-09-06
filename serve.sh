#!/bin/bash
# Serve this folder on http://localhost:8000 without caching (getUserMedia needs http(s) or localhost).
cd "$(dirname "$0")"
exec python3 serve.py "${1:-8000}"
