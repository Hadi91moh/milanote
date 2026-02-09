// Storage model:
// state = {
//   boards: { [id]: { id, parentId, title, slots: Array(null | {type:'board'|'item', id}) } },
//   items:  { [id]: { id, boardId, kind:'note'|'link', title, content, w, h } }
// }

const STORAGE_KEY = "boards_state_v4";

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
let inlineEdit = null;    // { itemId, kind, title, content } or null

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
    if (typeof it.w !== "number") it.w = 1;
    if (typeof it.h !== "number") it.h = 1;
    if (it.w < 1) it.w = 1;
    if (it.h < 1) it.h = 1;

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

// Find a truly empty cell (not inside another resized tile)
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

// Modal only for Rename Board
function openModalRename({ initialContent, onSave }) {
  overlay.classList.remove("hidden");
  modalInputTitle.value = "";
  modalInputContent.value = initialContent || "";

  modalTitle.textContent = "Rename Board";
  modalContentLabel.textContent = "Name";
  modalInputContent.placeholder = "Board name";
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

// Create actions (always 1x1, title/content optional)
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
  state.items[itemId] = { id: itemId, boardId, kind: "note", title: null, content: "", w: 1, h: 1 };
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
  state.items[itemId] = { id: itemId, boardId, kind: "link", title: null, content: "", w: 1, h: 1 };
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

    if (ref.type === "board") {
      const b = state.boards[ref.id];
      placeGrid(card, i, cols, 1, 1);

      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">BOARD</div>
          <div class="badge">▦</div>
        </div>
        <div class="cardTitle">${escapeHtml(b?.title || "(missing board)")}</div>
        <div class="cardBody">${mode === "trash" ? "Click to delete" : (mode === "move" ? "Pick / move" : "Click to open")}</div>
        <div class="cardHint"></div>
      `;

      card.onclick = () => onClickTile(state, boardId, i, ref);
      elGrid.appendChild(card);
      continue;
    }

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
              ? `<input class="inlineUrl" placeholder="https://example.com (optional)" value="${escapeHtml(c)}">`
              : `<textarea class="inlineBody" placeholder="Write here... (optional)">${escapeHtml(c)}</textarea>`
          }

          <div class="cardHint">${sizeText}</div>

          <div class="inlineActions">
            <button class="tinyBtn">Cancel</button>
            <button class="tinyBtn primary">Save</button>
          </div>
        `;

        const titleEl = card.querySelector(".inlineTitle");
        const bodyEl  = card.querySelector(kind === "link" ? ".inlineUrl" : ".inlineBody");
        const cancelEl= card.querySelector(".tinyBtn");
        const saveEl  = card.querySelector(".tinyBtn.primary");

        // focus the main input
        setTimeout(() => bodyEl.focus(), 0);

        titleEl.oninput = () => { inlineEdit.title = titleEl.value; };
        bodyEl.oninput  = () => { inlineEdit.content = bodyEl.value; };

        cancelEl.onclick = (e) => {
          e.stopPropagation();
          inlineEdit = null;
          render();
        };

        saveEl.onclick = (e) => {
          e.stopPropagation();

          // Title: trim is fine
          const newTitle = (titleEl.value || "").trim();

          // ✅ NOTE: preserve EXACT content (no trim) to keep blank lines/spaces
          let newContent;
          if (kind === "note") {
            newContent = bodyEl.value ?? "";
          } else {
            // Link: trim for URL correctness (optional)
            newContent = (bodyEl.value || "").trim();
            if (newContent && !/^https?:\/\//i.test(newContent)) {
              newContent = "https://" + newContent;
            }
          }

          it.title = newTitle ? newTitle : null;
          it.content = newContent;

          inlineEdit = null;
          saveState(state);
          render();
        };

        card.onclick = (e) => e.stopPropagation();
      } else {
        const titleText = it?.title ? it.title : "(no title)";

        let bodyHtml = "";
        if (kind === "link") {
          if (it?.content) {
            bodyHtml = `<a target="_blank" href="${escapeHtml(it.content)}" onclick="event.stopPropagation()">${escapeHtml(it.content)}</a>`;
          } else {
            bodyHtml = `<div style="opacity:.6">(empty link)</div>`;
          }
        } else {
          // ✅ scrollable + preserves blank lines/spaces
          bodyHtml = escapeHtml(it?.content || "");
        }

        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
            <div class="badge">${icon}</div>
          </div>
          <div class="cardTitle">${escapeHtml(titleText)}</div>
          <div class="itemBody ${kind === "link" ? "link" : ""}">${bodyHtml}</div>
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

  if (mode === "move") {
    movePick = { slotIndex };
    sizePick = null;
    inlineEdit = null;
    render();
    return;
  }

  if (mode === "size") {
    inlineEdit = null;

    if (ref.type === "item") {
      const it = state.items[ref.id];
      if (it && (it.kind === "note" || it.kind === "link")) {
        if (sizePick && sizePick.anchorIndex === slotIndex) {
          it.w = 1;
          it.h = 1;
          sizePick = null;
          saveState(state);
          render();
          return;
        }
        sizePick = { anchorIndex: slotIndex, itemId: ref.id, destIndex: null };
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

    inlineEdit = {
      itemId: ref.id,
      kind: it.kind,
      title: it.title || "",
      content: it.content || ""
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
