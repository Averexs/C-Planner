import os
import pwd
import re
import stat
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


def prepare_path(path, account, directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if directory:
        flags |= os.O_DIRECTORY
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise OSError(f"{path} must be a regular project file with no extra links")
        if (info.st_uid, info.st_gid) != (account.pw_uid, account.pw_gid):
            os.fchown(fd, account.pw_uid, account.pw_gid)
        required = 0o700 if directory else 0o600
        mode = stat.S_IMODE(info.st_mode) & 0o777
        if mode | required != stat.S_IMODE(info.st_mode):
            os.fchmod(fd, mode | required)
    finally:
        os.close(fd)


def initialize_mounts(config, data):
    account = pwd.getpwnam("planner")
    prepare_path(config, account, directory=True)
    static = config / "static"
    static.mkdir(exist_ok=True)
    prepare_path(static, account, directory=True)
    prepare_path(data, account, directory=True)
    for entry in data.iterdir():
        if re.fullmatch(r"[0-9a-f]{32}\.json", entry.name):
            prepare_path(entry, account)

    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    if os.getuid() == 0 or os.geteuid() == 0:
        raise OSError("Camera Planner must run without root privileges")


def main():
    try:
        if os.geteuid() == 0:
            initialize_mounts(CONFIG, Path(os.environ.get("PLANNER_DATA", "/data")))
        install_app(SOURCE, CONFIG)
        os.chdir(CONFIG)
    except OSError as error:
        raise SystemExit(
            f"Cannot initialize Camera Planner storage: {error}. "
            f"Make the config mount writable by container UID {os.getuid()}."
        ) from error
    os.execvp("python", ["python", "-I", "server.py"])


if __name__ == "__main__":
    main()
