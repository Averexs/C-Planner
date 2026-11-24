import base64
import json
import os
import re
import subprocess
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_VERSION = "0.17.0"
STATIC = Path(__file__).with_name("static")
DATA = Path(os.environ.get("PLANNER_DATA", "data"))
DATA.mkdir(parents=True, exist_ok=True)
PROJECT = re.compile(r"/api/projects/([0-9a-f]{32})")
PDF_LIMIT = 25 * 1024 * 1024
PROJECT_LIMIT = 32 * 1024 * 1024


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def render_pdf(data, page):
    if not data.startswith(b"%PDF-"):
        raise RequestError(400, "Choose a valid PDF file.")
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "plan.pdf"
        target = Path(directory) / "page"
        source.write_bytes(data)
        try:
            result = subprocess.run(
                ["pdfinfo", str(source)], check=True, capture_output=True,
                timeout=10, env={**os.environ, "LC_ALL": "C"},
            )
            pages = int(re.search(rb"^Pages:\s+(\d+)", result.stdout, re.M)[1])
            if not 1 <= page <= pages:
                raise RequestError(400, f"Choose a page from 1 to {pages}.")
            subprocess.run(
                ["pdftoppm", "-f", str(page), "-l", str(page), "-scale-to",
                 "2800", "-singlefile", "-png", str(source), str(target)],
                check=True, capture_output=True, timeout=25,
            )
            image = target.with_suffix(".png").read_bytes()
        except (OSError, TypeError, subprocess.SubprocessError):
            raise RequestError(422, "This PDF could not be rendered. Check that it opens without a password.")
    return {"pages": pages, "image": "data:image/png;base64," + base64.b64encode(image).decode()}


class Handler(BaseHTTPRequestHandler):
    def send_data(self, data, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, value, status=200):
        self.send_data(json.dumps(value).encode(), "application/json", status)

    def body(self, limit, content_type):
        if self.headers.get_content_type() != content_type:
            raise RequestError(415, "Unexpected upload format.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= limit:
            raise RequestError(413, "The request is empty or too large.")
        self.connection.settimeout(30)
        return self.rfile.read(length)

    def dispatch(self):
        match = PROJECT.fullmatch(self.path)
        if self.command == "GET":
            if self.path == "/api/version":
                return self.send_json({"version": APP_VERSION})
            files = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
                     "/style.css": ("style.css", "text/css")}
            if self.path in files:
                filename, mime = files[self.path]
                return self.send_data((STATIC / filename).read_bytes(), mime + "; charset=utf-8")
            if self.path == "/api/projects":
                projects = []
                for path in sorted(DATA.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
                    project = json.loads(path.read_bytes())
                    projects.append({"id": path.stem, "name": project["name"]})
                return self.send_json(projects)
            if match:
                path = DATA / (match[1] + ".json")
                if path.is_file():
                    return self.send_data(path.read_bytes(), "application/json")
        if self.command == "POST" and self.path.startswith("/api/pdf/"):
            try:
                page = int(self.path.removeprefix("/api/pdf/"))
            except ValueError:
                raise RequestError(400, "Enter a valid page number.")
            return self.send_json(render_pdf(self.body(PDF_LIMIT, "application/pdf"), page))
        if (self.command == "POST" and self.path == "/api/projects") or (self.command == "PUT" and match):
            raw = self.body(PROJECT_LIMIT, "application/json")
            try:
                project = json.loads(raw)
            except (ValueError, UnicodeError):
                raise RequestError(400, "Invalid project data.")
            if not isinstance(project, dict) or not isinstance(project.get("name"), str) or not isinstance(project.get("objects"), list):
                raise RequestError(400, "A project needs a name and an object list.")
            project_id = match[1] if match else uuid.uuid4().hex
            path = DATA / (project_id + ".json")
            if match and not path.is_file():
                raise RequestError(404, "Project not found.")
            try:
                with tempfile.NamedTemporaryFile(dir=DATA, delete=False) as target:
                    temporary = Path(target.name)
                    try:
                        target.write(raw)
                        target.close()
                        temporary.replace(path)
                    finally:
                        temporary.unlink(missing_ok=True)
            except OSError as error:
                self.log_error("Cannot save project in %s: %s", DATA, error)
                raise RequestError(500, "The server could not write to its plans storage. Check the Docker logs.") from error
            return self.send_json({"id": project_id}, 200 if match else 201)
        raise RequestError(404, "Not found.")

    def handle_request(self):
        try:
            self.dispatch()
        except RequestError as error:
            self.send_json({"error": str(error)}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = do_POST = do_PUT = handle_request


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
