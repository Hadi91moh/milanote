// Data model:
// state = {
//   boards: { [id]: { id, parentId, title, slots: Array(null | {type:'board'|'item', id}) } },
//   items:  { [id]: { id, boardId, kind:'note'|'link', title, content } }
// }
//
// Fixed positions are the slot indices.
// Empty slots are invisible unless Move mode is ON.

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
const modeTrashBtn = document.getElementById("modeTrash");

const btnGridPlus = document.getElementById("btnGridPlus");
const btnGridMinus = document.getElementById("btnGridMinus");
const btnRename = document.getElementById("btnRename");

const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");

let mode = "none";  // none | move | trash
let movePick = null; // { boardId, slotIndex } or null

function uid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
}

function safeParseJSON(raw) { try { return JSON.parse(raw); } catch { return null; } }

function initBoard(title, parentId) {
  const id = uid();
  return {
    id,
    parentId: parentId ?? null,
    title: title || "Untitled",
    slots: Array(DEFAULT_SLOTS).fill(null),
  };
}

function migrateIfNeeded(state) {
  // Old or empty -> create new root
  if (!state || !state.boards || !state.items) {
    const root = initBoard("My Board", null);
    return { boards: { [root.id]: root }, items: {} };
  }

  // Ensure slots exist and have at least DEFAULT_SLOTS
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

  // Remove references from any remaining boards
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

  modeMoveBtn.classList.toggle("on", mode === "move");
  modeTrashBtn.classList.toggle("on", mode === "trash");

  render();
}

modeMoveBtn.onclick = () => setMode(mode === "move" ? "none" : "move");
modeTrashBtn.onclick = () => setMode(mode === "trash" ? "none" : "trash");

// ACTIONS (Board/Note/Link create in next available slot)
actionBoard.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  setMode("none");

  const idx = firstEmptySlot(board);
  if (idx < 0) {
    alert("No empty slots. Increase the grid size (+).");
    return;
  }

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

  const idx = firstEmptySlot(board);
  if (idx < 0) {
    alert("No empty slots. Increase the grid size (+).");
    return;
  }

  openModal({
    kind: "note",
    modeLabel: "new",
    initialTitle: "",
    initialContent: "",
    onSave: ({ title, content }) => {
      const itemId = uid();
      state.items[itemId] = { id: itemId, boardId, kind: "note", title, content };
      board.slots[idx] = { type: "item", id: itemId };
      saveState(state);
      render();
    }
  });
};

actionLink.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  setMode("none");

  const idx = firstEmptySlot(board);
  if (idx < 0) {
    alert("No empty slots. Increase the grid size (+).");
    return;
  }

  openModal({
    kind: "link",
    modeLabel: "new",
    initialTitle: "",
    initialContent: "",
    onSave: ({ title, content }) => {
      const itemId = uid();
      state.items[itemId] = { id: itemId, boardId, kind: "link", title, content };
      board.slots[idx] = { type: "item", id: itemId };
      saveState(state);
      render();
    }
  });
};

// Rename current board
btnRename.onclick = () => {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];
  if (!board) return;

  openModal({
    kind: "board",
    modeLabel: "edit",
    initialTitle: "",
    initialContent: board.title,
    onSave: ({ content }) => {
      board.title = content.trim() || board.title;
      saveState(state);
      render();
    }
  });
};

// Grid controls
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

