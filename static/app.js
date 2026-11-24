const $ = id => document.getElementById(id);
const canvas = $('canvas');
const drawing = $('drawing');
const themeToggle = $('theme-toggle');
const themeKey = 'camera-planner-theme';

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeToggle.setAttribute('aria-pressed', String(dark));
}

let savedTheme;
try {
  savedTheme = localStorage.getItem(themeKey);
} catch {
  // Storage may be disabled by the browser.
}
applyTheme(savedTheme === 'dark');
themeToggle.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  applyTheme(dark);
  try {
    localStorage.setItem(themeKey, dark ? 'dark' : 'light');
  } catch {
    // The current tab can still switch themes.
  }
});
const defaultScale = { pixelsPerUnit: 20, unit: 'ft' };
const fresh = () => ({ name: 'Untitled plan', objects: [], background: null, scale: null });
let plan = fresh();
let id, gesture;
const touches = new Map();
let pinch;
let suppressTouch = false;
const selected = new Set();
let tool = 'select';
let view = { x: 28, y: 28, zoom: 1 };
let past = [], future = [];
let dirty = false, revision = 0;
const tips = {
  select: 'Shift-click to toggle objects. Drag on empty canvas to select an area.',
  pan: 'Drag to pan the drawing.',
  wall: 'Drag to trace a wall. Nearby joins and nearly straight strokes snap automatically.',
  room: 'Drag between opposite corners of the room.',
  door: 'Drag from the hinge toward the closed end along the wall.',
  doorway: 'Drag between the two sides of the doorway along the wall.',
  window: 'Drag between the ends of the window along the wall.',
  label: 'Click to place a label.',
  measure: 'Drag between two points to add a dimension.',
  scale: 'Drag along a known distance to calibrate the plan.',
  camera: 'Tap or click the plan to place a camera.',
};
const names = { wall: 'Wall', room: 'Room', door: 'Door', doorway: 'Doorway', window: 'Window', measure: 'Dimension', camera: 'Camera', label: 'Label' };
const isOpening = type => ['door', 'doorway', 'window'].includes(type);
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const radians = degrees => degrees * Math.PI / 180;
const direction = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 360) % 360;
const polar = (x, y, range, angle) => [x + range * Math.cos(radians(angle)), y + range * Math.sin(radians(angle))];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const current = () => selected.size === 1 ? plan.objects.find(object => selected.has(object.id)) : undefined;
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
  const touch = matchMedia('(any-pointer: coarse)').matches;
  for (const handle of drawing.querySelectorAll('[data-door-swing], [data-wall-end], [data-aim]')) {
    handle.setAttribute('r', touch ? 13 / view.zoom : handle.hasAttribute('data-aim') ? 7 : 8 / view.zoom);
  }
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
    fill: '#12a899', 'fill-opacity': active ? .25 : .15, stroke: 'var(--drawing-accent)',
    'stroke-opacity': active ? .85 : .55, 'pointer-events': 'none',
  }, parent);
}

function drawWall(x, y, x2, y2, color, width, group, openings) {
  const length = Math.hypot(x2 - x, y2 - y);
  if (!length) return;
  const dx = (x2 - x) / length;
  const dy = (y2 - y) / length;
  const gaps = [];
  for (const opening of openings) {
    const { x: ax, y: ay, x2: bx, y2: by } = opening;
    if (Math.abs((ax - x) * dy - (ay - y) * dx) > .75 ||
        Math.abs((bx - x) * dy - (by - y) * dx) > .75) continue;
    const start = (ax - x) * dx + (ay - y) * dy;
    const end = (bx - x) * dx + (by - y) * dy;
    const left = Math.max(0, Math.min(start, end));
    const right = Math.min(length, Math.max(start, end));
    if (left < right) gaps.push([left, right]);
  }
  gaps.sort((a, b) => a[0] - b[0]);
  function segment(start, end) {
    const line = { x1: x + start * dx, y1: y + start * dy, x2: x + end * dx, y2: y + end * dy };
    svg('line', { ...line, stroke: 'transparent', 'stroke-width': 14 }, group);
    svg('line', { ...line, stroke: color, 'stroke-width': width }, group);
  }
  let cursor = 0;
  for (const [start, end] of gaps) {
    if (start > cursor) segment(cursor, start);
    cursor = Math.max(cursor, end);
  }
  if (cursor < length) segment(cursor, length);
}

