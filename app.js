// Boards PWA (grid-based)
// - Nested boards
// - Fixed grid slots per board
// - Create Board/Note/Link into next empty slot
// - Edit Note/Link on click
// - Move tool: pick tile then choose target slot (empty or swap)
// - Trash tool: delete note/link/board (board deletes recursively)
// - Grid size per board (+/-), safe shrink only if tail is empty

const STORAGE_KEY = "boards_state_v3";
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

let currentTool = "board"; // board | note | link | move | trash
let movePick = null;       // { boardId, slotIndex } when moving

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

function deleteBoardRecursive(state, boardId) {
  const board = state.boards[boardId];
  if (!board) return;

  for (const ref of board.slots) {
    if (!ref) continue;
    if (ref.type === "board") deleteBoardRecursive(state, ref.id);
    if (ref.type === "item") delete state.items[ref.id];
  }

  delete state.boards[boardId];

  // Remove references from any remaining parent slots
  for (const b of Object.values(state.boards)) {
    b.slots = b.slots.map(ref => (ref && ref.type === "board" && ref.id === boardId) ? null : ref);
  }
}

function openModal({ kind, mode, initialTitle, initialContent, onSave }) {
  overlay.classList.remove("hidden");
  modalInputTitle.value = initialTitle || "";
  modalInputContent.value = initialContent || "";

  const isEdit = mode === "edit";

  if (kind === "note") {
    modalTitle.textContent = isEdit ? "Edit Note" : "New Note";
    modalContentLabel.textContent = "Note";
    modalInputContent.placeholder = "Write your note…";
    modalHint.textContent = "Save updates this note.";
  } else if (kind === "link") {
    modalTitle.textContent = isEdit ? "Edit Link" : "New Link";
    modalContentLabel.textContent = "URL";
    modalInputContent.placeholder = "https://example.com";
    modalHint.textContent = "If you omit https:// it will be added.";
  } else if (kind === "board") {
    modalTitle.textContent = isEdit ? "Rename Board" : "New Board";
    modalContentLabel.textContent = "Name";
    modalInputContent.placeholder = "Board name";
    modalHint.textContent = "";
  } else {
    modalTitle.textContent = isEdit ? "Edit" : "New";
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
    if (!content && kind !== "board") return;

    if (kind === "link" && content && !/^https?:\/\//i.test(content)) {
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

function ensureGridSize(board, newSize) {
  const target = Math.max(GRID_MIN, Math.min(GRID_MAX, newSize));

  if (target < board.slots.length) {
    const tail = board.slots.slice(target);
    if (tail.some(x => x !== null)) {
      alert("Cannot shrink: there are tiles in the slots that would be removed. Move them first.");
      return false;
    }
    board.slots = board.slots.slice(0, target);
    return true;
  }

  if (target > board.slots.length) {
    board.slots = board.slots.concat(Array(target - board.slots.length).fill(null));
  }

  return true;
}

function clearMovePick() {
  movePick = null;
}

function setTool(tool) {
  currentTool = tool;
  clearMovePick();
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

  // top info
  if (elGridInfo) elGridInfo.textContent = `Grid: ${board.slots.length}`;

  // breadcrumbs
  const crumbs = breadcrumb(state, boardId);
  elCrumbs.innerHTML = crumbs.map((b, i) => {
    if (i === crumbs.length - 1) return `<span>${escapeHtml(b.title)}</span>`;
    return `<a href="#/b/${b.id}">${escapeHtml(b.title)}</a> <span>/</span> `;
  }).join("");

  // grid
  elGrid.innerHTML = "";

  board.slots.forEach((ref, index) => {
    if (!ref) {
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.textContent = `slot ${index + 1}`;

      // Move tool: click empty slot to move selected tile here
      if (currentTool === "move" && movePick) slot.classList.add("moveTarget");

      slot.onclick = () => handleSlotClick(state, boardId, index);
      elGrid.appendChild(slot);
      return;
    }

    const card = document.createElement("div");
    card.className = "card";

    const selected = (currentTool === "move" && movePick && movePick.slotIndex === index && movePick.boardId === boardId);
    if (selected) card.classList.add("selected");
    if (currentTool === "trash") card.classList.add("trashPulse");

    if (ref.type === "board") {
      const b = state.boards[ref.id];
      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">BOARD</div>
          <div class="badge">▦</div>
        </div>
        <div class="cardTitle">${escapeHtml(b?.title || "(missing board)")}</div>
        <div class="cardBody">${currentTool === "trash" ? "Click to delete (recursive)" : "Click to open"}</div>
        <div class="cardHint">${currentTool === "move" ? "Click to select / swap" : ""}</div>
      `;
      card.onclick = (e) => { e.preventDefault(); handleSlotClick(state, boardId, index); };
      elGrid.appendChild(card);
      return;
    }

    if (ref.type === "item") {
      const it = state.items[ref.id];
      const kind = it?.kind || "note";

      const body = (kind === "link")
        ? `<a target="_blank" href="${escapeHtml(it?.content || "")}">${escapeHtml(it?.content || "")}</a>`
        : `<div style="white-space:pre-wrap">${escapeHtml(it?.content || "")}</div>`;

      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">${kind.toUpperCase()}</div>
          <div class="badge">${kind === "link" ? "🔗" : "📝"}</div>
        </div>
        <div class="cardTitle">${escapeHtml(it?.title || "(no title)")}</div>
        <div class="cardBody">${body}</div>
        <div class="cardHint">${
          currentTool === "trash" ? "Click to delete"
          : currentTool === "move" ? "Click to select / swap"
          : "Click to edit"
        }</div>
      `;

      card.onclick = (e) => {
        // allow link open only in normal mode; in other modes we intercept
        if (currentTool === "board" || currentTool === "note" || currentTool === "link") {
          e.preventDefault();
        }
        handleSlotClick(state, boardId, index);
      };

      elGrid.appendChild(card);
      return;
    }
  });
}

function handleSlotClick(state, boardId, slotIndex) {
  const board = state.boards[boardId];
  const ref = board.slots[slotIndex];

  // --- Trash mode: click occupied to delete ---
  if (currentTool === "trash") {
    if (!ref) return;

    if (ref.type === "item") {
      delete state.items[ref.id];
      board.slots[slotIndex] = null;
      saveState(state);
      render();
      return;
    }

    if (ref.type === "board") {
      // delete recursively
      deleteBoardRecursive(state, ref.id);
      // also clear this slot if it still exists
      if (state.boards[boardId]) state.boards[boardId].slots[slotIndex] = null;
      saveState(state);

      // if current board was deleted (rare), go home
      if (!state.boards[boardId]) {
        const root = Object.values(state.boards).find(b => b.parentId === null);
        if (root) setCurrentBoard(root.id);
      } else {
        render();
      }
      return;
    }
  }

  // --- Move mode ---
  if (currentTool === "move") {
    if (!movePick) {
      // pick a tile
      if (!ref) return;
      movePick = { boardId, slotIndex };
      render();
      return;
    }

    // second click: move/swap into this slot
    const from = movePick.slotIndex;
    const to = slotIndex;

    if (from === to) {
      clearMovePick();
      render();
      return;
    }

    const fromRef = board.slots[from];
    const toRef = board.slots[to];

    // swap (works for empty too)
    board.slots[to] = fromRef;
    board.slots[from] = toRef;

    clearMovePick();
    saveState(state);
    render();
    return;
  }

  // --- Creation tools: click empty slot creates into next empty slot (NOT this slot) ---
  // Your requirement: fixed positions filled sequentially.
  if (currentTool === "board") {
    const idx = firstEmptySlot(board);
    if (idx < 0) return alert("No empty slots left in this board.");
    const newBoard = initBoard("New Board", boardId);
    state.boards[newBoard.id] = newBoard;
    board.slots[idx] = { type: "board", id: newBoard.id };
    saveState(state);
    render();
    return;
  }

  if (currentTool === "note" || currentTool === "link") {
    const idx = firstEmptySlot(board);
    if (idx < 0) return alert("No empty slots left in this board.");

    openModal({
      kind: currentTool,
      mode: "new",
      initialTitle: "",
      initialContent: "",
      onSave: ({ title, content }) => {
        const itemId = uid();
        state.items[itemId] = { id: itemId, boardId, kind: currentTool, title, content };
        board.slots[idx] = { type: "item", id: itemId };
        saveState(state);
        render();
      }
    });
    return;
  }

  // --- Normal interaction (no special tool): open board or edit item ---
  // We treat "no special tool" as: click board -> open, click item -> edit.
  // But since you always have a tool selected, we implement this behavior when tool is board/note/link too:
  if (!ref) return;

  if (ref.type === "board") {
    setCurrentBoard(ref.id);
    return;
  }

  if (ref.type === "item") {
    const it = state.items[ref.id];
    if (!it) return;

    openModal({
      kind: it.kind,
      mode: "edit",
      initialTitle: it.title || "",
      initialContent: it.content || "",
      onSave: ({ title, content }) => {
        it.title = title;
        it.content = content;
        saveState(state);
        render();
      }
    });
    return;
  }
}

// ---- Sidebar tool selection ----
document.querySelectorAll(".toolBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".toolBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    setTool(btn.getAttribute("data-tool"));
  });
});

// Rename current board
document.getElementById("btnRename").onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  openModal({
    kind: "board",
    mode: "edit",
    initialTitle: "",
    initialContent: board.title,
    onSave: ({ content }) => {
      const t = (content || "").trim();
      if (!t) return;
      board.title = t;
      saveState(state);
      render();
    }
  });
};

// Grid +/- controls
document.getElementById("btnGridPlus").onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;
  ensureGridSize(board, board.slots.length + GRID_STEP);
  saveState(state);
  render();
};

document.getElementById("btnGridMinus").onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;
  const ok = ensureGridSize(board, board.slots.length - GRID_STEP);
  if (!ok) return;
  saveState(state);
  render();
};

// Export / Import
document.getElementById("exportBtn").onclick = () => {
  const data = localStorage.getItem(STORAGE_KEY) || "{}";
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "boards-backup.json";
  a.click();
  URL.revokeObjectURL(url);
};

document.getElementById("importInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const migrated = migrateIfNeeded(parsed);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    location.hash = "#/";
    render();
  } catch {
    alert("Import failed: invalid JSON.");
  } finally {
    e.target.value = "";
  }
});

// Routing
window.addEventListener("hashchange", () => {
  clearMovePick();
  render();
});

render();
