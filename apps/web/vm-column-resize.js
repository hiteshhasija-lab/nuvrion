// Drag-to-resize columns for the Virtual Machines list. Widths are remembered per browser.
// Double-click any resize handle to go back to the default layout.
const STORAGE_KEY = 'nuvrion.vmColumnWidths.v1', MIN_WIDTH = 44, CHECK_COLUMN = 0;
const table = document.querySelector('#view-inventory .vm-list-scroll table');
const scroller = table?.parentElement;
const headers = table ? [...table.querySelectorAll('thead th')] : [];

function loadWidths() {
  try {
    const widths = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return Array.isArray(widths) && widths.length === headers.length && widths.every(width => Number.isFinite(width) && width > 0) ? widths : null;
  } catch { return null; }
}
function saveWidths(widths) {
  try { widths ? localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)) : localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable: widths last until reload */ }
}

// With custom widths every column is pinned to its pixel width except the last, which also fills any space left over,
// so the table is always exactly as wide as its columns and scrolls sideways when they exceed the card.
function applyWidths(widths) {
  if (!widths) {
    headers.forEach(header => { header.style.width = ''; });
    table.style.width = '';
    return;
  }
  const available = scroller.clientWidth;
  if (!available) return;
  const pinned = widths.slice(0, -1).reduce((sum, width) => sum + width, 0), last = Math.max(widths.at(-1), available - pinned);
  headers.forEach((header, index) => { header.style.width = `${index === headers.length - 1 ? last : widths[index]}px`; });
  table.style.width = `${pinned + last}px`;
}
const renderedWidths = () => headers.map(header => Math.round(header.getBoundingClientRect().width));

function startResize(event, index) {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget, widths = loadWidths() ?? renderedWidths(), startX = event.clientX, startWidth = widths[index];
  handle.setPointerCapture(event.pointerId);
  handle.classList.add('dragging');
  document.body.classList.add('vm-column-resizing');
  const move = moveEvent => { widths[index] = Math.max(MIN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX)); applyWidths(widths); };
  const finish = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    handle.classList.remove('dragging');
    document.body.classList.remove('vm-column-resizing');
    saveWidths(widths);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

if (table && scroller && headers.length) {
  headers.forEach((header, index) => {
    if (index === CHECK_COLUMN) return;
    const handle = document.createElement('span');
    handle.className = 'vm-col-resizer';
    handle.title = 'Drag to resize · double-click to reset all columns';
    handle.addEventListener('pointerdown', event => startResize(event, index));
    handle.addEventListener('dblclick', event => { event.stopPropagation(); saveWidths(null); applyWidths(null); });
    header.append(handle);
  });
  // A drag or click on a handle must never reach the header's own click handler, which sorts the list.
  table.tHead.addEventListener('click', event => { if (event.target.closest('.vm-col-resizer')) { event.stopPropagation(); event.preventDefault(); } }, true);
  new ResizeObserver(() => applyWidths(loadWidths())).observe(scroller);
  applyWidths(loadWidths());
}
