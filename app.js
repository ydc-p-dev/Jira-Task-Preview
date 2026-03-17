const fileInput = document.getElementById("fileInput");
const errorEl = document.getElementById("error");
const statsEl = document.getElementById("stats");
const tasksBody = document.getElementById("tasksBody");
const downloadBtn = document.getElementById("downloadCsv");
const mappingCard = document.getElementById("mappingCard");
const mappingRowsEl = document.getElementById("mappingRows");
const qaAsMinutesCheckbox = document.getElementById("qaAsMinutes");

let currentTasks = [];
let currentBaseName = "tasks";
let assigneeMap = {};
let qaAsMinutes = true;

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

qaAsMinutesCheckbox.addEventListener("change", () => {
  qaAsMinutes = qaAsMinutesCheckbox.checked;
  // re-render table, CSV export will automatically respect new mode
  renderTasks(currentTasks);
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

function normalizeAssigneeKey(value) {
  // Trim and remove zero-width / non-breaking spaces so "FS1" variants collapse.
  return String(value || "")
    .replace(/[\u200B-\u200F\uFEFF\u00A0]/g, "")
    .trim();
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
  const lines = [];
  const items = Array.from(listEl.children).filter(
    (c) => c.tagName && c.tagName.toLowerCase() === "li",
  );
  for (const li of items) {
    let text = renderInline(li).trim();
    if (text) {
      let effectiveLevel = level;
      // Heuristic: if we are in a numbered list and the item itself
      // starts with "a. ", "b. ", etc., treat it as a nested level.
      const alphaMatch = text.match(/^([a-z])\.\s+(.*)$/i);
      if (ordered && level === 1 && alphaMatch) {
        effectiveLevel = level + 1;
        text = alphaMatch[2].trim();
      }
      const prefix = ordered ? "#".repeat(effectiveLevel) : "*".repeat(effectiveLevel);
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
  let lastWasNumberedList = false;
  for (const child of cell.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (tag === "p") {
        const raw = renderInline(child).trim();
        if (raw) {
          // If this paragraph immediately follows a numbered list and starts
          // with an alphabetic marker like "a. ", "b. ", treat it as a
          // second‑level ordered list item → "## item".
          const alphaMatch = raw.match(/^([a-z])\.\s+(.*)$/i);
          if (lastWasNumberedList && alphaMatch) {
            const itemText = alphaMatch[2].trim();
            parts.push(`## ${itemText}`);
            // still considered part of the numbered list
            lastWasNumberedList = true;
          } else {
            if (lastWasNumberedList && parts.length) {
              // add blank line between numbered list and following text
              parts.push("");
            }
            parts.push(raw);
            lastWasNumberedList = false;
          }
        } else {
          lastWasNumberedList = false;
        }
      } else if (tag === "ol") {
        parts.push(...parseList(child, 1, true));
        lastWasNumberedList = true;
      } else if (tag === "ul") {
        parts.push(...parseList(child, 1, false));
        lastWasNumberedList = false;
      }
    } else if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.nodeValue || "").trim();
      if (text) {
        if (lastWasNumberedList && parts.length) {
          parts.push("");
        }
        parts.push(text);
      }
      lastWasNumberedList = false;
    }
  }
  // Post-process: for any list heading that ends with a colon (like
  // "# Actions:" or "## If validation passes:"), make all contiguous
  // following list items one level deeper (parentLevel + 1).
  for (let i = 0; i < parts.length; i++) {
    const heading = parts[i];
    const m = heading.match(/^(#{1,6})\s+.*:\s*$/);
    if (!m) continue;
    const parentHashes = m[1];
    const parentLevel = parentHashes.length;

    for (let j = i + 1; j < parts.length; j++) {
      const line = parts[j];
      if (/^\s*$/.test(line)) break;
      const lm = line.match(/^(#{1,6})(\s+)(.*)$/);
      if (!lm) break;

      const desiredLevel = parentLevel + 1;
      const newHashes = "#".repeat(desiredLevel);
      parts[j] = `${newHashes}${lm[2]}${lm[3]}`;
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
      const rawLines = fullDesc.split("\n");
      const trimmedNonEmpty = rawLines
        .map((l) => l.trim())
        .filter(Boolean);
      if (!trimmedNonEmpty.length) continue;

      // first non-empty trimmed line becomes summary
      let summary = trimmedNonEmpty[0];

      // keep original structure (including blank lines) for description
      let summaryIndex = rawLines.findIndex((l) => l.trim() === summary);
      if (summaryIndex === -1) summaryIndex = 0;
      const descriptionLines = rawLines.slice(summaryIndex + 1);
      const description = descriptionLines.join("\n").replace(/\s+$/u, "");

      if (currentSection) {
        summary = currentSection + ". " + summary;
      }

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
    descTd.innerHTML = renderDescriptionHtml(task.description);
    tr.appendChild(descTd);

    const origTd = document.createElement("td");
    origTd.className = "small";
    origTd.textContent = task.originalEstimate || "";
    tr.appendChild(origTd);

    const qaTd = document.createElement("td");
    qaTd.className = "small";
    if (qaAsMinutes && task.qaEstimate) {
      qaTd.textContent = qaToMinutes(task.qaEstimate) || task.qaEstimate;
    } else {
      qaTd.textContent = task.qaEstimate || "";
    }
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
    const key = normalizeAssigneeKey(t.assignee);
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
    const rawAssignee = t.assignee || "";
    const key = normalizeAssigneeKey(rawAssignee);
    const mappedAssignee =
      (key && assigneeMap[key]) || rawAssignee;
    const qaValue =
      qaAsMinutes && t.qaEstimate
        ? qaToMinutes(t.qaEstimate) || t.qaEstimate
        : t.qaEstimate;

    const row = [
      escapeCsvCell(t.summary),
      escapeCsvCell(t.description),
      escapeCsvCell("Task"),
      escapeCsvCell(t.originalEstimate),
      escapeCsvCell(qaValue),
      escapeCsvCell(mappedAssignee),
    ];
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

// Reuse the same parsing logic as the Python script to convert "1h", "45m",
// "2.5h" etc. to integer minutes.
function qaToMinutes(value) {
  if (!value) return "";
  const text = String(value).trim().toLowerCase();
  let minutes = 0;

  try {
    if (text.endsWith("h")) {
      const hours = parseFloat(text.slice(0, -1));
      minutes = hours * 60;
    } else if (text.endsWith("m")) {
      minutes = parseFloat(text.slice(0, -1));
    } else {
      // assume plain number is hours
      const hours = parseFloat(text);
      minutes = hours * 60;
    }
  } catch (e) {
    return "";
  }

  if (!isFinite(minutes)) return "";
  return String(Math.round(minutes));
}

// --- Description HTML rendering for dashboard ---

function renderDescriptionHtml(text) {
  if (!text) return "";
  const lines = String(text).split("\n");

  const root = document.createElement("div");
  const stack = []; // array of { el, level, type }

  function closeToLevel(level) {
    while (stack.length > level) stack.pop();
  }

  function appendParagraph(line) {
    closeToLevel(0);
    const p = document.createElement("p");
    p.textContent = line;
    root.appendChild(p);
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, "");
    if (!line.trim()) {
      // blank line → paragraph break
      closeToLevel(0);
      continue;
    }

    const m = line.match(/^([#*]+)\s+(.*)$/);
    if (!m) {
      appendParagraph(line);
      continue;
    }

    const markers = m[1];
    const content = m[2];
    const level = markers.length;
    const isOrdered = markers[0] === "#";

    // ensure stack has containers up to this level
    closeToLevel(level);

    while (stack.length < level) {
      const curLevel = stack.length + 1;
      const parent = stack[stack.length - 1];
      const listEl = document.createElement(isOrdered ? "ol" : "ul");
      listEl.style.margin = "0 0 0.25em 1.4em";
      listEl.style.paddingLeft = "1.2em";

      if (!parent) {
        root.appendChild(listEl);
      } else {
        // nested list goes inside last li of parent
        let lastLi = parent.el.lastElementChild;
        if (!lastLi) {
          lastLi = document.createElement("li");
          parent.el.appendChild(lastLi);
        }
        lastLi.appendChild(listEl);
      }

      stack.push({ el: listEl, level: curLevel, type: isOrdered ? "ol" : "ul" });
    }

    const currentList = stack[stack.length - 1].el;

    const li = document.createElement("li");
    li.textContent = content;
    currentList.appendChild(li);
  }

  return root.innerHTML;
}


