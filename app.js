const app = document.getElementById("app");

const STORAGE_KEY = "boards_state_v1";

function uid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);

  // initial state
  const rootId = uid();
  const state = {
    boards: { [rootId]: { id: rootId, parentId: null, title: "My Board" } },
    items: {}
  };
  saveState(state);
  return state;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function childrenOf(state, boardId) {
  return Object.values(state.boards).filter(b => b.parentId === boardId);
}

function itemsOf(state, boardId) {
  return Object.values(state.items).filter(it => it.boardId === boardId);
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

function render() {
  const state = loadState();
  const hash = location.hash || "#/";

  if (hash.startsWith("#/b/")) {
    const boardId = hash.slice("#/b/".length);
    if (!state.boards[boardId]) {
      location.hash = "#/";
      return;
    }
    renderBoard(state, boardId);
    return;
  }

  renderHome(state);
}

function renderHome(state) {
  const roots = Object.values(state.boards).filter(b => b.parentId === null);

  app.innerHTML = `
    <div class="card">
      <h2>Root boards</h2>
      <form id="newRootForm" class="row">
        <input name="title" placeholder="New board title" required />
        <button type="submit">Create</button>
      </form>
      <div class="small">Tip: use Export/Import to move your data between phone and laptop.</div>
    </div>

    ${roots.map(b => `
      <div class="card">
        <a href="#/b/${b.id}"><strong>${escapeHtml(b.title)}</strong></a>
        <div class="small">Board</div>
      </div>
    `).join("")}
  `;

  document.getElementById("newRootForm").onsubmit = (e) => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    const id = uid();
    state.boards[id] = { id, parentId: null, title };
    saveState(state);
    location.hash = `#/b/${id}`;
  };
}

function renderBoard(state, boardId) {
  const b = state.boards[boardId];
  const crumbs = breadcrumb(state, boardId);
  const sub = childrenOf(state, boardId).sort((a, z) => a.title.localeCompare(z.title));
  const items = itemsOf(state, boardId);

  app.innerHTML = `
    <div class="card">
      <div class="small">
        ${crumbs.map((c, i) =>
          i === crumbs.length - 1
            ? `<span>${escapeHtml(c.title)}</span>`
            : `<a href="#/b/${c.id}">${escapeHtml(c.title)}</a> / `
        ).join("")}
      </div>
      <h2>${escapeHtml(b.title)}</h2>
    </div>

    <div class="row">
      <section class="col">
        <div class="card">
          <h3>Sub-boards</h3>
          <form id="newSubForm" class="row">
            <input name="title" placeholder="Sub-board title" required />
            <button type="submit">Create</button>
          </form>
        </div>

        ${sub.length ? sub.map(sb => `
          <div class="card">
            <a href="#/b/${sb.id}"><strong>${escapeHtml(sb.title)}</strong></a>
          </div>
        `).join("") : `<div class="card small">No sub-boards yet.</div>`}
      </section>

      <section class="col">
        <div class="card">
          <h3>Notes & links</h3>
          <form id="newItemForm">
            <select name="kind">
              <option value="note">Note</option>
              <option value="link">Link</option>
            </select>
            <input name="title" placeholder="Optional title" />
            <textarea name="content" rows="4" placeholder="Note text or URL" required></textarea>
            <button type="submit">Add</button>
          </form>
        </div>

        ${items.length ? items.map(it => `
          <div class="card">
            <div class="small">${it.kind.toUpperCase()}</div>
            <div><strong>${escapeHtml(it.title || "(no title)")}</strong></div>
            ${
              it.kind === "link"
                ? `<div><a target="_blank" href="${escapeHtml(it.content)}">${escapeHtml(it.content)}</a></div>`
                : `<div style="white-space: pre-wrap;">${escapeHtml(it.content)}</div>`
            }
            <button type="button" data-del="${it.id}">Delete</button>
          </div>
        `).join("") : `<div class="card small">No items yet.</div>`}
      </section>
    </div>
  `;

  document.getElementById("newSubForm").onsubmit = (e) => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    const id = uid();
    state.boards[id] = { id, parentId: boardId, title };
    saveState(state);
    location.hash = `#/b/${id}`;
  };

  document.getElementById("newItemForm").onsubmit = (e) => {
    e.preventDefault();
    const kind = e.target.kind.value;
    const title = e.target.title.value.trim();
    const content = e.target.content.value.trim();
    if (!content) return;

    const id = uid();
    state.items[id] = { id, boardId, kind, title: title || null, content };
    saveState(state);
    render();
  };

  app.querySelectorAll("button[data-del]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-del");
      delete state.items[id];
      saveState(state);
      render();
    };
  });
}

window.addEventListener("hashchange", render);
render();

/* -------- Export / Import (backup + move between devices) -------- */
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
    const parsed = JSON.parse(text); // validate JSON
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    location.hash = "#/";
    render();
  } catch {
    alert("Import failed: invalid JSON file.");
  } finally {
    e.target.value = "";
  }
});
