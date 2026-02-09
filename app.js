const STORAGE_KEY = "boards_state_v7";

const DEFAULT_SLOTS = 80;
const GRID_STEP = 20;
const GRID_MIN = 20;
const GRID_MAX = 400;

// Defaults per type
const NOTE_DEFAULT_W = 2, NOTE_DEFAULT_H = 2;
const LINK_DEFAULT_W = 3, LINK_DEFAULT_H = 1; // ✅ requested

const elGrid = document.getElementById("grid");
const elCrumbs = document.getElementById("crumbs");
const elGridInfo = document.getElementById("gridInfo");

const overlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalInputTitle = document.getElementById("modalInputTitle");     // exists in HTML
const modalInputContent = document.getElementById("modalInputContent"); // used for board name
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
let sizePick = null;      // { anchorIndex, itemId } or null
let inlineEdit = null;    // { itemId, draft } or null

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

  for (const it of Object.values(state.items)) {
    if (typeof it.w !== "number") it.w = (it.kind === "link" ? LINK_DEFAULT_W : NOTE_DEFAULT_W);
    if (typeof it.h !== "number") it.h = (it.kind === "link" ? LINK_DEFAULT_H : NOTE_DEFAULT_H);
    it.w = Math.max(1, it.w);
    it.h = Math.max(1, it.h);
    if (typeof it.content !== "string") it.content = "";
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
  if (c0 + w - 1 > cols) return []; // prevent wrap

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
  const occ = new Map(); // cellIndex -> anchorIndex
  for (let i = 0; i < board.slots.length; i++) {
    const ref = board.slots[i];
    if (!ref) continue;
    const { w, h } = getSpanForRef(ref, state);
    const cells = rectCellsFromAnchor(i, w, h, cols, board.slots.length);
    for (const cell of cells) {
      if (!occ.has(cell)) occ.set(cell, i);
    }
  }
  return occ;
}

function firstFreeCell(board, state, cols) {
  const occ = buildOccupancy(board, state, cols);
  for (let i = 0; i < board.slots.length; i++) {
    if (board.slots[i] !== null) continue; // must be empty anchor
    if (occ.has(i)) continue;              // must be empty footprint
    return i;
  }
  return -1;
}

function ensureGridSize(board, newSize) {
  const target = Math.max(GRID_MIN, Math.min(GRID_MAX, newSize));
  const cols = getCols();
  const state = loadState();
  const occ = buildOccupancy(board, state, cols);

  if (target < board.slots.length) {
    for (const cell of occ.keys()) {
      if (cell >= target) {
        alert("Cannot shrink: tiles exist in removed slots. Move/resize first.");
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

/* ---------- Modal helpers (board name) ---------- */
function openBoardNameModal({ title, initialName, onOk }) {
  overlay.classList.remove("hidden");

  modalTitle.textContent = title;
  modalContentLabel.textContent = "Board name";
  modalHint.textContent = "";

  modalInputTitle.value = "";
  modalInputTitle.style.display = "none";
  modalInputContent.value = initialName || "";
  modalInputContent.placeholder = "Example: Projects";

  const close = () => {
    overlay.classList.add("hidden");
    modalSave.onclick = null;
    document.onkeydown = null;
    overlay.onclick = null;
    modalInputTitle.style.display = "";
  };

  modalSave.onclick = () => {
    const name = modalInputContent.value.trim();
    if (!name) return;
    onOk(name);
    close();
  };

  modalCancel.onclick = close;
  modalClose.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.onkeydown = (e) => { if (e.key === "Escape") close(); };

  setTimeout(() => modalInputContent.focus(), 0);
}

/* ---------- Mode ---------- */
function setMode(next) {
  mode = next;
  movePick = null;
  sizePick = null;

  modeMoveBtn.classList.toggle("on", mode === "move");
  modeSizeBtn.classList.toggle("on", mode === "size");
  modeTrashBtn.classList.toggle("on", mode === "trash");

  render();
}

modeMoveBtn.onclick = () => setMode(mode === "move" ? "none" : "move");
modeSizeBtn.onclick = () => setMode(mode === "size" ? "none" : "size");
modeTrashBtn.onclick = () => setMode(mode === "trash" ? "none" : "trash");

/* ---------- Create actions ---------- */
actionBoard.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  setMode("none");

  const cols = getCols();
  const idx = firstFreeCell(board, state, cols);
  if (idx < 0) return alert("No empty space. Increase grid size (+).");

  openBoardNameModal({
    title: "Create Board",
    initialName: "New Board",
    onOk: (name) => {
      const newBoard = initBoard(name, boardId);
      state.boards[newBoard.id] = newBoard;
      board.slots[idx] = { type: "board", id: newBoard.id };
      saveState(state);
      render();
    }
  });
};

actionNote.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  setMode("none");

  const cols = getCols();
  const idx = firstFreeCell(board, state, cols);
  if (idx < 0) return alert("No empty space. Increase grid size (+).");

  const itemId = uid();
  state.items[itemId] = {
    id: itemId, boardId, kind: "note",
    content: "",
    w: NOTE_DEFAULT_W, h: NOTE_DEFAULT_H
  };
  board.slots[idx] = { type: "item", id: itemId };

  saveState(state);
  render();
};

actionLink.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  setMode("none");

  const cols = getCols();
  const idx = firstFreeCell(board, state, cols);
  if (idx < 0) return alert("No empty space. Increase grid size (+).");

  const itemId = uid();
  state.items[itemId] = {
    id: itemId, boardId, kind: "link",
    content: "",
    w: LINK_DEFAULT_W, h: LINK_DEFAULT_H   // ✅ default 3x1
  };
  board.slots[idx] = { type: "item", id: itemId };

  saveState(state);
  render();
};

btnRename.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  openBoardNameModal({
    title: "Rename Board",
    initialName: board.title,
    onOk: (name) => {
      board.title = name;
      saveState(state);
      render();
    }
  });
};

