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

let currentTool = "board";    // board | note | link | move | trash
let movePick = null;          // { boardId, slotIndex } when selected

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

  // remove references from any parent slots
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
    modalHint.textContent = "Save updates the note in this board.";
  } else if (kind === "link") {
    modalTitle.textContent = isEdit ? "Edit Link" : "New Link";
    modalContentLabel.textContent = "URL";
    modalInputContent.placeholder = "https://example.com";
    modalHint.textContent = "If you omit https://, it will be added automatically.";
  } else if (kind === "board") {
    modalTitle.textContent = isEdit ? "Rename Board" : "New Board";
    modalContentLabel.textContent = "Name";
    modalInputContent.placeholder = "Board name";
    modalHint.textContent = "Save updates the board name.";
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

function setTool(tool) {
  currentTool = tool;
  movePick = null; // cancel any move selection when switching tools

  document.querySelectorAll(".toolBtn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-tool") === tool);
  });

  render();
}

document.querySelectorAll(".toolBtn").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.getAttribute("data-tool")));
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
      board.title = content.trim() || board.title;
      saveState(state);
      render();
    }
  });
};

// Grid size controls
document.getElementById("btnGridPlus").onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  if (ensureGridSize(board, board.slots.length + GRID_STEP)) {
    saveState(state);
    render();
  }
};

document.getElementById("btnGridMinus").onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  if (ensureGridSize(board, board.slots.length - GRID_STEP)) {
    saveState(state);
    render();
  }
};

function render() {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];

  if (!board) {
    const root = Object.values(state.boards).find(b => b.parentId === null);
    if (root) setCurrentBoard(root.id);
    return;
  }

  // grid info
  if (elGridInfo) elGridInfo.textContent = `Slots: ${board.slots.length}`;

  // crumbs
  const crumbs = breadcrumb(state, boardId);
  elCrumbs.innerHTML = crumbs.map((b, i) => {
    if (i === crumbs.length - 1) return `<span>${escapeHtml(b.title)}</span>`;
    return `<a href="#/b/${b.id}">${escapeHtml(b.title)}</a> <span>/</span> `;
  }).join("");

  // build grid
  elGrid.innerHTML = "";

  board.slots.forEach((ref, index) => {
    if (!ref) {
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.textContent = `slot ${index + 1}`;

      if (currentTool === "move" && movePick) {
        slot.classList.add("moveTarget");
      }
      if (currentTool === "move" && movePick && movePick.slotIndex === index) {
        slot.classList.add("selected");
      }

      slot.onclick = () => onSlotClick(state, boardId, index);
      elGrid.appendChild(slot);
      return;
    }

    // ref exists -> card
    const card = document.createElement("div");
    card.className = "card";

    if (currentTool === "trash") card.classList.add("trashPulse");
    if (currentTool === "move" && movePick && movePick.slotIndex === index) card.classList.add("selected");

    if (ref.type === "board") {
      const b = state.boards[ref.id];
      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">BOARD</div>
          <div class="badge">▦</div>
        </div>
        <div class="cardTitle">${escapeHtml(b?.title || "(missing board)")}</div>
        <div class="cardBody">${currentTool === "trash" ? "Click to delete" : (currentTool === "move" ? "Click to pick / drop" : "Click to open")}</div>
        <div class="cardHint">${currentTool === "move" ? "Move tool: pick then choose destination" : ""}</div>
      `;
      card.onclick = () => onSlotClick(state, boardId, index);
      elGrid.appendChild(card);
      return;
    }

    if (ref.type === "item") {
      const it = state.items[ref.id];
      const kind = it?.kind || "note";
      const kindLabel = kind.toUpperCase();
      const icon = kind === "link" ? "🔗" : "📝";

      const body = kind === "link"
        ? `<a target="_blank" href="${escapeHtml(it?.content || "")}">${escapeHtml(it?.content || "")}</a>`
        : `<div style="white-space:pre-wrap">${escapeHtml(it?.content || "")}</div>`;

      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">${escapeHtml(kindLabel)}</div>
          <div class="badge">${icon}</div>
        </div>
        <div class="cardTitle">${escapeHtml(it?.title || "(no title)")}</div>
        <div class="cardBody">${body}</div>
        <div class="cardHint">${
          currentTool === "trash" ? "Click to delete" :
          currentTool === "move"  ? "Move tool: pick then choose destination" :
          "Click to edit"
        }</div>
      `;

      // allow normal link open only in non-trash/non-move mode
      card.onclick = (e) => {
        if (kind === "link" && currentTool === "board") return; // link click works
        e.preventDefault();
        onSlotClick(state, boardId, index);
      };

      elGrid.appendChild(card);
      return;
    }
  });
}

function onSlotClick(state, boardId, slotIndex) {
  const board = state.boards[boardId];
  const ref = board.slots[slotIndex];

  // ---- TRASH MODE ----
  if (currentTool === "trash") {
    if (!ref) return;

    if (ref.type === "item") {
      const it = state.items[ref.id];
      const ok = confirm(`Delete this ${it?.kind || "item"}?`);
      if (!ok) return;
      delete state.items[ref.id];
      board.slots[slotIndex] = null;
      saveState(state);
      render();
      return;
    }

    if (ref.type === "board") {
      const b = state.boards[ref.id];
      const ok = confirm(`Delete board "${b?.title || ""}" and everything inside it?`);
      if (!ok) return;
      deleteBoardRecursive(state, ref.id);
      board.slots[slotIndex] = null;
      saveState(state);
      render();
      return;
    }
  }

  // ---- MOVE MODE (grid-based) ----
  if (currentTool === "move") {
    if (!movePick) {
      // pick source
      if (!ref) return; // can't pick empty
      movePick = { boardId, slotIndex };
      render();
      return;
    }

    // drop
    if (movePick.boardId !== boardId) {
      // should never happen in this UI, but safe
      movePick = null;
      render();
      return;
    }

    const src = movePick.slotIndex;
    const dst = slotIndex;

    if (src === dst) {
      movePick = null;
      render();
      return;
    }

    // swap allowed (even if dst occupied)
    const tmp = board.slots[dst];
    board.slots[dst] = board.slots[src];
    board.slots[src] = tmp;

    movePick = null;
    saveState(state);
    render();
    return;
  }

  // ---- NORMAL CREATION TOOLS ----
  if (!ref) {
    const idx = slotIndex;

    if (currentTool === "board") {
      const newBoardId = uid();
      state.boards[newBoardId] = { id: newBoardId, parentId: boardId, title: "New Board", slots: Array(DEFAULT_SLOTS).fill(null) };
      board.slots[idx] = { type: "board", id: newBoardId };
      saveState(state);
      render();
      return;
    }

    if (currentTool === "note" || currentTool === "link") {
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
  }

  // ---- CLICK ON EXISTING TILE (edit/open) ----
  if (ref && ref.type === "board") {
    // open board
    setCurrentBoard(ref.id);
    return;
  }

  if (ref && ref.type === "item") {
    const it = state.items[ref.id];
    if (!it) return;

    // edit note/link in modal
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

// ----- Export / Import -----
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
    movePick = null;
    setTool("board");
    render();
  } catch {
    alert("Import failed: invalid JSON.");
  } finally {
    e.target.value = "";
  }
});

// Routing
window.addEventListener("hashchange", () => {
  movePick = null;
  render();
});
render();
