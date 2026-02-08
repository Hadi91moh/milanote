// Storage model:
// state = {
//   boards: { [id]: { id, parentId, title, slots: Array(null | {type:'board'|'item', id}) } },
//   items:  { [id]: { id, boardId, kind:'note'|'link', title, content, w, h } }
// }
//
// Slots are fixed positions (index-based).
// Rendering uses explicit grid placement so spans are possible.

const STORAGE_KEY = "boards_state_v4"; // keep same to preserve your existing data

const DEFAULT_SLOTS = 80;
const GRID_STEP = 20;
const GRID_MIN = 20;
const GRID_MAX = 400;

const elGrid = document.getElementById("grid");
const elCrumbs = document.getElementById("crumbs");
const elGridInfo = document.getElementById("gridInfo");

const overlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalInputTitle = document.getElementById("modalInputTitle");
const modalInputContent = document.getElementById("modalInputContent");
const modalContentLabel = document.getElementById("modalContentLabel");
const modalHint = document.getElementById("modalHint");
const modalSave = document.getElementById("modalSave");
const modalCancel = document.getElementById("modalCancel");
const modalClose = document.getElementById("modalClose");

const actionBoard = document.getElementById("actionBoard");
const actionNote = document.getElementById("actionNote");
const actionLink = document.getElementById("actionLink");

const modeMoveBtn = document.getElementById("modeMove");
const modeSizeBtn = document.getElementById("modeSize");
const modeTrashBtn = document.getElementById("modeTrash");

const btnGridPlus = document.getElementById("btnGridPlus");
const btnGridMinus = document.getElementById("btnGridMinus");
const btnRename = document.getElementById("btnRename");

const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");

let mode = "none";        // none | move | size | trash
let movePick = null;      // { slotIndex } or null
let sizePick = null;      // { anchorIndex, itemId, destIndex } or null

function uid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
}

function safeParseJSON(raw) { try { return JSON.parse(raw); } catch { return null; } }

function initBoard(title, parentId) {
  const id = uid();
  return { id, parentId: parentId ?? null, title: title || "Untitled", slots: Array(DEFAULT_SLOTS).fill(null) };
}

