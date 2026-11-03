#!/bin/sh
# Assemble the web worker's static-asset directory (gitignored):
#   public/static/<files>  — served at /static/<files> (and /index.html at /)
set -e
rm -rf public
mkdir -p public/static
cp -r static/. public/static/
cp static/index.html public/index.html 2>/dev/null || true
cp static/llms.txt public/llms.txt 2>/dev/null || true
echo "public/ ready ($(find public -type f | wc -l) files)"
