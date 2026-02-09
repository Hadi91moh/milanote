const STORAGE_KEY = "boards_state_v10";

const DEFAULT_SLOTS = 80;
const GRID_STEP = 20;
const GRID_MIN = 20;
const GRID_MAX = 400;

// Defaults per kind
const DEFAULT_NOTE_W = 2;
const DEFAULT_NOTE_H = 2;

const DEFAULT_LINK_W = 3;
const DEFAULT_LINK_H = 1;

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

// hide/remove rename button if present
const btnRename = document.getElementById("btnRename");
if (btnRename) btnRename.style.display = "none";

const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");

let mode = "none";        // none | move | size | trash
let movePick = null;      // { slotIndex } or null
let sizePick = null;      // { anchorIndex, itemId } or null

// inline editor state
// item: { type:"item", itemId, draft }
// boardTitle: { type:"boardTitle", boardId, draftTitle }
let inlineEdit = null;

function uid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
}

function safeParseJSON(raw) { try { return JSON.parse(raw); } catch { return null; } }

function defaultSizeForKind(kind) {
  if (kind === "link") return { w: DEFAULT_LINK_W, h: DEFAULT_LINK_H };
  return { w: DEFAULT_NOTE_W, h: DEFAULT_NOTE_H };
}

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
    if (typeof b.title !== "string") b.title = "Untitled";
  }

  for (const it of Object.values(state.items)) {
    if (typeof it.content !== "string") it.content = "";
    if (typeof it.w !== "number") it.w = 1;
    if (typeof it.h !== "number") it.h = 1;
    it.w = Math.max(1, it.w);
    it.h = Math.max(1, it.h);
    if (typeof it.kind !== "string") it.kind = "note";
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

/* ---------- Modal for Create Board (ONLY Title input) ---------- */
function openCreateBoardTitleModal({ initialTitle, onOk }) {
  overlay.classList.remove("hidden");

  modalTitle.textContent = "Create Board";
  modalHint.textContent = "";
  modalContentLabel.style.display = "none";
  modalInputContent.style.display = "none";

  modalInputTitle.style.display = "";
  modalInputTitle.value = initialTitle || "New Board";
  modalInputTitle.placeholder = "Board title";

  const close = () => {
    overlay.classList.add("hidden");
    modalSave.onclick = null;
    document.onkeydown = null;
    overlay.onclick = null;

    // restore defaults (in case other modals exist later)
    modalContentLabel.style.display = "";
    modalInputContent.style.display = "";
    modalInputTitle.style.display = "";
  };

  modalSave.onclick = () => {
    const title = modalInputTitle.value.trim();
    if (!title) return;
    onOk(title);
    close();
  };

  modalCancel.onclick = close;
  modalClose.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.onkeydown = (e) => { if (e.key === "Escape") close(); };

  setTimeout(() => modalInputTitle.focus(), 0);
}

/* ---------- Mode ---------- */
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

  openCreateBoardTitleModal({
    initialTitle: "New Board",
    onOk: (title) => {
      const newBoard = initBoard(title, boardId);
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
  const d = defaultSizeForKind("note");
  state.items[itemId] = { id: itemId, boardId, kind: "note", content: "", w: d.w, h: d.h };
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
  const d = defaultSizeForKind("link");
  state.items[itemId] = { id: itemId, boardId, kind: "link", content: "", w: d.w, h: d.h };
  board.slots[idx] = { type: "item", id: itemId };

  saveState(state);
  render();
};

/* ---------- Content helpers ---------- */

function commitInlineEdit(state) {
  if (!inlineEdit) return false;

  if (inlineEdit.type === "item") {
    const it = state.items[inlineEdit.itemId];
    if (!it) return false;
    it.content = inlineEdit.draft ?? "";
    return true;
  }

  if (inlineEdit.type === "boardTitle") {
    const b = state.boards[inlineEdit.boardId];
    if (!b) return false;
    const t = (inlineEdit.draftTitle ?? "").trim();
    if (!t) return false;
    b.title = t;
    return true;
  }

  return false;
}

// multi-line links: each non-empty line clickable, blank lines preserved
function linkHtmlFromContent(raw) {
  const s = raw ?? "";
  const lines = s.split("\n");
  let out = "";
  for (const line of lines) {
    if (line.trim() === "") { out += "<br>"; continue; }
    const hrefLine = line.trim();
    const href = /^https?:\/\//i.test(hrefLine) ? hrefLine : `https://${hrefLine}`;
    out += `<a target="_blank" href="${escapeHtml(href)}" onclick="event.stopPropagation()">${escapeHtml(line)}</a><br>`;
  }
  return out || `<div style="opacity:.6">(empty link)</div>`;
}

/* ---------- Resize safety ---------- */

function trySetItemSize(state, boardId, anchorIndex, newW, newH) {
  const board = state.boards[boardId];
  const ref = board?.slots?.[anchorIndex];
  if (!board || !ref || ref.type !== "item") return false;

  const it = state.items[ref.id];
  if (!it) return false;

  const cols = getCols();
  const occ = buildOccupancy(board, state, cols);

  const cells = rectCellsFromAnchor(anchorIndex, newW, newH, cols, board.slots.length);
  if (cells.length === 0) return false;

  for (const cell of cells) {
    const anchorAtCell = occ.get(cell);
    if (anchorAtCell !== undefined && anchorAtCell !== anchorIndex) return false;
  }

  it.w = newW;
  it.h = newH;
  return true;
}

/* ---------- Render ---------- */

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

  // slot overlays
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

  // tiles
  for (let i = 0; i < board.slots.length; i++) {
    const ref = board.slots[i];
    if (!ref) continue;

    const card = document.createElement("div");
    card.className = "card";

    if (mode === "trash") card.classList.add("trashPulse");
    if (mode === "move" && movePick && movePick.slotIndex === i) card.classList.add("selected");
    if (mode === "size" && sizePick && sizePick.anchorIndex === i) card.classList.add("selected");

    // BOARD TILE:
    // - green title area renames
    // - ANY other area opens (blue+red both open)
    if (ref.type === "board") {
      const b = state.boards[ref.id];
      placeGrid(card, i, cols, 1, 1);

      const editing = inlineEdit && inlineEdit.type === "boardTitle" && inlineEdit.boardId === ref.id;

      if (editing) {
        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">BOARD</div>
            <div class="badge">▦</div>
          </div>

          <textarea class="inlineBody" placeholder="Board title">${escapeHtml(inlineEdit.draftTitle ?? "")}</textarea>

          <div class="inlineActions">
            <button class="tinyBtn">Cancel</button>
            <button class="tinyBtn primary">Save</button>
          </div>
        `;

        const bodyEl = card.querySelector(".inlineBody");
        const cancelEl = card.querySelector(".tinyBtn");
        const saveEl = card.querySelector(".tinyBtn.primary");

        bodyEl.style.minHeight = "60px";
        bodyEl.style.flex = "1 1 auto";

        bodyEl.oninput = () => { inlineEdit.draftTitle = bodyEl.value; };
        bodyEl.onpointerdown = (e) => e.stopPropagation();
        setTimeout(() => bodyEl.focus(), 0);

        cancelEl.onclick = (e) => { e.stopPropagation(); inlineEdit = null; render(); };
        saveEl.onclick = (e) => {
          e.stopPropagation();
          if (commitInlineEdit(state)) saveState(state);
          inlineEdit = null;
          render();
        };

        card.onclick = (e) => e.stopPropagation();
      } else {
        card.innerHTML = `
          <div class="cardHeader" style="padding-bottom:6px;">
            <div class="badge">BOARD</div>
            <div class="badge">▦</div>
          </div>

          <div class="cardTitle boardTitleBar" style="padding:6px 2px; border-top:1px solid var(--border); border-radius:12px;">
            ${escapeHtml(b?.title || "Board")}
          </div>

          <div class="boardOpenArea" style="margin-top:8px; height:48px; border-top:1px solid var(--border); border-radius:14px; background:#ffffff; opacity:.25;">
          </div>

          <div class="cardHint" style="padding-top:6px;">• Tap to open</div>
        `;

        const titleBar = card.querySelector(".boardTitleBar");

        // green title => rename
        titleBar.onclick = (e) => {
          e.stopPropagation();
          if (mode !== "none") return;
          inlineEdit = { type: "boardTitle", boardId: ref.id, draftTitle: b?.title || "" };
          render();
        };

        // ✅ whole card (except title) opens
        card.onclick = () => {
          if (mode === "trash") return onClickTile(state, boardId, i, ref);
          if (mode !== "none") return;
          setCurrentBoard(ref.id);
        };
      }

      elGrid.appendChild(card);
      continue;
    }

    // ITEM TILE
    if (ref.type === "item") {
      const it = state.items[ref.id];
      const kind = it?.kind || "note";
      const icon = kind === "link" ? "🔗" : "📝";

      const spanW = Math.max(1, it?.w || 1);
      const spanH = Math.max(1, it?.h || 1);
      placeGrid(card, i, cols, spanW, spanH);

      const sizeText = `Size: ${spanW}×${spanH}`;
      const editing = inlineEdit && inlineEdit.type === "item" && inlineEdit.itemId === ref.id;

      if (editing) {
        const draft = inlineEdit.draft ?? "";

        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
            <div class="badge">${icon}</div>
          </div>

          <textarea class="inlineBody" placeholder="${
            kind === "link" ? "Paste one link per line (optional)" : "Write here (optional)"
          }">${escapeHtml(draft)}</textarea>

          <div class="cardHint">${sizeText}</div>

          <div class="inlineActions">
            <button class="tinyBtn">Cancel</button>
            <button class="tinyBtn primary">Save</button>
          </div>
        `;

        const bodyEl = card.querySelector(".inlineBody");
        const cancelEl = card.querySelector(".tinyBtn");
        const saveEl = card.querySelector(".tinyBtn.primary");

        bodyEl.oninput = () => { inlineEdit.draft = bodyEl.value; };
        bodyEl.onpointerdown = (e) => e.stopPropagation();
        setTimeout(() => bodyEl.focus(), 0);

        cancelEl.onclick = (e) => { e.stopPropagation(); inlineEdit = null; render(); };
        saveEl.onclick = (e) => {
          e.stopPropagation();
          if (commitInlineEdit(state)) saveState(state);
          inlineEdit = null;
          render();
        };

        card.onclick = (e) => e.stopPropagation();

      } else {
        const raw = it?.content || "";
        const bodyHtml = (kind === "link") ? linkHtmlFromContent(raw) : escapeHtml(raw);

        card.innerHTML = `
          <div class="cardHeader">
            <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
            <div class="badge">${icon}</div>
          </div>
          <div class="itemBody ${kind === "link" ? "link" : ""}">${bodyHtml}</div>
          <div class="cardHint">${
            mode === "trash" ? "Click to delete" :
            mode === "move"  ? "Move: pick then click empty slot" :
            mode === "size"  ? `Size: click empty slot to expand • click tile again to toggle 1×1/default • ${sizeText}` :
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

/* ---------- Click handlers ---------- */

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

    if (trySetItemSize(state, boardId, anchorIndex, newW, newH)) {
      saveState(state);
      render();
    }
    return;
  }
}

function onClickTile(state, boardId, slotIndex, ref) {
  const board = state.boards[boardId];

  // If editing something else, save it first (best effort)
  if (inlineEdit) {
    const sameBoardTitle = (inlineEdit.type === "boardTitle" && ref.type === "board" && inlineEdit.boardId === ref.id);
    const sameItem = (inlineEdit.type === "item" && ref.type === "item" && inlineEdit.itemId === ref.id);
    if (!sameBoardTitle && !sameItem) {
      commitInlineEdit(state);
      saveState(state);
      inlineEdit = null;
    }
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

      if (sizePick && sizePick.anchorIndex === slotIndex) {
        const def = defaultSizeForKind(it.kind);
        const wantOne = !(it.w === 1 && it.h === 1);
        const nextW = wantOne ? 1 : def.w;
        const nextH = wantOne ? 1 : def.h;

        if (trySetItemSize(state, boardId, slotIndex, nextW, nextH)) {
          saveState(state);
          render();
        }
        return;
      }

      sizePick = { anchorIndex: slotIndex, itemId: ref.id };
      render();
      return;
    }

    return;
  }

  // NORMAL MODE
  if (ref.type === "item") {
    const it = state.items[ref.id];
    if (!it) return;
    inlineEdit = { type: "item", itemId: ref.id, draft: it.content || "" };
    render();
    return;
  }
}

/* ---------- Top bar + routing ---------- */

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

window.addEventListener("hashchange", () => {
  movePick = null;
  sizePick = null;
  inlineEdit = null;
  render();
});

/* ---------- Export / Import ---------- */

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
