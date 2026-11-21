const $ = id => document.getElementById(id);
const canvas = $('canvas');
const drawing = $('drawing');
const defaultScale = { pixelsPerUnit: 20, unit: 'ft' };
const fresh = () => ({ name: 'Untitled plan', objects: [], background: null, scale: null });
let plan = fresh();
let id, selected, gesture;
let tool = 'select';
let view = { x: 28, y: 28, zoom: 1 };
let past = [], future = [];
let dirty = false, revision = 0;
const tips = {
  select: 'Drag objects to move them. Drag the camera handle to aim.',
  pan: 'Drag to pan the drawing.',
  wall: 'Drag from one end of the wall to the other.',
  room: 'Drag between opposite corners of the room.',
  door: 'Drag from the hinge toward the closed end. Leave an opening in the wall.',
  label: 'Click to place a label.',
  measure: 'Drag between two points to add a dimension.',
  scale: 'Turn off snapping, then drag along a known distance.',
  camera: 'Click to place a camera or drag one from the toolbar.',
};
const names = { wall: 'Wall', room: 'Room', door: 'Door', measure: 'Dimension', camera: 'Camera', label: 'Label' };
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const radians = degrees => degrees * Math.PI / 180;
const direction = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 360) % 360;
const polar = (x, y, range, angle) => [x + range * Math.cos(radians(angle)), y + range * Math.sin(radians(angle))];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const current = () => plan.objects.find(object => object.id === selected);
const status = message => { $('status').textContent = message; };
const clone = () => structuredClone(plan);

function svg(tag, attributes, parent = drawing, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (content !== undefined) node.textContent = content;
  parent.append(node);
  return node;
}

