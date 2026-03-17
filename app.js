const fileInput = document.getElementById("fileInput");
const errorEl = document.getElementById("error");
const statsEl = document.getElementById("stats");
const tasksBody = document.getElementById("tasksBody");
const downloadBtn = document.getElementById("downloadCsv");
const mappingCard = document.getElementById("mappingCard");
const mappingRowsEl = document.getElementById("mappingRows");

let currentTasks = [];
let currentBaseName = "tasks";
let assigneeMap = {};

fileInput.addEventListener("change", handleFileChange);
downloadBtn.addEventListener("click", () => {
  if (!currentTasks.length) return;
  const csv = tasksToCsv(currentTasks);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentBaseName.replace(/\.[^.]+$/, "") || "tasks"}-preview.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

function handleFileChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      errorEl.style.display = "none";
      const htmlText = String(reader.result || "");
      const tasks = parseTasksFromHtml(htmlText);
      currentTasks = tasks;
      currentBaseName = file.name || "tasks.html";
      assigneeMap = buildInitialAssigneeMap(tasks);
      renderTasks(tasks);
      renderStats(tasks, file.name);
      renderMapping();
      updateDownloadState();
    } catch (e) {
      console.error(e);
      errorEl.textContent = "Failed to parse file. Check console for details.";
      errorEl.style.display = "block";
      statsEl.style.display = "none";
      currentTasks = [];
      renderTasks([]);
      assigneeMap = {};
      renderMapping();
      updateDownloadState();
    }
  };
  reader.onerror = () => {
    errorEl.textContent = "Unable to read file.";
    errorEl.style.display = "block";
    currentTasks = [];
    assigneeMap = {};
    renderMapping();
    updateDownloadState();
  };
  reader.readAsText(file);
}

// --- Parsing logic (JS version of your Python script) ---

function renderInline(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || "";
  }
  if (!node.tagName) {
    return "";
  }
  let text = "";
  for (const child of node.childNodes) {
    text += renderInline(child);
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "b" || tag === "strong") {
    return "*" + text + "*";
  }
  return text;
}

function parseList(listEl, level = 1, ordered = false) {
  const prefix = ordered ? "#".repeat(level) : "*".repeat(level);
  const lines = [];
  const items = Array.from(listEl.children).filter(
    (c) => c.tagName && c.tagName.toLowerCase() === "li",
  );
  for (const li of items) {
    const text = renderInline(li).trim();
    if (text) {
      lines.push(prefix + " " + text);
    }
    // nested lists
    const nested = Array.from(li.children).filter((c) => {
      const t = c.tagName && c.tagName.toLowerCase();
      return t === "ul" || t === "ol";
    });
    for (const child of nested) {
      const isOrdered = child.tagName.toLowerCase() === "ol";
      lines.push(...parseList(child, level + 1, isOrdered));
    }
  }
  return lines;
}

function parseDescription(cell) {
  const parts = [];
  for (const child of cell.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (tag === "p") {
        const text = renderInline(child).trim();
        if (text) parts.push(text);
      } else if (tag === "ol") {
        parts.push(...parseList(child, 1, true));
      } else if (tag === "ul") {
        parts.push(...parseList(child, 1, false));
      }
    } else if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.nodeValue || "").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function parseTasksFromHtml(htmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  const tasks = [];

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) continue;

    // find header row containing "expert", "task description", "est. hours"
    let headerIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll("td,th"));
      const text = cells
        .map((c) => (c.textContent || "").trim().toLowerCase())
        .join(" ");
      if (
        text.includes("expert") &&
        text.includes("task description") &&
        text.includes("est. hours")
      ) {
        headerIndex = i;
        break;
      }
    }
    if (headerIndex === -1) continue;

    let currentSection = null;

    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      const cols = Array.from(row.querySelectorAll("td"));
      if (cols.length < 2) continue;

      const firstText = (cols[0].textContent || "").trim();
      const midText = (cols[1].textContent || "").trim();
      const lastTexts = cols.slice(2).map((c) => (c.textContent || "").trim());

      // section header row: only middle cell filled
      if (midText && !firstText && lastTexts.every((t) => !t)) {
        currentSection = midText;
        continue;
      }

      if (cols.length < 4) continue;

      const expert = firstText;
      const descriptionCell = cols[1];
      const time = (cols[2].textContent || "").trim();
      const qa = (cols[3].textContent || "").trim();

      // require Expert, Description, Time (QA may be empty)
      if (!expert || !(descriptionCell.textContent || "").trim() || !time) {
        continue;
      }

      const fullDesc = parseDescription(descriptionCell);
      const lines = fullDesc
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) continue;

      let summary = lines[0];
      if (currentSection) {
        summary = currentSection + ". " + summary;
      }
      const description = lines.slice(1).join("\n");

      tasks.push({
        summary: summary.trim(),
        description,
        originalEstimate: time,
        qaEstimate: qa,
        assignee: expert,
      });
    }
  }
  return tasks;
}

