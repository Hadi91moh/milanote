const STORAGE_KEY = "boards_state_v5";

const DEFAULT_SLOTS = 80;
const GRID_STEP = 20;
const GRID_MIN = 20;
const GRID_MAX = 400;

// ✅ Default size = 2x2 (4 blocks)
const DEFAULT_ITEM_W = 2;
const DEFAULT_ITEM_H = 2;

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
let sizePick = null;      // { anchorIndex, itemId } or null
let inlineEdit = null;    // { itemId, title, content } or null

function uid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
}

function safeParseJSON(raw) { try { return JSON.parse(raw); } catch { return null; } }

function initBoard(title, parentId) {
  const id = uid();
  return { id, parentId: parentId ?? null, title: title || "Untitled", slots: Array(DEFAULT_SLOTS).fill(null) };
}

function migrateIfNeeded(state) {
  // Fresh install
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
    if (typeof it.w !== "number") it.w = DEFAULT_ITEM_W;
    if (typeof it.h !== "number") it.h = DEFAULT_ITEM_H;
    it.w = Math.max(1, it.w);
    it.h = Math.max(1, it.h);

    if (typeof it.title !== "string" && it.title !== null) it.title = null;
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

// Find a truly empty cell (not inside resized tile)
function firstFreeCell(board, state, cols) {
  const occ = buildOccupancy(board, state, cols);
  for (let i = 0; i < board.slots.length; i++) {
    if (board.slots[i] !== null) continue;
    if (occ.has(i)) continue;
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

// Rename board modal only
function openModalRename({ initialContent, onSave }) {
  overlay.classList.remove("hidden");
  modalInputTitle.value = "";
  modalInputContent.value = initialContent || "";

  modalTitle.textContent = "Rename Board";
  modalContentLabel.textContent = "Name";
  modalHint.textContent = "";

  const close = () => {
    overlay.classList.add("hidden");
    modalSave.onclick = null;
    document.onkeydown = null;
    overlay.onclick = null;
  };

  modalSave.onclick = () => {
    const content = modalInputContent.value.trim();
    if (!content) return;
    onSave({ content });
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
  inlineEdit = null;

  modeMoveBtn.classList.toggle("on", mode === "move");
  modeSizeBtn.classList.toggle("on", mode === "size");
  modeTrashBtn.classList.toggle("on", mode === "trash");

  render();
}

modeMoveBtn.onclick = () => setMode(mode === "move" ? "none" : "move");
modeSizeBtn.onclick = () => setMode(mode === "size" ? "none" : "size");
modeTrashBtn.onclick = () => setMode(mode === "trash" ? "none" : "trash");

// ✅ Auto-save helper (NO trim for note/link content => preserves all spaces/newlines)
function commitInlineEdit(state) {
  if (!inlineEdit) return false;
  const it = state.items[inlineEdit.itemId];
  if (!it) return false;

  const titleRaw = inlineEdit.title ?? "";
  const contentRaw = inlineEdit.content ?? "";

  // title: treat whitespace-only as empty, but don't modify real content
  it.title = titleRaw.trim() === "" ? null : titleRaw;

  // content: preserve EXACT text (no trim!) for BOTH note and link
  it.content = contentRaw;

  return true;
}

// For opening links: normalize only for href (does NOT change stored content)
function normalizeHref(raw) {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const firstLine = s.split("\n")[0].trim();
  if (!firstLine) return "";
  return /^https?:\/\//i.test(firstLine) ? firstLine : `https://${firstLine}`;
}

// Create actions (default 2x2)
actionBoard.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  setMode("none");

  const cols = getCols();
  const idx = firstFreeCell(board, state, cols);
  if (idx < 0) return alert("No empty space. Increase grid size (+).");

  const newBoard = initBoard("New Board", boardId);
  state.boards[newBoard.id] = newBoard;
  board.slots[idx] = { type: "board", id: newBoard.id };

  saveState(state);
  render();
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
    title: null, content: "",
    w: DEFAULT_ITEM_W, h: DEFAULT_ITEM_H
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
    title: null, content: "",
    w: DEFAULT_ITEM_W, h: DEFAULT_ITEM_H
  };
  board.slots[idx] = { type: "item", id: itemId };

  saveState(state);
  render();
};

// Rename current board
btnRename.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  openModalRename({
    initialContent: board.title,
    onSave: ({ content }) => {
      board.title = content.trim();
      saveState(state);
      render();
    }
  });
};

// Grid size controls
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

function placeGrid(el, index, cols, spanW = 1, spanH = 1) {
  const { row, col } = indexToRowCol(index, cols);
  el.style.gridColumnStart = String(col);
  el.style.gridRowStart = String(row);
  el.style.gridColumnEnd = `span ${spanW}`;
  el.style.gridRowEnd = `span ${spanH}`;
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

    // BOARD CARD
    if (ref.type === "board") {
      const b = state.boards[ref.id];
      placeGrid(card, i, cols, 1, 1);

      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">BOARD</div>
          <div class="badge">▦</div>
        </div>
        <div class="cardTitle">${escapeHtml(b?.title || "(missing board)")}</div>
        <div class="itemBody">(tap to open)</div>
        <div class="cardHint"></div>
      `;

      card.onclick = () => onClickTile(state, boardId, i, ref);
      elGrid.appendChild(card);
      continue;
    }

    // ITEM CARD
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
        // EDIT MODE (no save/cancel buttons)
        const t = inlineEdit.title ?? "";
        const c = inlineEdit.content ?? "";

        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
            <div class="badge">${icon}</div>
          </div>

          <input class="inlineTitle" placeholder="Title (optional)" value="${escapeHtml(t)}">

          ${
            kind === "link"
              ? `<input class="inlineUrl" placeholder="Paste link here (optional)" value="${escapeHtml(c)}">`
              : `<textarea class="inlineBody" placeholder="Write here (optional)">${escapeHtml(c)}</textarea>`
          }

          <div class="cardHint">${sizeText} • tap card to save & exit</div>
        `;

        const titleEl = card.querySelector(".inlineTitle");
        const bodyEl  = card.querySelector(kind === "link" ? ".inlineUrl" : ".inlineBody");

        // Update edit buffer
        titleEl.oninput = () => { inlineEdit.title = titleEl.value; };
        bodyEl.oninput  = () => { inlineEdit.content = bodyEl.value; };

        // Prevent click inside inputs from closing edit mode
        titleEl.onpointerdown = (e) => e.stopPropagation();
        bodyEl.onpointerdown  = (e) => e.stopPropagation();

        // Focus typing field
        setTimeout(() => bodyEl.focus(), 0);

        // ✅ Tap the card (outside input) => SAVE + EXIT
        card.onclick = (e) => {
          e.stopPropagation();
          if (commitInlineEdit(state)) saveState(state);
          inlineEdit = null;
          render();
        };

      } else {
        // VIEW MODE (scrollable + preserves whitespace)
        const titleText = it?.title ? it.title : "(no title)";
        const raw = it?.content || "";

        let bodyNodeHtml = "";
        if (kind === "link") {
          const href = normalizeHref(raw);
          if (href) {
            bodyNodeHtml = `<a target="_blank" href="${escapeHtml(href)}" onclick="event.stopPropagation()">${escapeHtml(raw || href)}</a>`;
          } else {
            bodyNodeHtml = `<div style="opacity:.6">(empty link)</div>`;
          }
        } else {
          bodyNodeHtml = escapeHtml(raw);
        }

        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
            <div class="badge">${icon}</div>
          </div>
          <div class="cardTitle">${escapeHtml(titleText)}</div>
          <div class="itemBody ${kind === "link" ? "link" : ""}">${bodyNodeHtml}</div>
          <div class="cardHint">${
            mode === "trash" ? "Click to delete" :
            mode === "move"  ? "Move: pick then click empty slot" :
            mode === "size"  ? `Size: click empty slot to expand • ${sizeText}` :
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
      const anchorAtCell = occ.get(cell);
      if (anchorAtCell !== undefined && anchorAtCell !== src) return;
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

    const cells = rectCellsFromAnchor(anchorIndex, newW, newH, cols, board.slots.length);
    if (cells.length === 0) return;

    for (const cell of cells) {
      const anchorAtCell = occ.get(cell);
      if (anchorAtCell !== undefined && anchorAtCell !== anchorIndex) return;
    }

    it.w = newW;
    it.h = newH;

    saveState(state);
    render();
    return;
  }
}

function onClickTile(state, boardId, slotIndex, ref) {
  const board = state.boards[boardId];

  // If you're editing something and tap another tile => save previous first
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

  // MOVE (pick)
  if (mode === "move") {
    movePick = { slotIndex };
    sizePick = null;
    inlineEdit = null;
    render();
    return;
  }

  // SIZE (only note/link)
  if (mode === "size") {
    inlineEdit = null;

    if (ref.type === "item") {
      const it = state.items[ref.id];
      if (it && (it.kind === "note" || it.kind === "link")) {
        // click again resets to default 2x2
        if (sizePick && sizePick.anchorIndex === slotIndex) {
          it.w = DEFAULT_ITEM_W;
          it.h = DEFAULT_ITEM_H;
          sizePick = null;
          saveState(state);
          render();
          return;
        }
        sizePick = { anchorIndex: slotIndex, itemId: ref.id };
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

  // NORMAL
  if (ref.type === "board") {
    inlineEdit = null;
    setCurrentBoard(ref.id);
    return;
  }

  if (ref.type === "item") {
    const it = state.items[ref.id];
    if (!it) return;

    // Enter edit mode
    inlineEdit = {
      itemId: ref.id,
      title: it.title || "",
      content: it.content || ""
    };
    render();
    return;
  }
}

// ✅ Tap outside cards to auto-save & exit edit mode
document.addEventListener("pointerdown", (e) => {
  if (!inlineEdit) return;
  if (e.target.closest(".card")) return; // other cards handled by onClickTile
  const state = loadState();
  if (commitInlineEdit(state)) saveState(state);
  inlineEdit = null;
  render();
});

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