function drawObject(object, active, parent, openings = [], preview = false, showHandles = active) {
  const { type, x, y, x2, y2 } = object;
  const color = type === 'wall' || type === 'room'
    ? (active ? '#ff4752' : '#e33138')
    : (active ? 'var(--drawing-accent)' : 'var(--drawing-ink)');
  const group = svg('g', preview ? {} : { 'data-object': object.id }, parent);
  if (type === 'camera') {
    const body = svg('g', { transform: `translate(${x} ${y}) rotate(${object.angle})` }, group);
    svg('rect', { x: -10, y: -7, width: 17, height: 14, rx: 3, fill: color, stroke: '#fff' }, body);
    svg('path', { d: 'M6 -4 L13 -7 V7 L6 4 Z', fill: color, stroke: '#fff' }, body);
    if (showHandles) {
      const handles = svg('g', { 'data-object': object.id, 'data-selection-handles': '' }, parent);
      const [cx, cy] = polar(x, y, Math.max(24, object.range), object.angle);
      svg('line', { x1: x, y1: y, x2: cx, y2: cy, stroke: color, 'stroke-dasharray': '5 4', 'pointer-events': 'none' }, handles);
      svg('circle', { cx, cy, r: 7, fill: '#fff', stroke: color, 'stroke-width': 2, 'data-aim': '' }, handles);
    }
    svg('text', { x: x + 13, y: y - 12, fill: color, 'font-size': 13 }, group, object.name);
  } else if (type === 'label') {
    svg('text', { x, y, fill: color, 'font-size': 16, 'font-weight': 600 }, group, object.name);
  } else if (type === 'room') {
    drawWall(x, y, x2, y, color, 4, group, openings);
    drawWall(x2, y, x2, y2, color, 4, group, openings);
    drawWall(x2, y2, x, y2, color, 4, group, openings);
    drawWall(x, y2, x, y, color, 4, group, openings);
  } else if (type === 'wall') {
    drawWall(x, y, x2, y2, color, 5, group, openings);
  } else if (type === 'doorway' || type === 'window') {
    const length = Math.hypot(x2 - x, y2 - y);
    if (!length) return;
    const nx = -(y2 - y) / length;
    const ny = (x2 - x) / length;
    const line = (ax, ay, bx, by) => svg('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: color, 'stroke-width': 1.75 }, group);
    svg('line', { x1: x, y1: y, x2, y2, stroke: 'transparent', 'stroke-width': 14 }, group);
    if (type === 'window') {
      for (const offset of [-3, 3]) line(x + nx * offset, y + ny * offset, x2 + nx * offset, y2 + ny * offset);
    }
    for (const [ax, ay] of [[x, y], [x2, y2]]) line(ax - nx * 5, ay - ny * 5, ax + nx * 5, ay + ny * 5);
  } else if (type === 'door') {
    const radius = Math.hypot(x2 - x, y2 - y);
    const side = object.reverseSwing ? -1 : 1;
    const openX = x - side * (y2 - y);
    const openY = y + side * (x2 - x);
    const path = `M ${x} ${y} L ${openX} ${openY} A ${radius} ${radius} 0 0 ${object.reverseSwing ? 1 : 0} ${x2} ${y2}`;
    svg('path', { d: path, fill: 'none', stroke: 'transparent', 'stroke-width': 14 }, group);
    svg('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2 }, group);
    if (showHandles && !preview) {
      const handles = svg('g', { 'data-object': object.id, 'data-selection-handles': '' }, parent);
      const dot = svg('circle', { cx: openX, cy: openY, r: 8 / view.zoom, fill: '#fff', stroke: color,
        'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', cursor: 'pointer', 'data-door-swing': '' }, handles);
      svg('title', {}, dot, 'Flip door swing');
    }
  } else {
    const line = { x1: x, y1: y, x2, y2 };
    svg('line', { ...line, stroke: 'transparent', 'stroke-width': 14 }, group);
    svg('line', { ...line, stroke: color, 'stroke-width': 1.6 }, group);
    if (type === 'measure') {
      for (const [cx, cy] of [[x, y], [x2, y2]]) svg('circle', { cx, cy, r: 3, fill: color }, group);
      svg('text', { x: (x + x2) / 2, y: (y + y2) / 2 - 7, fill: color, 'font-size': 13, 'text-anchor': 'middle' },
        group, lengthText(Math.hypot(x2 - x, y2 - y)));
    }
  }
}

function updatePdfOpacity(opacity) {
  $('background')?.setAttribute('opacity', opacity / 100);
  $('pdf-opacity-value').textContent = opacity + '%';
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
  const opacity = plan.background?.opacity ?? 100;
  $('pdf-opacity-control').hidden = !plan.background;
  $('remove-background').hidden = !plan.background;
  $('pdf-opacity').value = opacity;
  updatePdfOpacity(opacity);
  drawing.replaceChildren();
  drawPlanObjects(drawing, selected, gesture?.draft);
  if (selected.size) {
    for (const node of drawing.querySelectorAll('[data-object]:not([data-selection-handles])')) {
      if (!selected.has(node.dataset.object) || !node.childElementCount) continue;
      const { x, y, width, height } = node.getBBox();
      const padding = 5 / view.zoom;
      const outline = { x: x - padding, y: y - padding, width: width + padding * 2,
        height: height + padding * 2, fill: 'none', 'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none' };
      svg('rect', { ...outline, stroke: '#fff', 'stroke-width': 4 });
      svg('rect', { ...outline, stroke: '#165dcc', 'stroke-width': 2, 'stroke-dasharray': '6 3' });
    }
  }
  if (gesture?.mode === 'marquee' && gesture.end) {
    svg('rect', { ...selectionBox(gesture.point, gesture.end), fill: '#3898ff', 'fill-opacity': .16,
      stroke: '#3898ff', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' });
  }
  const wall = current();
  if (wall?.type === 'wall') {
    const handles = svg('g', { 'data-object': wall.id, 'data-selection-handles': '' });
    for (const end of ['', '2']) {
      const handle = svg('circle', {
        cx: wall['x' + end], cy: wall['y' + end], r: 7 / view.zoom,
        fill: '#fff', stroke: '#e33138', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke',
        cursor: 'grab', 'data-wall-end': end,
      }, handles);
      svg('title', {}, handle, 'Drag to resize wall');
    }
  }
  if (matchMedia('(any-pointer: coarse)').matches) updateView();
}

function drawPlanObjects(parent, selection = new Set(), draft) {
  for (const object of plan.objects) {
    if (object.type === 'camera') cone(object, parent, selection.has(object.id));
  }
  const openings = plan.objects.filter(object => isOpening(object.type));
  const wallOpenings = draft && isOpening(draft.type) ? [...openings, draft] : openings;
  for (const object of plan.objects) {
    if (object.type !== 'camera' && !isOpening(object.type)) drawObject(object, selection.has(object.id), parent, wallOpenings, false, selection.size === 1 && selection.has(object.id));
  }
  for (const object of openings) drawObject(object, selection.has(object.id), parent, [], false,
    selection.size === 1 && selection.has(object.id));
  for (const object of plan.objects) {
    if (object.type === 'camera') drawObject(object, selection.has(object.id), parent, [], false,
      selection.size === 1 && selection.has(object.id));
  }
  if (draft) drawObject(draft, true, parent, openings, true);
}

function openExport() {
  if (gesture) return;
  const opacity = plan.background?.opacity ?? 100;
  const empty = (!plan.background || opacity === 0) && !plan.objects.length;
  $('export-pdf').disabled = empty;
  $('export-jpg').disabled = empty;
  $('export-dialog').showModal();
}

function exportJson() {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = (plan.name.replace(/[^\p{L}\p{N} ._-]/gu, '_').trim() || 'floor-plan') + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  $('export-dialog').close();
  status('Project JSON exported');
}

function renderExport(includeTitle) {
  const opacity = plan.background?.opacity ?? 100;
  const printable = $('print-plan');
  printable.replaceChildren();
  if (includeTitle) {
    const title = document.createElement('h1');
    title.textContent = plan.name;
    printable.append(title);
  }
  const sheet = svg('svg', { role: 'img', 'aria-label': 'Floor plan and camera coverage' }, printable);
  const content = svg('g', {}, sheet);
  if (plan.background && opacity > 0) {
    const { image, width, height } = plan.background;
    svg('image', { href: image, width, height, opacity: opacity / 100 }, content);
  }
  drawPlanObjects(content);
  const { x, y, width, height } = content.getBBox();
  const margin = 16;
  sheet.setAttribute('viewBox', [x - margin, y - margin, width + margin * 2, height + margin * 2].join(' '));
  return sheet;
}

function exportPdf() {
  $('export-dialog').close();
  renderExport(true);
  window.print();
}

async function exportJpg() {
  $('export-dialog').close();
  let url;
  try {
    const sheet = renderExport(false);
    const bounds = sheet.viewBox.baseVal;
    const scale = 3200 / Math.max(bounds.width, bounds.height);
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    sheet.setAttribute('width', width);
    sheet.setAttribute('height', height);
    for (const node of sheet.querySelectorAll('[fill], [stroke]')) {
      for (const attr of ['fill', 'stroke']) {
        const token = node.getAttribute(attr)?.match(/^var\((--[\w-]+)\)$/)?.[1];
        if (token) node.setAttribute(attr, getComputedStyle(node).getPropertyValue(token).trim());
      }
    }
    const source = new XMLSerializer().serializeToString(sheet);
    const filename = plan.name.replace(/[^\p{L}\p{N} ._-]/gu, '_').trim() || 'floor-plan';
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
    $('print-plan').replaceChildren();
    await image.decode();
    const bitmap = document.createElement('canvas');
    bitmap.width = width;
    bitmap.height = height;
    const context = bitmap.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0);
    const blob = await new Promise(resolve => bitmap.toBlob(resolve, 'image/jpeg', .94));
    if (!blob || blob.type !== 'image/jpeg') throw new Error('JPEG encoding failed.');
    url = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.href = url;
    download.download = filename + '.jpg';
    download.click();
    status('JPG exported');
  } catch {
    $('print-plan').replaceChildren();
    status('Could not export the plan as JPG.');
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
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
  properties.replaceChildren();
  const object = current();
  $('properties-panel').hidden = selected.size === 0;
  document.querySelector('main').classList.toggle('has-selection', selected.size > 0);
  const note = document.createElement('p');
  const { pixelsPerUnit, unit } = plan.scale ?? defaultScale;
  note.textContent = selected.size > 1 ? `${selected.size} objects selected`
    : object ? names[object.type] : 'Select an object to edit it.';
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
    if (object.type === 'door') {
      button('Flip swing', () => flipDoorSwing(object), properties);
      button('Swap hinge', () => edit({ x: object.x2, y: object.y2, x2: object.x, y2: object.y,
        reverseSwing: !object.reverseSwing }), properties);
    }
    button('Delete object', removeSelected, properties);
  } else if (selected.size > 1) {
    button('Delete selected objects', removeSelected, properties);
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
  const survivingIds = new Set(plan.objects.map(object => object.id));
  for (const id of selected) if (!survivingIds.has(id)) selected.delete(id);
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

function wallEdges(excludedId) {
  return plan.objects.flatMap(({ id, type, x, y, x2, y2 }) => {
    if (excludedId !== undefined && id === excludedId) return [];
    const start = { x, y };
    const end = { x: x2, y: y2 };
    if (type === 'wall') return [[start, end]];
    if (type !== 'room') return [];
    const topRight = { x: x2, y };
    const bottomLeft = { x, y: y2 };
    return [[start, topRight], [topRight, end], [end, bottomLeft], [bottomLeft, start]];
  }).filter(([start, end]) => distance(start, end) > 0);
}

function projectOntoEdge(point, [start, end]) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const fraction = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return { x: start.x + fraction * dx, y: start.y + fraction * dy };
}

function nearest(point, candidates) {
  let bestDistance = 12 / view.zoom;
  let match;
  for (const candidate of candidates) {
    const gap = distance(point, candidate.point);
    if (gap < bestDistance) {
      match = candidate;
      bestDistance = gap;
    }
  }
  return match;
}

function wallStart(point, edges) {
  const endpoint = nearest(point, edges.flat().map(point => ({ point })));
  const wall = nearest(point, edges.map(edge => ({ edge, point: projectOntoEdge(point, edge) })));
  return endpoint?.point ?? wall?.point ?? snap(point);
}

function drawEnd(action, point) {
  if (action.freehand) return point;
  if (action.edge) return projectOntoEdge(point, action.edge);
  if (action.type !== 'wall') return snap(point);
  const { start, edges } = action;
  const endpoints = edges.flat().filter(endpoint => distance(start, endpoint) > .001);
  const endpoint = nearest(point, endpoints.map(point => ({ point })));
  if (endpoint) return endpoint.point;

  const dx = Math.abs(point.x - start.x);
  const dy = Math.abs(point.y - start.y);
  const lockedAxis = dy < dx * .2 ? 'y' : dx < dy * .2 ? 'x' : null;
  if (!lockedAxis) return wallStart(point, edges);

  // Intersect the straight stroke with nearby edges so a T-junction stays straight.
  const travelAxis = lockedAxis === 'x' ? 'y' : 'x';
  const intersections = [];
  for (const [a, b] of edges) {
    const delta = b[lockedAxis] - a[lockedAxis];
    if (!delta) continue;
    const fraction = (start[lockedAxis] - a[lockedAxis]) / delta;
    if (fraction < 0 || fraction > 1) continue;
    const intersection = {
      [lockedAxis]: start[lockedAxis],
      [travelAxis]: a[travelAxis] + fraction * (b[travelAxis] - a[travelAxis]),
    };
    if (distance(start, intersection) > .001) intersections.push({ point: intersection });
  }
  const join = nearest(point, intersections) ??
    nearest(point, edges.map(edge => ({ point: projectOntoEdge(point, edge) }))
      .filter(({ point: candidate }) => distance(start, candidate) > .001 &&
        Math.abs(candidate[lockedAxis] - start[lockedAxis]) < .001));
  return join?.point ?? { ...snap(point), [lockedAxis]: start[lockedAxis] };
}

function add(type, point, details = {}) {
  const before = clone();
  const count = plan.objects.filter(item => item.type === type).length;
  const object = { id: globalThis.crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join(''),
    type, name: `${names[type]} ${count + 1}`, ...point, ...details };
  plan.objects.push(object);
  selected.clear();
  selected.add(object.id);
  commit(before);
}

function addCamera(point) {
  add('camera', snap(point), { angle: 0, fov: 100, range: 160 });
}

function flipDoorSwing(door) {
  const before = clone();
  door.reverseSwing = !door.reverseSwing;
  commit(before);
}

function removeSelected() {
  if (!selected.size || gesture) return;
  const before = clone();
  plan.objects = plan.objects.filter(object => !selected.has(object.id));
  selected.clear();
  commit(before);
}

function selectionBox(start, end) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
}

function selectArea(action, end) {
  const box = selectionBox(action.point, end);
  if (!action.additive) selected.clear();
  for (const node of drawing.querySelectorAll('[data-object]')) {
    if (node.hasAttribute('data-selection-handles') || !node.childElementCount) continue;
    const bounds = node.getBBox();
    if (bounds.x <= box.x + box.width && bounds.x + bounds.width >= box.x &&
        bounds.y <= box.y + box.height && bounds.y + bounds.height >= box.y) {
      selected.add(node.dataset.object);
    }
  }
}

function touchPair() {
  const [a, b] = touches.values();
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, span: distance(a, b) };
}

function startTouch(event) {
  touches.set(event.pointerId, local(event));
  canvas.setPointerCapture(event.pointerId);
  if (touches.size === 2) {
    cancelGesture();
    const { center, span } = touchPair();
    pinch = { anchor: world(center), span: Math.max(1, span), zoom: view.zoom };
    suppressTouch = true;
  }
  return suppressTouch;
}

function updatePinch(event) {
  if (!touches.has(event.pointerId)) return false;
  touches.set(event.pointerId, local(event));
  if (pinch && touches.size >= 2) {
    const { center, span } = touchPair();
    view.zoom = clamp(pinch.zoom * span / pinch.span, .025, 12);
    view.x = center.x - pinch.anchor.x * view.zoom;
    view.y = center.y - pinch.anchor.y * view.zoom;
    updateView();
  }
  return suppressTouch;
}

function endTouch(event) {
  if (!touches.delete(event.pointerId)) return false;
  const suppressed = suppressTouch;
  if (touches.size < 2) pinch = undefined;
  if (!touches.size) suppressTouch = false;
  return suppressed;
}

function placeLabel(point) {
  const name = prompt('Label text');
  if (name?.trim()) add('label', snap(point), { name: name.trim().slice(0, 100) });
}

canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch' && startTouch(event)) return;
  if (gesture || ![0, 1].includes(event.button)) return;
  event.preventDefault();
  const screen = local(event);
  const point = world(screen);
  const additive = event.shiftKey || $('add-selection').getAttribute('aria-pressed') === 'true';
  if (event.button === 0 && event.target.closest('[data-door-swing]')) {
    const door = current();
    if (door?.type === 'door') return flipDoorSwing(door);
  }
  if (event.button === 1 || tool === 'pan') {
    gesture = { mode: 'pan', screen, view: { ...view } };
  } else if (tool === 'select') {
    const hit = event.target.closest('[data-object]')?.dataset.object;
    const object = plan.objects.find(item => item.id === hit);
    const handleTarget = event.target.closest('[data-wall-end], [data-aim]');
    if (!object) {
      gesture = { mode: 'marquee', point, screen, additive };
    } else if (additive && !handleTarget) {
      if (selected.has(hit)) selected.delete(hit);
      else selected.add(hit);
      render();
      return;
    } else if (!selected.has(hit)) {
      selected.clear();
      selected.add(hit);
    }
    if (object) {
      const handle = event.target.closest('[data-wall-end]');
      gesture = { mode: event.target.hasAttribute('data-aim') ? 'aim' : 'move',
        point, screen, object, original: { ...object }, before: clone() };
      if (gesture.mode === 'move') {
        gesture.collapse = hit;
        gesture.members = plan.objects.filter(item => selected.has(item.id))
          .map(item => ({ item, original: { ...item } }));
      }
      if (object.type === 'wall' && handle) {
        const end = handle.dataset.wallEnd;
        const fixed = end === '' ? '2' : '';
        Object.assign(gesture, {
          mode: 'resize-wall', type: 'wall', end, freehand: event.shiftKey,
          start: { x: object['x' + fixed], y: object['y' + fixed] },
          edges: event.shiftKey ? [] : wallEdges(object.id),
        });
      }
    }
    render();
  } else if (tool === 'camera' || tool === 'label') {
    if (event.pointerType === 'touch') {
      gesture = { mode: 'place', type: tool, point, screen };
    } else if (tool === 'camera') addCamera(point);
    else placeLabel(point);
  } else {
    const opening = isOpening(tool);
    const freehand = event.shiftKey && (opening || tool === 'wall');
    const edges = !freehand && (opening || tool === 'wall') ? wallEdges() : [];
    const anchor = opening && nearest(point, edges.map(edge => ({ edge, point: projectOntoEdge(point, edge) })));
    const start = freehand ? point : tool === 'wall' ? wallStart(point, edges) : anchor?.point ?? snap(point);
    gesture = { mode: 'draw', start, type: tool, edges, edge: anchor?.edge, freehand };
  }
  if (gesture) {
    gesture.pointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
  }
});