/* ---------- Grid size controls ---------- */
btnGridPlus.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  if (ensureGridSize(board, board.slots.length + GRID_STEP)) {
    saveState(state);
    render();
  }
};

btnGridMinus.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  if (ensureGridSize(board, board.slots.length - GRID_STEP)) {
    saveState(state);
    render();
  }
};

/* ---------- Size + overlap safe setter ---------- */
function canPlaceRect(board, state, cols, anchorIndex, newW, newH) {
  const occ = buildOccupancy(board, state, cols);
  const cells = rectCellsFromAnchor(anchorIndex, newW, newH, cols, board.slots.length);
  if (cells.length === 0) return false;

  for (const cell of cells) {
    const owner = occ.get(cell);
    // allowed if empty or owned by this same anchor
    if (owner !== undefined && owner !== anchorIndex) return false;
  }
  return true;
}

function applyResize(board, state, cols, anchorIndex, newW, newH) {
  const ref = board.slots[anchorIndex];
  if (!ref || ref.type !== "item") return false;
  const it = state.items[ref.id];
  if (!it) return false;

  if (!canPlaceRect(board, state, cols, anchorIndex, newW, newH)) return false;

  it.w = newW;
  it.h = newH;
  return true;
}

/* ---------- Render helpers ---------- */
function placeGrid(el, index, cols, spanW = 1, spanH = 1) {
  const { row, col } = indexToRowCol(index, cols);
  el.style.gridColumnStart = String(col);
  el.style.gridRowStart = String(row);
  el.style.gridColumnEnd = `span ${spanW}`;
  el.style.gridRowEnd = `span ${spanH}`;
}

// preserve exact content (no trim)
function commitInlineEdit(state) {
  if (!inlineEdit) return false;
  const it = state.items[inlineEdit.itemId];
  if (!it) return false;
  it.content = inlineEdit.draft ?? "";
  return true;
}