function migrateIfNeeded(state) {
  if (!state || !state.boards || !state.items) {
    const root = initBoard("My Board", null);
    return { boards: { [root.id]: root }, items: {} };
  }

  for (const b of Object.values(state.boards)) {
    if (!Array.isArray(b.slots)) b.slots = Array(DEFAULT_SLOTS).fill(null);
    if (b.slots.length < DEFAULT_SLOTS) {
      b.slots = b.slots.concat(Array(DEFAULT_SLOTS - b.slots.length).fill(null));
    }
  }

  // add default sizes for old items
  for (const it of Object.values(state.items)) {
    if (typeof it.w !== "number") it.w = 1;
    if (typeof it.h !== "number") it.h = 1;
    if (it.w < 1) it.w = 1;
    if (it.h < 1) it.h = 1;
  }

  return state;
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw ? safeParseJSON(raw) : null;
  const state = migrateIfNeeded(parsed);
  saveState(state);
  return state;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getCurrentBoardId(state) {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/b/")) return hash.slice("#/b/".length);
  const root = Object.values(state.boards).find(b => b.parentId === null);
  return root?.id;
}

function setCurrentBoard(boardId) {
  location.hash = `#/b/${boardId}`;
}

function breadcrumb(state, boardId) {
  const chain = [];
  let cur = state.boards[boardId];
  while (cur) {
    chain.push(cur);
    cur = cur.parentId ? state.boards[cur.parentId] : null;
  }
  return chain.reverse();
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function firstEmptySlot(board) {
  return board.slots.findIndex(x => x === null);
}

function getCols() {
  const tpl = getComputedStyle(elGrid).gridTemplateColumns;
  const cols = tpl.split(" ").filter(x => x.trim().length > 0).length;
  return Math.max(1, cols || 1);
}

function indexToRowCol(index, cols) {
  const row = Math.floor(index / cols) + 1;
  const col = (index % cols) + 1;
  return { row, col };
}

function rectCellsFromAnchor(anchorIndex, w, h, cols, maxSlots) {
  const { row: r0, col: c0 } = indexToRowCol(anchorIndex, cols);
  const cells = [];

  // prevent wrap
  if (c0 + w - 1 > cols) return [];

  for (let dr = 0; dr < h; dr++) {
    for (let dc = 0; dc < w; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      const idx = (r - 1) * cols + (c - 1);
      if (idx < 0 || idx >= maxSlots) return [];
      cells.push(idx);
    }
  }
  return cells;
}

function getSpanForRef(ref, state) {
  if (!ref) return { w: 1, h: 1 };
  if (ref.type === "board") return { w: 1, h: 1 };
  if (ref.type === "item") {
    const it = state.items[ref.id];
    return { w: Math.max(1, it?.w || 1), h: Math.max(1, it?.h || 1) };
  }
  return { w: 1, h: 1 };
}

function buildOccupancy(board, state, cols) {
  // Map cellIndex -> anchorIndex
  const occ = new Map();
  for (let i = 0; i < board.slots.length; i++) {
    const ref = board.slots[i];
    if (!ref) continue;

    const { w, h } = getSpanForRef(ref, state);
    const cells = rectCellsFromAnchor(i, w, h, cols, board.slots.length);
    for (const cell of cells) {
      // first wins (avoid changing behavior if overlaps exist due to old state)
      if (!occ.has(cell)) occ.set(cell, i);
    }
  }
  return occ;
}

function ensureGridSize(board, newSize) {
  const target = Math.max(GRID_MIN, Math.min(GRID_MAX, newSize));
  const cols = getCols();

  if (target < board.slots.length) {
    // cannot shrink if any occupied cell would be cut off
    const occ = buildOccupancy(board, loadState(), cols);
    for (const cell of occ.keys()) {
      if (cell >= target) {
        alert("Cannot shrink: there are tiles in the slots that would be removed. Move/resize them first.");
        return false;
      }
    }
    board.slots = board.slots.slice(0, target);
    return true;
  }

  if (target > board.slots.length) {
    board.slots = board.slots.concat(Array(target - board.slots.length).fill(null));
    return true;
  }

  return true;
}

function deleteBoardRecursive(state, boardId) {
  const board = state.boards[boardId];
  if (!board) return;

  for (const ref of board.slots) {
    if (!ref) continue;
    if (ref.type === "board") deleteBoardRecursive(state, ref.id);
    if (ref.type === "item") delete state.items[ref.id];
  }

  delete state.boards[boardId];

  for (const b of Object.values(state.boards)) {
    b.slots = b.slots.map(ref => (ref && ref.type === "board" && ref.id === boardId) ? null : ref);
  }
}

function openModal({ kind, modeLabel, initialTitle, initialContent, onSave }) {
  overlay.classList.remove("hidden");
  modalInputTitle.value = initialTitle || "";
  modalInputContent.value = initialContent || "";

  if (kind === "note") {
    modalTitle.textContent = modeLabel === "edit" ? "Edit Note" : "New Note";
    modalContentLabel.textContent = "Note";
    modalInputContent.placeholder = "Write your note…";
    modalHint.textContent = "";
  } else if (kind === "link") {
    modalTitle.textContent = modeLabel === "edit" ? "Edit Link" : "New Link";
    modalContentLabel.textContent = "URL";
    modalInputContent.placeholder = "https://example.com";
    modalHint.textContent = "If you omit https://, it will be added automatically.";
  } else if (kind === "board") {
    modalTitle.textContent = "Rename Board";
    modalContentLabel.textContent = "Name";
    modalInputContent.placeholder = "Board name";
    modalHint.textContent = "";
  } else {
    modalTitle.textContent = "Editor";
    modalContentLabel.textContent = "Content";
    modalHint.textContent = "";
  }

  const close = () => {
    overlay.classList.add("hidden");
    modalSave.onclick = null;
    document.onkeydown = null;
    overlay.onclick = null;
  };

  modalSave.onclick = () => {
    const title = modalInputTitle.value.trim();
    let content = modalInputContent.value.trim();
    if (!content) return;

    if (kind === "link" && !/^https?:\/\//i.test(content)) {
      content = "https://" + content;
    }

    onSave({ title: title || null, content });
    close();
  };

  modalCancel.onclick = close;
  modalClose.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.onkeydown = (e) => { if (e.key === "Escape") close(); };
}

function setMode(next) {
  mode = next;
  movePick = null;
  sizePick = null;

  modeMoveBtn.classList.toggle("on", mode === "move");
  modeSizeBtn.classList.toggle("on", mode === "size");
  modeTrashBtn.classList.toggle("on", mode === "trash");

  render();
}

// Mode toggles
modeMoveBtn.onclick = () => setMode(mode === "move" ? "none" : "move");
modeSizeBtn.onclick = () => setMode(mode === "size" ? "none" : "size");
modeTrashBtn.onclick = () => setMode(mode === "trash" ? "none" : "trash");

// Actions (create in next free slot)
actionBoard.onclick = () => {
  const state = loa
