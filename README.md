# Camera Planner

A self-hosted, browser-based editor for planning security camera placement. Docker Compose runs the web server and stores saved plans in a named volume.

## Run with Docker Compose

From this directory, run:

```sh
docker compose up -d --build
```

Open [http://localhost:8080](http://localhost:8080) on the Docker host. Run `docker compose down` to stop it. The `plans` volume retains projects across restarts and rebuilds. Back up that volume to preserve your projects and PDF backgrounds.

For access from another computer, use an SSH tunnel or a reverse proxy with authentication. The default listener binds to loopback. For a trusted private network you can explicitly set `PLANNER_BIND` to the host's private IP in a `.env` file and browse to that IP. Set `PLANNER_PORT` there if port 8080 is in use. The app has no accounts and anyone who can reach it can read and edit its projects. Concurrent saves to the same project use the last completed save.

The **Dark mode** button in the header switches the editor theme. The browser remembers your choice.

## Plan a layout

1. Choose **Import PDF** and enter the page number, or start with **New** and draw a plan. The selected PDF page is rendered into a background image. To work on another floor, create and save a separate project.
2. Drag with **Wall**, **Room**, or **Door** to draw. For a door, start at the hinge and drag toward the closed endpoint. Leave an opening between wall segments for the door. Click with **Label** to place text.
3. Use **Set scale** and drag between two points with a known distance. Enter a value such as `12 ft` or `3.5 m`. By default, one grid square represents 1 ft. For an imported PDF, calibrate against a known distance before relying on the measurements. The selected unit applies to dimensions, object coordinates, and camera range. Turn off snapping for precise placement.
4. Drag **Camera** from the toolbar onto the plan, or select it and click on the plan. Drag the body to move it and the circular handle to aim it. Adjust the horizontal FOV, direction, or range in **Properties**. New cameras start with a 100° horizontal FOV.
5. Use **Save project** to write the project to the server. Use **Open** to work on it again.

Use the mouse wheel to zoom around the pointer, the middle button or **Pan** to move the canvas, and **Fit** to frame the drawing. Ctrl/Cmd+Z undoes an edit, Ctrl/Cmd+Shift+Z redoes it, and Delete removes the selected object.

This editor models two-dimensional horizontal coverage sectors. The sectors extend through walls and depend on the range you enter. Check mounting height, obstructions, usable image detail, and actual sight lines before installing. Imported PDFs are limited to 25 MiB and rendered at up to 2,800 pixels on the longest edge. Drafting tools cover basic floor plans and overlays. They do not import editable PDF geometry or provide CAD constraints.

## Run outside Docker

With Python 3.9 or newer and Poppler's `pdfinfo` and `pdftoppm` on the path, run `python server.py`. It listens on port 8080 on all interfaces and defaults to storing projects in `./data`. Set `PLANNER_DATA` to use a different storage directory.