function resizeWall(action, screen, point) {
  if (!action.changed && distance(screen, action.screen) < 3) return;
  const x = 'x' + action.end;
  const y = 'y' + action.end;
  const end = drawEnd(action, {
    x: action.original[x] + point.x - action.point.x,
    y: action.original[y] + point.y - action.point.y,
  });
  if (distance(action.start, end) <= .001) return;
  action.object[x] = end.x;
  action.object[y] = end.y;
  action.changed = end.x !== action.original[x] || end.y !== action.original[y];
}

canvas.addEventListener('pointermove', event => {
  if (updatePinch(event)) return;
  if (gesture?.pointer !== event.pointerId) return;
  const screen = local(event);
  const point = world(screen);
  const action = gesture;
  if (action.mode === 'place') return;
  if (action.mode === 'pan') {
    view.x = action.view.x + screen.x - action.screen.x;
    view.y = action.view.y + screen.y - action.screen.y;
    updateView();
    return;
  }
  if (action.mode === 'marquee') {
    action.end = point;
  } else if (action.mode === 'draw') {
    const end = drawEnd(action, point);
    action.draft = { ...action.start, x2: end.x, y2: end.y, type: action.type === 'scale' ? 'measure' : action.type };
  } else if (action.mode === 'resize-wall') {
    resizeWall(action, screen, point);
  } else {
    if (!action.changed && distance(screen, action.screen) < 3) return;
    if (action.mode === 'aim') {
      action.object.angle = direction(action.object, point);
    } else {
      const original = action.original;
      const target = snap({ x: original.x + point.x - action.point.x, y: original.y + point.y - action.point.y });
      const dx = target.x - original.x;
      const dy = target.y - original.y;
      for (const { item, original: start } of action.members) {
        item.x = start.x + dx;
        item.y = start.y + dy;
        if (start.x2 !== undefined) {
          item.x2 = start.x2 + dx;
          item.y2 = start.y2 + dy;
        }
      }
    }
    action.changed = true;
  }
  renderDrawing();
});