// --- Rendering ---

function renderTasks(tasks) {
  tasksBody.innerHTML = "";
  if (!tasks.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.style.padding = "14px";
    td.style.textAlign = "center";
    td.style.color = "var(--text-muted)";
    td.textContent = "No tasks found in this file.";
    tr.appendChild(td);
    tasksBody.appendChild(tr);
    return;
  }

  tasks.forEach((task, index) => {
    const tr = document.createElement("tr");

    const idxTd = document.createElement("td");
    idxTd.className = "small";
    idxTd.textContent = index + 1;
    tr.appendChild(idxTd);

    const summaryTd = document.createElement("td");
    summaryTd.className = "summary";
    summaryTd.textContent = task.summary;
    tr.appendChild(summaryTd);

    const descTd = document.createElement("td");
    descTd.className = "description";
    descTd.textContent = task.description;
    tr.appendChild(descTd);

    const origTd = document.createElement("td");
    origTd.className = "small";
    origTd.textContent = task.originalEstimate || "";
    tr.appendChild(origTd);

    const qaTd = document.createElement("td");
    qaTd.className = "small";
    qaTd.textContent = task.qaEstimate || "";
    tr.appendChild(qaTd);

    const assigneeTd = document.createElement("td");
    assigneeTd.className = "small";
    assigneeTd.textContent = task.assignee || "";
    tr.appendChild(assigneeTd);

    tasksBody.appendChild(tr);
  });
}

function renderStats(tasks, filename) {
  statsEl.innerHTML = "";
  statsEl.style.display = "flex";

  const fileSpan = document.createElement("div");
  fileSpan.className = "stat-pill";
  fileSpan.innerHTML = `<strong>File</strong> ${filename}`;
  statsEl.appendChild(fileSpan);

  const countSpan = document.createElement("div");
  countSpan.className = "stat-pill";
  countSpan.innerHTML = `<strong>Tasks</strong> ${tasks.length}`;
  statsEl.appendChild(countSpan);
}

function buildInitialAssigneeMap(tasks) {
  const map = {};
  for (const t of tasks) {
    const key = (t.assignee || "").trim();
    if (!key) continue;
    if (!(key in map)) {
      map[key] = key; // default mapping: identity
    }
  }
  return map;
}

function renderMapping() {
  mappingRowsEl.innerHTML = "";
  const entries = Object.entries(assigneeMap);
  if (!entries.length) {
    mappingCard.style.display = "none";
    return;
  }
  mappingCard.style.display = "block";

  for (const [code, value] of entries) {
    const row = document.createElement("div");
    row.className = "mapping-row";

    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    row.appendChild(codeEl);

    const arrow = document.createElement("span");
    arrow.textContent = "→";
    row.appendChild(arrow);

    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = "Assignee value for CSV";
    input.addEventListener("input", () => {
      assigneeMap[code] = input.value;
    });
    row.appendChild(input);

    mappingRowsEl.appendChild(row);
  }
}

function updateDownloadState() {
  if (currentTasks.length) {
    downloadBtn.style.opacity = "1";
    downloadBtn.style.cursor = "pointer";
  } else {
    downloadBtn.style.opacity = "0.7";
    downloadBtn.style.cursor = "not-allowed";
  }
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function tasksToCsv(tasks) {
  const headers = [
    "Summary",
    "Description",
    "Issue Type",
    "Original Estimate",
    "QA Estimate",
    "Assignee",
  ];
  const lines = [];
  lines.push(headers.join(","));
  for (const t of tasks) {
    const rawAssignee = (t.assignee || "").trim();
    const mappedAssignee =
      (rawAssignee && assigneeMap[rawAssignee]) || rawAssignee;
    const row = [
      escapeCsvCell(t.summary),
      escapeCsvCell(t.description),
      escapeCsvCell("Task"),
      escapeCsvCell(t.originalEstimate),
      escapeCsvCell(t.qaEstimate),
      escapeCsvCell(mappedAssignee),
    ];
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

