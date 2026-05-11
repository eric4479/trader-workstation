#!/bin/bash

echo "🚀 Setting up Python Virtual Environment..."
python3 -m venv venv
source venv/bin/activate

echo "📦 Installing requirements..."
pip install -r requirements.txt

echo "✅ Environment Ready!"
echo "To run the scanner, use: source venv/bin/activate && python scanner.py"
