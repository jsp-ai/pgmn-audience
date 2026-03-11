"""Simple ASGI server using only stdlib + the app."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend'))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from http.server import HTTPServer, SimpleHTTPRequestHandler
import json, threading, urllib.request, urllib.parse
from backend.server import app

# Use a simple stdlib server that proxies to FastAPI for the preview tool
from http.server import BaseHTTPRequestHandler
import asyncio

# Simple synchronous wrapper
from fastapi.testclient import TestClient
client = TestClient(app)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/' or self.path == '/app':
            with open('frontend/index.html', 'rb') as f:
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.end_headers()
                self.write(f.read())
            return
        resp = client.get(self.path)
        self.send_response(resp.status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp.content)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''
        resp = client.post(self.path, content=body, headers={'Content-Type': 'application/json'})
        self.send_response(resp.status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp.content)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        print(f"{args[0]}")

server = HTTPServer(('0.0.0.0', 8000), Handler)
print("PGMN Ad Launcher running at http://localhost:8000")
server.serve_forever()