function normalizeHrefFromLine(line) {
  const s = (line ?? "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function render() {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];

  if (!board) {
    const root = Object.values(state.boards).find(b => b.parentId === null);
    if (root) setCurrentBoard(root.id);
    return;
  }

  const cols = getCols();
  const occ = buildOccupancy(board, state, cols);

  elGridInfo.textContent = `Slots: ${board.slots.length}`;

  const crumbs = breadcrumb(state, boardId);
  elCrumbs.innerHTML = crumbs.map((b, i) => {
    if (i === crumbs.length - 1) return `<span>${escapeHtml(b.title)}</span>`;
    return `<a href="#/b/${b.id}">${escapeHtml(b.title)}</a> <span>/</span> `;
  }).join("");

  elGrid.innerHTML = "";

  // Slot overlays for targets (move/size)
  for (let i = 0; i < board.slots.length; i++) {
    const slot = document.createElement("div");
    slot.className = "slot";
    placeGrid(slot, i, cols, 1, 1);

    const isOccupiedCell = occ.has(i);
    const showTargets = (mode === "move" || mode === "size") && !isOccupiedCell;

    if (showTargets) {
      slot.classList.add("target");
      slot.onclick = () => onClickEmptyCell(state, boardId, i);
    }

    elGrid.appendChild(slot);
  }

  // Cards for anchors
  for (let i = 0; i < board.slots.length; i++) {
    const ref = board.slots[i];
    if (!ref) continue;

    const card = document.createElement("div");
    card.className = "card";

    if (mode === "trash") card.classList.add("trashPulse");
    if (mode === "move" && movePick && movePick.slotIndex === i) card.classList.add("selected");
    if (mode === "size" && sizePick && sizePick.anchorIndex === i) card.classList.add("selected");

    // BOARD card (title only)
    if (ref.type === "board") {
      const b = state.boards[ref.id];
      placeGrid(card, i, cols, 1, 1);

      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">BOARD</div>
          <div class="badge">▦</div>
        </div>
        <div class="cardTitle">${escapeHtml(b?.title || "Board")}</div>
        <div class="cardHint"></div>
      `;

      card.onclick = () => {
        if (mode === "trash") return onClickTile(state, boardId, i, ref);
        setCurrentBoard(ref.id);
      };

      elGrid.appendChild(card);
      continue;
    }

    // NOTE/LINK card
    if (ref.type === "item") {
      const it = state.items[ref.id];
      const kind = it?.kind || "note";
      const icon = kind === "link" ? "🔗" : "📝";

      const spanW = Math.max(1, it?.w || 1);
      const spanH = Math.max(1, it?.h || 1);
      placeGrid(card, i, cols, spanW, spanH);

      const sizeText = `Size: ${spanW}×${spanH}`;
      const editing = inlineEdit && inlineEdit.itemId === ref.id;

      if (editing) {
        const draft = inlineEdit.draft ?? "";

        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
            <div class="badge">${icon}</div>
          </div>

          ${
            kind === "link"
              ? `<textarea class="inlineUrl" placeholder="One link per line (Enter = new line)">${escapeHtml(draft)}</textarea>`
              : `<textarea class="inlineBody" placeholder="Write here (optional)">${escapeHtml(draft)}</textarea>`
          }

          <div class="cardHint">${sizeText}</div>

          <div class="inlineActions">
            <button class="tinyBtn">Cancel</button>
            <button class="tinyBtn primary">Save</button>
          </div>
        `;

        const bodyEl = card.querySelector(kind === "link" ? ".inlineUrl" : ".inlineBody");
        const cancelEl = card.querySelector(".tinyBtn");
        const saveEl = card.querySelector(".tinyBtn.primary");

        bodyEl.oninput = () => { inlineEdit.draft = bodyEl.value; };
        bodyEl.onpointerdown = (e) => e.stopPropagation();

        setTimeout(() => bodyEl.focus(), 0);

        cancelEl.onclick = (e) => {
          e.stopPropagation();
          inlineEdit = null;
          render();
        };

        saveEl.onclick = (e) => {
          e.stopPropagation();
          if (commitInlineEdit(state)) saveState(state);
          inlineEdit = null;
          render();
        };

        card.onclick = (e) => e.stopPropagation();

      } else {
        const raw = it?.content || "";

        let bodyHtml = "";
        if (kind === "link") {
          const lines = raw.split("\n");
          bodyHtml = lines.map(line => {
            // preserve blank lines visually
            if (line === "") return `<div class="linkLine">&nbsp;</div>`;
            const href = normalizeHrefFromLine(line);
            if (!href) return `<div class="linkLine">${escapeHtml(line)}</div>`;
            return `<div class="linkLine"><a target="_blank" href="${escapeHtml(href)}" onclick="event.stopPropagation()">${escapeHtml(line)}</a></div>`;
          }).join("");
        } else {
          bodyHtml = escapeHtml(raw);
        }

        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
            <div class="badge">${icon}</div>
          </div>
          <div class="itemBody ${kind === "link" ? "link" : ""}">${bodyHtml}</div>
          <div class="cardHint">${
            mode === "trash" ? "Click to delete" :
            mode === "move"  ? "Move: pick then click empty slot" :
            mode === "size"  ? `Size: click empty slot • tap selected tile = 1×1` :
            sizeText
          }</div>
        `;

        card.onclick = () => onClickTile(state, boardId, i, ref);
      }

      elGrid.appendChild(card);
      continue;
    }
  }
}

/* ---------- Interactions ---------- */

function onClickEmptyCell(state, boardId, destIndex) {
  const board = state.boards[boardId];
  const cols = getCols();
  const occ = buildOccupancy(board, state, cols);

  if (mode === "move") {
    if (!movePick) return;

    const src = movePick.slotIndex;
    const ref = board.slots[src];
    if (!ref) { movePick = null; return render(); }

    if (occ.has(destIndex)) return;

    const { w, h } = getSpanForRef(ref, state);
    const cells = rectCellsFromAnchor(destIndex, w, h, cols, board.slots.length);
    if (cells.length === 0) return;

    for (const cell of cells) {
      const owner = occ.get(cell);
      if (owner !== undefined && owner !== src) return;
    }

    board.slots[destIndex] = ref;
    board.slots[src] = null;

    movePick = null;
    inlineEdit = null;
    saveState(state);
    render();
    return;
  }

  if (mode === "size") {
    if (!sizePick) return;

    const anchorIndex = sizePick.anchorIndex;
    const ref = board.slots[anchorIndex];
    if (!ref || ref.type !== "item") return;

    const it = state.items[ref.id];
    if (!it || (it.kind !== "note" && it.kind !== "link")) return;

    const a = indexToRowCol(anchorIndex, cols);
    const d = indexToRowCol(destIndex, cols);
    if (d.row < a.row || d.col < a.col) return;

    const newW = d.col - a.col + 1;
    const newH = d.row - a.row + 1;

    // ✅ overlap-safe resize
    if (!applyResize(board, state, cols, anchorIndex, newW, newH)) return;

    saveState(state);
    render();
    return;
  }
}

function onClickTile(state, boardId, slotIndex, ref) {
  const board = state.boards[boardId];

  // If editing something else, save it first
  if (inlineEdit && !(ref.type === "item" && inlineEdit.itemId === ref.id)) {
    if (commitInlineEdit(state)) saveState(state);
    inlineEdit = null;
  }

  // TRASH
  if (mode === "trash") {
    inlineEdit = null;

    if (ref.type === "item") {
      const it = state.items[ref.id];
      if (!confirm(`Delete this ${it?.kind || "item"}?`)) return;
      delete state.items[ref.id];
      board.slots[slotIndex] = null;
      saveState(state);
      render();
      return;
    }

    if (ref.type === "board") {
      const b = state.boards[ref.id];
      if (!confirm(`Delete board "${b?.title || ""}" and everything inside it?`)) return;
      deleteBoardRecursive(state, ref.id);
      board.slots[slotIndex] = null;
      saveState(state);
      render();
      return;
    }
  }

  // MOVE
  if (mode === "move") {
    movePick = { slotIndex };
    sizePick = null;
    inlineEdit = null;
    render();
    return;
  }

  // SIZE
  if (mode === "size") {
    inlineEdit = null;

    if (ref.type === "item") {
      const it = state.items[ref.id];
      if (!it || (it.kind !== "note" && it.kind !== "link")) return;

      // select tile for sizing
      if (!sizePick || sizePick.anchorIndex !== slotIndex) {
        sizePick = { anchorIndex: slotIndex, itemId: ref.id };
        render();
        return;
      }

      // ✅ tap selected tile again => shrink to 1x1
      // if already 1x1 => try return to default size (overlap-safe)
      const cols = getCols();
      if (it.w !== 1 || it.h !== 1) {
        it.w = 1; it.h = 1;
        saveState(state);
        render();
        return;
      } else {
        const defW = (it.kind === "link") ? LINK_DEFAULT_W : NOTE_DEFAULT_W;
        const defH = (it.kind === "link") ? LINK_DEFAULT_H : NOTE_DEFAULT_H;
        const ok = applyResize(board, state, cols, slotIndex, defW, defH);
        if (!ok) {
          alert("Not enough empty space to return to default size here. Move tiles or pick a free area.");
        } else {
          saveState(state);
        }
        render();
        return;
      }
    }

    if (ref.type === "board") {
      sizePick = null;
      setCurrentBoard(ref.id);
      return;
    }

    return;
  }

  // NORMAL: open item editor
  if (ref.type === "item") {
    const it = state.items[ref.id];
    if (!it) return;

    inlineEdit = {
      itemId: ref.id,
      draft: it.content || ""
    };
    render();
    return;
  }
}

// Routing
window.addEventListener("hashchange", () => {
  movePick = null;
  sizePick = null;
  inlineEdit = null;
  render();
});

// Export / Import
exportBtn.onclick = () => {
  const data = localStorage.getItem(STORAGE_KEY) || "{}";
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "boards-backup.json";
  a.click();
  URL.revokeObjectURL(url);
};

importInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const migrated = migrateIfNeeded(parsed);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    location.hash = "#/";
    setMode("none");
    render();
  } catch {
    alert("Import failed: invalid JSON.");
  } finally {
    e.target.value = "";
  }
});

render();
