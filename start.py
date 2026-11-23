import os
import shutil
import tempfile
from pathlib import Path

SOURCE = Path("/opt/camera-planner")
CONFIG = Path("/config")


def install_app(source, destination):
    static = destination / "static"
    if static.is_symlink():
        raise OSError(f"{static} must be a directory inside the config mount")
    static.mkdir(exist_ok=True)

    for packaged in [source / "server.py", *sorted((source / "static").iterdir())]:
        target = destination / packaged.relative_to(source)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
            staged = Path(temporary.name)
        try:
            shutil.copyfile(packaged, staged)
            staged.chmod(0o644)
            staged.replace(target)
        finally:
            staged.unlink(missing_ok=True)


def main():
    try:
        install_app(SOURCE, CONFIG)
        os.chdir(CONFIG)
    except OSError as error:
        raise SystemExit(
            f"Cannot prepare Camera Planner in {CONFIG}: {error}. "
            f"Make the config mount writable by container UID {os.getuid()}."
        ) from error
    os.execvp("python", ["python", "server.py"])


if __name__ == "__main__":
    main()