function render() {
  const state = loadState();
  const boardId = getCurrentBoardId(state);
  const board = state.boards[boardId];

  if (!board) {
    const root = Object.values(state.boards).find(b => b.parentId === null);
    if (root) setCurrentBoard(root.id);
    return;
  }

  elGridInfo.textContent = `Slots: ${board.slots.length}`;

  const crumbs = breadcrumb(state, boardId);
  elCrumbs.innerHTML = crumbs.map((b, i) => {
    if (i === crumbs.length - 1) return `<span>${escapeHtml(b.title)}</span>`;
    return `<a href="#/b/${b.id}">${escapeHtml(b.title)}</a> <span>/</span> `;
  }).join("");

  elGrid.innerHTML = "";

  board.slots.forEach((ref, index) => {
    if (!ref) {
      // Empty slot is invisible unless move mode is ON
      const slot = document.createElement("div");
      slot.className = "slot";

      if (mode === "move") {
        slot.classList.add("moveTarget");
        slot.onclick = () => onClickSlot(state, boardId, index);
      } else {
        slot.onclick = null;
      }

      if (mode === "move" && movePick && movePick.slotIndex === index) {
        slot.classList.add("selected");
      }

      elGrid.appendChild(slot);
      return;
    }

    const card = document.createElement("div");
    card.className = "card";

    if (mode === "trash") card.classList.add("trashPulse");
    if (mode === "move" && movePick && movePick.slotIndex === index) card.classList.add("selected");

    if (ref.type === "board") {
      const b = state.boards[ref.id];
      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">BOARD</div>
          <div class="badge">▦</div>
        </div>
        <div class="cardTitle">${escapeHtml(b?.title || "(missing board)")}</div>
        <div class="cardBody">${mode === "trash" ? "Click to delete" : (mode === "move" ? "Pick / drop" : "Click to open")}</div>
        <div class="cardHint">${mode === "move" ? "Move mode: select then choose destination" : ""}</div>
      `;
      card.onclick = () => onClickSlot(state, boardId, index);
      elGrid.appendChild(card);
      return;
    }

    if (ref.type === "item") {
      const it = state.items[ref.id];
      const kind = it?.kind || "note";
      const icon = kind === "link" ? "🔗" : "📝";

      const body = kind === "link"
        ? `<a target="_blank" href="${escapeHtml(it?.content || "")}" onclick="event.stopPropagation()">${escapeHtml(it?.content || "")}</a>`
        : `<div style="white-space:pre-wrap">${escapeHtml(it?.content || "")}</div>`;

      card.innerHTML = `
        <div class="cardHeader">
          <div class="badge">${escapeHtml(kind.toUpperCase())}</div>
          <div class="badge">${icon}</div>
        </div>
        <div class="cardTitle">${escapeHtml(it?.title || "(no title)")}</div>
        <div class="cardBody">${body}</div>
        <div class="cardHint">${
          mode === "trash" ? "Click to delete" :
          mode === "move"  ? "Pick / drop" :
          "Click to edit"
        }</div>
      `;

      card.onclick = () => onClickSlot(state, boardId, index);
      elGrid.appendChild(card);
      return;
    }
  });
}

function onClickSlot(state, boardId, slotIndex) {
  const board = state.boards[boardId];
  const ref = board.slots[slotIndex];

  // TRASH MODE: delete only if tile exists
  if (mode === "trash") {
    if (!ref) return;

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

  // MOVE MODE: pick source tile, then choose destination slot (empty or swap)
  if (mode === "move") {
    if (!movePick) {
      if (!ref) return; // must pick a tile
      movePick = { boardId, slotIndex };
      render();
      return;
    }

    // drop
    const src = movePick.slotIndex;
    const dst = slotIndex;

    if (src === dst) {
      movePick = null;
      render();
      return;
    }

    const tmp = board.slots[dst];
    board.slots[dst] = board.slots[src];
    board.slots[src] = tmp;

    movePick = null;
    saveState(state);
    render();
    return;
  }

  // NORMAL MODE: clicking tiles does open/edit
  if (!ref) return;

  if (ref.type === "board") {
    setCurrentBoard(ref.id); // ✅ nested boards
    return;
  }

  if (ref.type === "item") {
    const it = state.items[ref.id];
    if (!it) return;

    openModal({
      kind: it.kind,
      modeLabel: "edit",
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

// Routing
window.addEventListener("hashchange", () => {
  movePick = null;
  render();
});

render();
