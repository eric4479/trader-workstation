#!/bin/bash
set -e

echo "🚀 Setting up Python Virtual Environment..."
python3 -m venv venv

echo "📦 Installing requirements..."
./venv/bin/pip install -r requirements.txt

echo "✅ Environment Ready!"
echo "To run the scanner, use: ./venv/bin/python3 scanner.py"