function updateView() {
  $('world').setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.zoom})`);
  const grid = $('grid-area');
  grid.setAttribute('x', -view.x / view.zoom);
  grid.setAttribute('y', -view.y / view.zoom);
  grid.setAttribute('width', canvas.clientWidth / view.zoom);
  grid.setAttribute('height', canvas.clientHeight / view.zoom);
  $('zoom').textContent = Math.round(view.zoom * 100) + '%';
}

function lengthText(pixels) {
  const { pixelsPerUnit, unit } = plan.scale ?? defaultScale;
  return Number((pixels / pixelsPerUnit).toPrecision(5)) + ' ' + unit;
}

function cone(object, parent, active) {
  const { x, y, range, angle, fov } = object;
  const a = polar(x, y, range, angle - fov / 2);
  const b = polar(x, y, range, angle + fov / 2);
  svg('path', {
    d: `M ${x} ${y} L ${a.join(' ')} A ${range} ${range} 0 ${fov > 180 ? 1 : 0} 1 ${b.join(' ')} Z`,
    fill: '#12a899', 'fill-opacity': active ? .25 : .15, stroke: '#087c76',
    'stroke-opacity': active ? .85 : .55, 'pointer-events': 'none',
  }, parent);
}

function drawObject(object, active, preview = false) {
  const { type, x, y, x2, y2 } = object;
  const color = active ? '#087c76' : '#263f5b';
  const group = svg('g', preview ? {} : { 'data-object': object.id });
  if (type === 'camera') {
    const body = svg('g', { transform: `translate(${x} ${y}) rotate(${object.angle})` }, group);
    svg('rect', { x: -10, y: -7, width: 17, height: 14, rx: 3, fill: color, stroke: '#fff' }, body);
    svg('path', { d: 'M6 -4 L13 -7 V7 L6 4 Z', fill: color, stroke: '#fff' }, body);
    if (active) {
      const [cx, cy] = polar(x, y, Math.max(24, object.range), object.angle);
      svg('line', { x1: x, y1: y, x2: cx, y2: cy, stroke: color, 'stroke-dasharray': '5 4', 'pointer-events': 'none' }, group);
      svg('circle', { cx, cy, r: 7, fill: '#fff', stroke: color, 'stroke-width': 2, 'data-aim': '' }, group);
    }
    svg('text', { x: x + 13, y: y - 12, fill: color, 'font-size': 13 }, group, object.name);
  } else if (type === 'label') {
    svg('text', { x, y, fill: color, 'font-size': 16, 'font-weight': 600 }, group, object.name);
  } else if (type === 'room') {
    const rectangle = { x: Math.min(x, x2), y: Math.min(y, y2), width: Math.abs(x2 - x), height: Math.abs(y2 - y) };
    svg('rect', { ...rectangle, fill: 'none', stroke: 'transparent', 'stroke-width': 14 }, group);
    svg('rect', { ...rectangle, fill: 'none', stroke: color, 'stroke-width': 4 }, group);
  } else if (type === 'door') {
    const radius = Math.hypot(x2 - x, y2 - y);
    const openX = x - (y2 - y);
    const openY = y + (x2 - x);
    const path = `M ${x} ${y} L ${openX} ${openY} A ${radius} ${radius} 0 0 0 ${x2} ${y2}`;
    svg('path', { d: path, fill: 'none', stroke: 'transparent', 'stroke-width': 14 }, group);
    svg('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2 }, group);
  } else {
    const line = { x1: x, y1: y, x2, y2 };
    svg('line', { ...line, stroke: 'transparent', 'stroke-width': 14 }, group);
    svg('line', { ...line, stroke: color, 'stroke-width': type === 'wall' ? 5 : 1.6 }, group);
    if (type === 'measure') {
      for (const [cx, cy] of [[x, y], [x2, y2]]) svg('circle', { cx, cy, r: 3, fill: color }, group);
      svg('text', { x: (x + x2) / 2, y: (y + y2) / 2 - 7, fill: color, 'font-size': 13, 'text-anchor': 'middle' },
        group, lengthText(Math.hypot(x2 - x, y2 - y)));
    }
  }
}

function renderDrawing() {
  let background = $('background');
  if (plan.background) {
    const { image, width, height } = plan.background;
    if (!background || background.getAttribute('href') !== image) {
      background?.remove();
      background = svg('image', { id: 'background', href: image, width, height, 'pointer-events': 'none' }, $('world'));
      $('world').insertBefore(background, drawing);
    }
  } else background?.remove();
  drawing.replaceChildren();
  for (const object of plan.objects) if (object.type === 'camera') cone(object, drawing, object.id === selected);
  for (const object of plan.objects) if (object.type !== 'camera') drawObject(object, object.id === selected);
  for (const object of plan.objects) if (object.type === 'camera' && object.id !== selected) drawObject(object, false);
  if (current()?.type === 'camera') drawObject(current(), true);
  if (gesture?.draft) drawObject(gesture.draft, true, true);
}

function field(parent, label, value, change, bounds) {
  const caption = document.createElement('label');
  caption.textContent = label;
  const input = document.createElement('input');
  if (bounds) {
    input.type = 'number';
    input.step = 'any';
    [input.min, input.max] = bounds;
  } else input.maxLength = 100;
  input.value = value;
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') input.blur();
  });
  input.addEventListener('change', () => {
    if (!input.value.trim() || !input.checkValidity()) {
      input.value = value;
      return;
    }
    change(bounds ? Number(input.value) : input.value.trim());
  });
  caption.append(input);
  parent.append(caption);
}

function button(label, action, parent) {
  const control = document.createElement('button');
  control.textContent = label;
  control.addEventListener('click', action);
  parent.append(control);
  return control;
}

function renderPanels() {
  const properties = $('properties');
  const objects = $('objects');
  properties.replaceChildren();
  objects.replaceChildren();
  const object = current();
  const note = document.createElement('p');
  const { pixelsPerUnit, unit } = plan.scale ?? defaultScale;
  note.textContent = object ? names[object.type] : 'Select an object to edit it.';
  properties.append(note);
  if (!plan.scale) {
    const scaleNote = document.createElement('p');
    scaleNote.textContent = plan.background
      ? 'PDF scale is estimated. Use Set scale with a known distance for accurate measurements.'
      : 'Default scale: 1 ft per grid square.';
    properties.append(scaleNote);
  }
  if (object) {
    function edit(changes) {
      const before = clone();
      Object.assign(object, changes);
      commit(before);
    }
    field(properties, object.type === 'label' ? 'Text' : 'Name', object.name, name => edit({ name }));
    const coordinateBounds = [-1000000 / pixelsPerUnit, 1000000 / pixelsPerUnit];
    for (const key of ['x', 'y', 'x2', 'y2']) {
      if (object[key] === undefined) continue;
      const axis = key[0].toUpperCase();
      const label = key.length === 1 ? axis : 'End ' + axis;
      field(properties, `${label} (${unit})`, Number((object[key] / pixelsPerUnit).toPrecision(8)), value => {
        const position = value * pixelsPerUnit;
        const changes = { [key]: position };
        const endpoint = key + '2';
        if (object[endpoint] !== undefined) changes[endpoint] = object[endpoint] + position - object[key];
        edit(changes);
      }, coordinateBounds);
    }
    if (object.type === 'camera') {
      field(properties, 'Direction (° clockwise from right)', Number(object.angle.toFixed(1)), angle => edit({ angle: angle % 360 }), [0, 360]);
      field(properties, 'Horizontal FOV (°)', object.fov, fov => edit({ fov }), [1, 359]);
      field(properties, `Range (${unit})`, Number((object.range / pixelsPerUnit).toPrecision(8)),
        range => edit({ range: range * pixelsPerUnit }), [Math.min(.000001, 1 / pixelsPerUnit), 100000 / pixelsPerUnit]);
    }
    button('Delete object', removeSelected, properties);
  } else if (plan.background) {
    button('Remove PDF background', () => {
      const before = clone();
      plan.background = null;
      commit(before);
    }, properties);
  }
  for (const item of plan.objects) {
    const control = button(item.name, () => {
      selected = item.id;
      setTool('select');
      render();
    }, objects);
    control.classList.toggle('active', item.id === selected);
  }
  $('undo').disabled = !past.length;
  $('redo').disabled = !future.length;
}

function render() {
  renderDrawing();
  renderPanels();
}

function markDirty() {
  dirty = true;
  revision++;
  status('Unsaved changes');
}

function commit(before) {
  past.push(before);
  if (past.length > 40) past.shift();
  future = [];
  markDirty();
  render();
}

function history(from, to) {
  if (gesture || !from.length) return;
  to.push(clone());
  plan = from.pop();
  $('name').value = plan.name;
  if (!current()) selected = undefined;
  markDirty();
  render();
}

function setTool(next) {
  if (gesture) return;
  tool = next;
  canvas.dataset.tool = next;
  $('hint').textContent = tips[next];
  for (const control of document.querySelectorAll('button[data-tool]')) {
    control.classList.toggle('active', control.dataset.tool === next);
    control.setAttribute('aria-pressed', control.dataset.tool === next);
  }
}

function local(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function world(point) {
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}

function snap(point) {
  if (!$('snap').checked || tool === 'scale') return point;
  return { x: Math.round(point.x / 20) * 20, y: Math.round(point.y / 20) * 20 };
}

function add(type, point, details = {}) {
  const before = clone();
  const count = plan.objects.filter(item => item.type === type).length;
  const object = { id: globalThis.crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join(''),
    type, name: `${names[type]} ${count + 1}`, ...point, ...details };
  plan.objects.push(object);
  selected = object.id;
  if (type === 'camera' || type === 'label') setTool('select');
  commit(before);
}

function addCamera(point) {
  add('camera', snap(point), { angle: 0, fov: 100, range: 160 });
}

function removeSelected() {
  if (!current() || gesture) return;
  const before = clone();
  plan.objects = plan.objects.filter(object => object.id !== selected);
  selected = undefined;
  commit(before);
}

canvas.addEventListener('pointerdown', event => {
  if (gesture || ![0, 1].includes(event.button)) return;
  event.preventDefault();
  const screen = local(event);
  const point = world(screen);
  if (event.button === 1 || tool === 'pan') {
    gesture = { mode: 'pan', screen, view: { ...view } };
  } else if (tool === 'select') {
    selected = event.target.closest('[data-object]')?.dataset.object;
    const object = current();
    if (object) gesture = { mode: event.target.hasAttribute('data-aim') ? 'aim' : 'move',
      point, screen, object, original: { ...object }, before: clone() };
    render();
  } else if (tool === 'camera') {
    addCamera(point);
  } else if (tool === 'label') {
    const name = prompt('Label text');
    if (name?.trim()) add('label', snap(point), { name: name.trim().slice(0, 100) });
  } else {
    gesture = { mode: 'draw', start: snap(point), type: tool };
  }
  if (gesture) {
    gesture.pointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener('pointermove', event => {
  if (gesture?.pointer !== event.pointerId) return;
  const screen = local(event);
  const point = world(screen);
  const action = gesture;
  if (action.mode === 'pan') {
    view.x = action.view.x + screen.x - action.screen.x;
    view.y = action.view.y + screen.y - action.screen.y;
    updateView();
    return;
  }
  if (action.mode === 'draw') {
    const end = snap(point);
    action.draft = { ...action.start, x2: end.x, y2: end.y, type: action.type === 'scale' ? 'measure' : action.type };
  } else {
    if (!action.changed && distance(screen, action.screen) < 3) return;
    if (action.mode === 'aim') {
      action.object.angle = direction(action.object, point);
    } else {
      const original = action.original;
      const target = snap({ x: original.x + point.x - action.point.x, y: original.y + point.y - action.point.y });
      Object.assign(action.object, target);
      if (original.x2 !== undefined) {
        action.object.x2 = original.x2 + target.x - original.x;
        action.object.y2 = original.y2 + target.y - original.y;
      }
    }
    action.changed = true;
  }
  renderDrawing();
});

canvas.addEventListener('pointerup', event => {
  if (gesture?.pointer !== event.pointerId) return;
  const action = gesture;
  gesture = undefined;
  if (action.changed) return commit(action.before);
  if (action.mode === 'draw') {
    const end = snap(world(local(event)));
    const pixels = distance(action.start, end);
    if (pixels * view.zoom >= 3) {
      if (action.type === 'scale') {
        const answer = prompt('Real distance between these points (for example, 12 ft or 3.5 m)');
        const match = answer?.trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*(ft|m|in|cm)$/i);
        if (match && Number(match[1]) > 0 && Number.isFinite(Number(match[1]))) {
          const before = clone();
          plan.scale = { pixelsPerUnit: pixels / Number(match[1]), unit: match[2].toLowerCase() };
          setTool('select');
          return commit(before);
        }
        if (answer !== null) status('Enter a positive distance followed by ft, m, in, or cm.');
      } else if (action.type !== 'room' || (end.x !== action.start.x && end.y !== action.start.y)) {
        return add(action.type, action.start, { x2: end.x, y2: end.y });
      }
    }
  }
  render();
});

function cancelGesture() {
  if (!gesture) return;
  if (gesture.before) plan = gesture.before;
  gesture = undefined;
  render();
}
canvas.addEventListener('pointercancel', cancelGesture);
canvas.addEventListener('lostpointercapture', cancelGesture);

$('camera-tool').addEventListener('dragstart', event => {
  event.dataTransfer.setData('application/x-planner-camera', 'camera');
  event.dataTransfer.effectAllowed = 'copy';
});
canvas.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('application/x-planner-camera')) event.preventDefault();
});
canvas.addEventListener('drop', event => {
  if (event.dataTransfer.getData('application/x-planner-camera') !== 'camera') return;
  event.preventDefault();
  addCamera(world(local(event)));
});

function zoom(factor, anchor = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }) {
  if (gesture) return;
  const point = world(anchor);
  view.zoom = clamp(view.zoom * factor, .025, 12);
  view.x = anchor.x - point.x * view.zoom;
  view.y = anchor.y - point.y * view.zoom;
  updateView();
}

function fit() {
  const xs = [], ys = [];
  if (plan.background) {
    xs.push(0, plan.background.width);
    ys.push(0, plan.background.height);
  }
  for (const object of plan.objects) {
    xs.push(object.x, object.x2 ?? object.x);
    ys.push(object.y, object.y2 ?? object.y);
    if (object.type === 'camera') {
      const angles = [object.angle - object.fov / 2, object.angle + object.fov / 2];
      for (const axis of [0, 90, 180, 270]) {
        if (Math.abs((axis - object.angle + 540) % 360 - 180) <= object.fov / 2) angles.push(axis);
      }
      for (const angle of angles) {
        const [x, y] = polar(object.x, object.y, object.range, angle);
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (!xs.length) {
    view = { x: 28, y: 28, zoom: 1 };
  } else {
    const left = Math.min(...xs), top = Math.min(...ys);
    const width = Math.max(1, Math.max(...xs) - left), height = Math.max(1, Math.max(...ys) - top);
    const scale = clamp(Math.min((canvas.clientWidth - 70) / width, (canvas.clientHeight - 70) / height), .025, 2);
    view = { zoom: scale, x: (canvas.clientWidth - width * scale) / 2 - left * scale,
      y: (canvas.clientHeight - height * scale) / 2 - top * scale };
  }
  updateView();
}

canvas.addEventListener('wheel', event => {
  event.preventDefault();
  zoom(event.deltaY < 0 ? 1.13 : 1 / 1.13, local(event));
}, { passive: false });

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? `Request failed (${response.status}).`);
  }
  return response.json();
}

function reset(project, projectId) {
  plan = project;
  id = projectId;
  selected = undefined;
  past = [];
  future = [];
  dirty = false;
  revision++;
  $('name').value = plan.name;
  setTool('select');
  fit();
  render();
  status(projectId ? 'Project opened' : 'New project');
}

const confirmSwitch = () => !dirty || confirm('Discard unsaved changes to this project?');

$('name').addEventListener('change', () => {
  const before = clone();
  plan.name = $('name').value.trim() || 'Untitled plan';
  $('name').value = plan.name;
  if (before.name !== plan.name) commit(before);
});

$('save').onclick = async () => {
  const control = $('save');
  if (control.disabled || gesture) return;
  control.disabled = true;
  const savedRevision = revision;
  try {
    const result = await request(id ? '/api/projects/' + id : '/api/projects', {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan),
    });
    id = result.id;
    if (revision === savedRevision) {
      dirty = false;
      status('Project saved');
    }
  } catch (error) {
    status(error.message);
  } finally {
    control.disabled = false;
  }
};

$('new').onclick = () => {
  if (!$('save').disabled && confirmSwitch()) reset(fresh());
};
$('open').onclick = async () => {
  if ($('save').disabled) return;
  const list = $('projects');
  list.textContent = 'Loading…';
  $('open-dialog').showModal();
  try {
    const projects = await request('/api/projects');
    list.textContent = projects.length ? '' : 'No saved projects yet.';
    for (const project of projects) button(project.name, async () => {
      if (!confirmSwitch()) return;
      const opening = revision;
      try {
        const loaded = await request('/api/projects/' + project.id);
        if (!$('open-dialog').open || revision !== opening) return;
        reset(loaded, project.id);
        $('open-dialog').close();
      } catch (error) {
        list.textContent = error.message;
      }
    }, list);
  } catch (error) {
    list.textContent = error.message;
  }
};

$('import').onclick = () => $('pdf-dialog').showModal();
$('pdf-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('pdf-submit');
  if (submit.disabled) return;
  submit.disabled = true;
  $('pdf-status').textContent = 'Rendering page…';
  try {
    const file = $('pdf-file').files[0];
    const page = Number($('pdf-page').value);
    const result = await request('/api/pdf/' + page, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file,
    });
    const image = new Image();
    image.src = result.image;
    await image.decode();
    if (!$('pdf-dialog').open) return;
    const before = clone();
    plan.background = { image: result.image, width: image.naturalWidth, height: image.naturalHeight };
    if (before.background?.image !== result.image) plan.scale = null;
    commit(before);
    fit();
    $('pdf-dialog').close();
    status(`Imported page ${page} of ${result.pages} · Unsaved changes`);
    $('pdf-status').textContent = '';
  } catch (error) {
    $('pdf-status').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

for (const control of document.querySelectorAll('button[data-tool]')) {
  control.onclick = () => setTool(control.dataset.tool);
}
for (const control of document.querySelectorAll('[data-close]')) {
  control.onclick = () => $(control.dataset.close).close();
}
$('undo').onclick = () => history(past, future);
$('redo').onclick = () => history(future, past);
$('fit').onclick = fit;
$('zoom-in').onclick = () => zoom(1.25);
$('zoom-out').onclick = () => zoom(.8);

window.addEventListener('keydown', event => {
  if (event.target.matches('input,textarea,select') || document.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && ['s', 'z', 'y'].includes(key)) {
    event.preventDefault();
    if (key === 's') $('save').click();
    else if (key === 'y' || event.shiftKey) history(future, past);
    else history(past, future);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (key === 'delete' || key === 'backspace') {
    event.preventDefault();
    removeSelected();
  }
  if (key === 'escape') {
    cancelGesture();
    selected = undefined;
    setTool('select');
    render();
  }
  const shortcut = { v: 'select', h: 'pan', w: 'wall', r: 'room', d: 'door', t: 'label', m: 'measure', c: 'camera' }[key];
  if (shortcut) setTool(shortcut);
});

window.addEventListener('beforeunload', event => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
new ResizeObserver(updateView).observe(canvas);
setTool('select');
render();