canvas.addEventListener('pointerup', event => {
  if (endTouch(event)) return;
  if (gesture?.pointer !== event.pointerId) return;
  const action = gesture;
  gesture = undefined;
  if (action.mode === 'place') {
    if (distance(action.screen, local(event)) < 10) {
      if (action.type === 'camera') addCamera(action.point);
      else placeLabel(action.point);
    }
    return;
  }
  if (action.mode === 'resize-wall') {
    const screen = local(event);
    resizeWall(action, screen, world(screen));
  }
  if (action.changed) return commit(action.before);
  if (action.mode === 'marquee') {
    const screen = local(event);
    if (distance(screen, action.screen) >= 3) selectArea(action, world(screen));
    else if (!action.additive) selected.clear();
  } else if (action.mode === 'move') {
    selected.clear();
    selected.add(action.collapse);
  }
  if (action.mode === 'draw') {
    const end = drawEnd(action, world(local(event)));
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
for (const type of ['pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, event => {
    endTouch(event);
    if (gesture?.pointer === event.pointerId) cancelGesture();
  });
}

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
  selected.clear();
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

function parseProject(source) {
  const project = JSON.parse(source);
  if (!project || typeof project.name !== 'string' || !Array.isArray(project.objects)) {
    throw new Error('Choose a Camera Planner project JSON file.');
  }
  const ids = new Set();
  for (const object of project.objects) {
    if (!object || !Object.hasOwn(names, object.type) || typeof object.id !== 'string' ||
        !object.id || ids.has(object.id) || typeof object.name !== 'string') {
      throw new Error('The file contains an invalid drawing object.');
    }
    const fields = ['x', 'y'];
    if (object.type === 'camera') fields.push('angle', 'range', 'fov');
    else if (object.type !== 'label') fields.push('x2', 'y2');
    if (!fields.every(key => Number.isFinite(object[key])) ||
        (object.type === 'camera' && (object.range <= 0 || object.fov < 1 || object.fov > 359))) {
      throw new Error('The file contains invalid drawing dimensions.');
    }
    ids.add(object.id);
  }
  const { background, scale } = project;
  if (background != null && (typeof background.image !== 'string' ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(background.image) ||
      ![background.width, background.height].every(value => Number.isFinite(value) && value > 0) ||
      (background.opacity !== undefined && (!Number.isFinite(background.opacity) ||
        background.opacity < 0 || background.opacity > 100)))) {
    throw new Error('The file contains an invalid PDF background.');
  }
  if (scale != null && (!Number.isFinite(scale.pixelsPerUnit) || scale.pixelsPerUnit <= 0 ||
      !['ft', 'm', 'in', 'cm'].includes(scale.unit))) {
    throw new Error('The file contains an invalid measurement scale.');
  }
  return project;
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
  status('Saving project…');
  try {
    const result = await request(id ? '/api/projects/' + id : '/api/projects', {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan),
    });
    id = result.id;
    if (revision === savedRevision) {
      dirty = false;
      status('Project saved');
    } else {
      status('Project saved · Newer changes are unsaved');
    }
  } catch (error) {
    status('Save failed: ' + error.message);
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
  $('project-json-status').textContent = '';
  list.textContent = 'Loading…';
  $('open-dialog').showModal();
  try {
    const projects = await request('/api/projects');
    list.textContent = projects.length ? '' : 'No saved projects yet.';
    for (const project of projects) {
      const row = document.createElement('div');
      row.className = 'project-row';
      list.append(row);
      const open = button(project.name, async () => {
        if (!confirmSwitch()) return;
        const opening = revision;
        try {
          const loaded = await request('/api/projects/' + project.id);
          if (!$('open-dialog').open || revision !== opening || !row.isConnected) return;
          reset(loaded, project.id);
          $('open-dialog').close();
        } catch (error) {
          $('project-json-status').textContent = error.message;
        }
      }, row);
      const remove = button('Delete', async () => {
        if (!confirm(`Delete the saved project “${project.name}”? This cannot be undone.`)) return;
        $('project-json-status').textContent = '';
        open.disabled = remove.disabled = true;
        try {
          await request('/api/projects/' + project.id, { method: 'DELETE' });
          if (id === project.id) {
            id = undefined;
            markDirty();
            status('Saved copy deleted · Save project to keep the open drawing');
          }
          if (row.isConnected) {
            row.remove();
            if (!list.childElementCount) list.textContent = 'No saved projects yet.';
            $('project-json-status').textContent = 'Project deleted.';
          }
        } catch (error) {
          $('project-json-status').textContent = 'Delete failed: ' + error.message;
        } finally {
          open.disabled = remove.disabled = false;
        }
      }, row);
      remove.setAttribute('aria-label', 'Delete ' + project.name);
    }
  } catch (error) {
    list.textContent = error.message;
  }
};

$('import-json').onclick = () => $('project-json-file').click();
$('project-json-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  $('project-json-status').textContent = '';
  const opening = revision;
  try {
    if (file.size > 40 * 1024 * 1024) throw new Error('Project JSON is larger than 40 MiB.');
    const imported = parseProject(await file.text());
    if (!$('open-dialog').open || revision !== opening || !confirmSwitch()) return;
    reset(imported);
    markDirty();
    $('open-dialog').close();
    status('Project imported · Save project to keep a copy on this server');
  } catch (error) {
    if ($('open-dialog').open && revision === opening) {
      $('project-json-status').textContent = 'Import failed: ' + error.message;
    }
  }
});

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
$('remove-background').onclick = () => {
  if (!plan.background || gesture) return;
  const before = clone();
  plan.background = null;
  commit(before);
};

function updateFullscreen() {
  const active = Boolean(document.fullscreenElement) || document.body.classList.contains('expanded-editor');
  $('fullscreen').textContent = active ? 'Exit full screen' : 'Full screen';
  $('fullscreen').setAttribute('aria-pressed', String(active));
}

$('fullscreen').onclick = async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else if (document.body.classList.contains('expanded-editor')) {
    document.body.classList.remove('expanded-editor');
  } else {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      document.body.classList.add('expanded-editor');
    }
  }
  updateFullscreen();
};
document.addEventListener('fullscreenchange', updateFullscreen);
$('add-selection').onclick = event => {
  const control = event.currentTarget;
  const enabled = control.getAttribute('aria-pressed') !== 'true';
  control.setAttribute('aria-pressed', String(enabled));
  if (enabled) setTool('select');
};
$('pdf-opacity').addEventListener('input', event => updatePdfOpacity(event.target.valueAsNumber));
$('pdf-opacity').addEventListener('change', event => {
  const opacity = event.target.valueAsNumber;
  if (!plan.background || opacity === (plan.background.opacity ?? 100)) return;
  const before = clone();
  plan.background.opacity = opacity;
  commit(before);
});
$('export').onclick = openExport;
$('export-pdf').onclick = exportPdf;
$('export-jpg').onclick = exportJpg;
$('export-json').onclick = exportJson;
$('settings').onclick = () => $('settings-dialog').showModal();
request('/api/version').then(({ version }) => {
  $('app-version').textContent = version;
}).catch(() => {
  $('app-version').textContent = 'Unavailable';
});
window.addEventListener('afterprint', () => $('print-plan').replaceChildren());
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
  if (key === 'escape' && document.body.classList.contains('expanded-editor')) {
    document.body.classList.remove('expanded-editor');
    updateFullscreen();
    return;
  }
  if (key === 'escape') {
    cancelGesture();
    selected.clear();
    setTool('select');
    render();
  }
  const shortcut = { v: 'select', h: 'pan', w: 'wall', r: 'room', d: 'door', o: 'doorway', n: 'window', t: 'label', m: 'measure', c: 'camera' }[key];
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
