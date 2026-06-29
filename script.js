const STORAGE_KEY = "asanaTimelineCsv:v1";
const DEFAULT_CSV_URL = "data/default.csv";
const DEFAULT_CSV_NAME = "sample-project.csv";

const els = {
  csvInput: document.querySelector("#csvInput"),
  dropZone: document.querySelector("#dropZone"),
  sourceStatus: document.querySelector("#sourceStatus"),
  savedStatus: document.querySelector("#savedStatus"),
  scaleSelect: document.querySelector("#scaleSelect"),
  searchInput: document.querySelector("#searchInput"),
  assigneeSelect: document.querySelector("#assigneeSelect"),
  hideCompleted: document.querySelector("#hideCompleted"),
  projectTitle: document.querySelector("#projectTitle"),
  taskCount: document.querySelector("#taskCount"),
  openCount: document.querySelector("#openCount"),
  doneCount: document.querySelector("#doneCount"),
  dateRange: document.querySelector("#dateRange"),
  legend: document.querySelector("#legend"),
  emptyState: document.querySelector("#emptyState"),
  timeline: document.querySelector("#timeline"),
  pdfButton: document.querySelector("#pdfButton"),
  templateButton: document.querySelector("#templateButton"),
  clearSavedButton: document.querySelector("#clearSavedButton")
};

const colors = [
  "#2364aa", "#00a37a", "#b7472a", "#7b4ab8", "#c78200",
  "#1f7a8c", "#b9375e", "#4b7f52", "#7a5c00", "#5b6cdd"
];

let state = {
  rawCsv: "",
  fileName: "",
  loadedAt: "",
  rows: [],
  tasks: [],
  assigneeColors: new Map(),
  renderedTasks: []
};

let timelineLayoutFrame = 0;

init();

function init() {
  bindEvents();
  restoreSavedCsv();
}

function bindEvents() {
  els.csvInput.addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) readCsvFile(file);
  });

  ["dragenter", "dragover"].forEach(name => {
    els.dropZone.addEventListener(name, event => {
      event.preventDefault();
      els.dropZone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach(name => {
    els.dropZone.addEventListener(name, event => {
      event.preventDefault();
      els.dropZone.classList.remove("is-dragging");
    });
  });

  els.dropZone.addEventListener("drop", event => {
    const file = event.dataTransfer.files?.[0];
    if (file) readCsvFile(file);
  });

  [els.scaleSelect, els.searchInput, els.assigneeSelect, els.hideCompleted].forEach(control => {
    control.addEventListener("input", render);
  });

  els.clearSavedButton.addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    state = { rawCsv: "", fileName: "", loadedAt: "", rows: [], tasks: [], assigneeColors: new Map(), renderedTasks: [] };
    updateSavedStatus();
    updateProjectTitle();
    loadDefaultCsv();
  });

  els.templateButton.addEventListener("click", downloadTemplate);
  els.pdfButton.addEventListener("click", exportPdf);
  els.timeline.addEventListener("wheel", handleTimelineWheel, { passive: false });

  window.addEventListener("resize", () => {
    if (!els.timeline.hidden && state.renderedTasks.length) {
      requestTimelineLayoutSync();
    }
  });

  window.addEventListener("scroll", requestTimelineLayoutSync, { passive: true });

  window.addEventListener("beforeprint", () => {
    if (!els.timeline.hidden && state.renderedTasks.length) {
      drawDependencyLayer(state.renderedTasks);
    }
  });

  window.addEventListener("afterprint", () => {
    if (!els.timeline.hidden && state.renderedTasks.length) {
      requestAnimationFrame(() => drawDependencyLayer(state.renderedTasks));
    }
  });
}

function readCsvFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    loadCsv(String(reader.result || ""), file.name, new Date().toISOString(), true);
  };
  reader.readAsText(file, "utf-8");
}

function exportPdf() {
  if (!state.rawCsv || !state.tasks.length) {
    window.alert("PDF出力するタスクがありません。CSVを読み込んでから実行してください。");
    return;
  }

  drawDependencyLayer(state.renderedTasks);
  window.print();
}

function restoreSavedCsv() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    updateSavedStatus();
    loadDefaultCsv();
    return;
  }

  try {
    const parsed = JSON.parse(saved);
    loadCsv(parsed.rawCsv || "", parsed.fileName || "保存データ", parsed.loadedAt || "", false);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    updateSavedStatus();
    render();
  }
}

async function loadDefaultCsv() {
  try {
    const response = await fetch(DEFAULT_CSV_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Default CSV not found: ${response.status}`);
    const rawCsv = await response.text();
    loadCsv(rawCsv, DEFAULT_CSV_NAME, new Date().toISOString(), false);
  } catch {
    updateSavedStatus();
    render();
  }
}

function loadCsv(rawCsv, fileName, loadedAt, shouldSave) {
  const rows = parseCsv(rawCsv);
  const tasks = normalizeRows(rows);

  state.rawCsv = rawCsv;
  state.fileName = fileName;
  state.loadedAt = loadedAt;
  state.rows = rows;
  state.tasks = tasks;
  state.assigneeColors = buildAssigneeColors(tasks);

  if (shouldSave) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rawCsv, fileName, loadedAt }));
  }

  populateAssigneeFilter(tasks);
  updateSavedStatus();
  render();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  row.push(value);
  if (row.some(cell => cell.trim() !== "")) rows.push(row);
  return rows;
}

function normalizeRows(rows) {
  const headerIndex = rows.findIndex(row => {
    const normalized = row.map(normalizeKey);
    return normalized.includes("name") && normalized.includes("duedate");
  });

  if (headerIndex === -1) return [];

  const headers = rows[headerIndex].map(normalizeKey);
  return rows.slice(headerIndex + 1).map(row => {
    const record = Object.fromEntries(headers.map((key, index) => [key, (row[index] || "").trim()]));
    const dueDate = parseAsanaDate(record.duedate);
    const rawStart = parseAsanaDate(record.startdate);
    const startDate = rawStart || dueDate;

    if (!record.name || !dueDate || !startDate) return null;

    return {
      id: record.taskid || record.id || record.name,
      name: record.name,
      section: record.sectioncolumn || "未分類",
      assignee: record.assignee || "未割り当て",
      startDate,
      dueDate,
      missingStart: !rawStart,
      milestone: !rawStart,
      completedAt: parseAsanaDate(record.completedat),
      tags: record.tags || "",
      notes: record.notes || "",
      blockedBy: record.blockedbydependencies || "",
      blocking: record.blockingdependencies || ""
    };
  }).filter(Boolean).sort((a, b) => a.startDate - b.startDate || a.dueDate - b.dueDate);
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseAsanaDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const utc = Math.round((serial - 25569) * 86400 * 1000);
      const date = new Date(utc);
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }
  }

  const normalized = text.replace(/\./g, "/").replace(/-/g, "/");
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildAssigneeColors(tasks) {
  const names = [...new Set(tasks.map(task => task.assignee))].sort((a, b) => a.localeCompare(b, "ja"));
  return new Map(names.map((name, index) => [name, colors[index % colors.length]]));
}

function populateAssigneeFilter(tasks) {
  const current = els.assigneeSelect.value;
  const names = [...new Set(tasks.map(task => task.assignee))].sort((a, b) => a.localeCompare(b, "ja"));
  els.assigneeSelect.innerHTML = `<option value="">すべて</option>${names.map(name => {
    return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
  }).join("")}`;
  els.assigneeSelect.value = names.includes(current) ? current : "";
}

function render() {
  const filtered = getFilteredTasks();
  updateProjectTitle();
  updateSourceStatus();
  updateSummary(filtered);
  renderLegend(filtered);

  if (!state.rawCsv) {
    showEmpty("CSVを読み込むとタイムラインを表示します。", "読み込んだCSVはブラウザのlocalStorageに保存され、次回復元されます。");
    return;
  }

  if (!state.tasks.length) {
    showEmpty("表示できるタスクがありません。", "CSVに `Name`, `Section/Column`, `Start Date`, `Due Date` が含まれているか確認してください。");
    return;
  }

  if (!filtered.length) {
    showEmpty("条件に合うタスクがありません。", "検索、担当者、完了タスクの表示条件を調整してください。");
    return;
  }

  els.emptyState.hidden = true;
  els.timeline.hidden = false;
  els.timeline.innerHTML = buildTimelineHtml(filtered);
  state.renderedTasks = filtered;
  requestTimelineLayoutSync();
}

function requestTimelineLayoutSync() {
  if (timelineLayoutFrame) return;
  timelineLayoutFrame = requestAnimationFrame(() => {
    timelineLayoutFrame = 0;
    syncTimelineViewportHeight();
    if (!els.timeline.hidden && state.renderedTasks.length) {
      drawDependencyLayer(state.renderedTasks);
    }
  });
}

function syncTimelineViewportHeight() {
  if (els.timeline.hidden) return;
  const body = els.timeline.querySelector(".timeline-body");
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const availableHeight = window.innerHeight - Math.max(0, rect.top) - 24;
  const height = Math.max(480, Math.min(780, availableHeight));
  els.timeline.style.setProperty("--timeline-body-max-height", `${height}px`);
}

function handleTimelineWheel(event) {
  if (els.timeline.hidden) return;
  const body = els.timeline.querySelector(".timeline-body");
  if (!body) return;

  const maxScrollTop = body.scrollHeight - body.clientHeight;
  const maxScrollLeft = els.timeline.scrollWidth - els.timeline.clientWidth;
  if (maxScrollTop <= 0 && maxScrollLeft <= 0) return;

  event.preventDefault();
  event.stopPropagation();

  body.scrollTop = clamp(body.scrollTop + event.deltaY, 0, maxScrollTop);
  els.timeline.scrollLeft = clamp(els.timeline.scrollLeft + event.deltaX, 0, maxScrollLeft);
}

function getFilteredTasks() {
  const query = els.searchInput.value.trim().toLowerCase();
  const assignee = els.assigneeSelect.value;
  const hideCompleted = els.hideCompleted.checked;

  return state.tasks.filter(task => {
    if (assignee && task.assignee !== assignee) return false;
    if (hideCompleted && task.completedAt) return false;
    if (!query) return true;
    return [task.name, task.section, task.assignee, task.tags, task.notes].some(value => {
      return String(value || "").toLowerCase().includes(query);
    });
  });
}

function buildTimelineHtml(tasks) {
  const scale = els.scaleSelect.value;
  const range = getRange(tasks, scale);
  const units = buildUnits(range.start, range.end, scale);
  const unitWidth = getUnitWidth(scale);
  const sections = groupBy(tasks, task => task.section);
  const rowHeight = 54;
  const sectionHeight = 40;
  let bodyHeight = 0;
  const header = `
    <div class="time-header">
      <div class="corner-cell">セクション / タスク</div>
      <div class="scale-grid" style="grid-template-columns: repeat(${units.length}, ${unitWidth}px);">
        ${units.map(unit => `<div class="scale-cell">${escapeHtml(formatUnit(unit, scale))}</div>`).join("")}
      </div>
    </div>`;

  const body = [...sections.entries()].map(([section, sectionTasks]) => {
    bodyHeight += sectionHeight;
    const rows = sectionTasks.map(task => {
      bodyHeight += rowHeight;
      return buildTaskRow(task, range.start, scale, unitWidth, units.length);
    }).join("");
    return `
      <div class="section-row">
        <div class="section-title">${escapeHtml(section)}</div>
        <div class="section-band"></div>
      </div>
      ${rows}`;
  }).join("");

  return `<div class="timeline-root" style="--unit-width: ${unitWidth}px;">${header}<div class="timeline-body">${body}<svg class="dependency-layer" aria-hidden="true"></svg></div></div>`;
}

function buildTaskRow(task, rangeStart, scale, unitWidth, unitCount) {
  const { left, width } = getTaskGeometry(task, rangeStart, scale, unitWidth);
  const color = state.assigneeColors.get(task.assignee) || colors[0];
  const doneClass = task.completedAt ? " done" : "";
  const status = task.completedAt ? "完了" : "未完了";
  const visual = task.milestone
    ? `<div class="task-milestone task-visual${doneClass}" data-task-key="${escapeHtml(normalizeDependencyName(task.name))}" title="${escapeHtml(buildTaskTitle(task, status))}" style="left: ${left}px; background: ${color};" aria-label="${escapeHtml(task.name)}"></div>`
    : `<div class="task-bar task-visual${doneClass}" data-task-key="${escapeHtml(normalizeDependencyName(task.name))}" title="${escapeHtml(buildTaskTitle(task, status))}" style="left: ${left + 4}px; width: ${width}px; background: ${color};">${escapeHtml(task.name)}</div>`;

  return `
    <div class="timeline-row">
      <div class="task-label">
        <span class="task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</span>
        <span class="task-meta">
          <span>${escapeHtml(task.assignee)}</span>
          <span class="status-chip${task.completedAt ? " done" : ""}">${status}</span>
          ${task.milestone ? `<span class="status-chip milestone">マイルストーン</span>` : ""}
        </span>
      </div>
      <div class="bar-lane" style="width: ${unitCount * unitWidth}px;">
        ${visual}
      </div>
    </div>`;
}

function buildTaskTitle(task, status) {
  const title = [
    task.name,
    `担当者: ${task.assignee}`,
    task.milestone ? `マイルストーン: ${formatDate(task.dueDate)}` : `期間: ${formatDate(task.startDate)} - ${formatDate(task.dueDate)}`,
    `状態: ${status}`,
    task.blockedBy ? `Blocked By: ${task.blockedBy}` : "",
    task.blocking ? `Blocking: ${task.blocking}` : ""
  ].filter(Boolean).join("\n");
  return title;
}

function getTaskGeometry(task, rangeStart, scale, unitWidth) {
  const startOffset = diffUnits(rangeStart, task.startDate, scale);
  const endOffset = diffUnits(rangeStart, task.dueDate, scale);
  const span = Math.max(1, endOffset - startOffset + 1);
  if (task.milestone) {
    const left = startOffset * unitWidth + unitWidth / 2 - 9;
    return {
      left,
      width: 18
    };
  }

  const left = startOffset * unitWidth;
  const width = Math.max(18, span * unitWidth - 8);
  return {
    left,
    width
  };
}

function drawDependencyLayer(tasks) {
  const root = els.timeline.querySelector(".timeline-root");
  const body = els.timeline.querySelector(".timeline-body");
  const svg = els.timeline.querySelector(".dependency-layer");
  if (!root || !body || !svg) return;

  const visualMap = new Map();
  root.querySelectorAll(".task-visual").forEach(element => {
    visualMap.set(element.dataset.taskKey, element);
  });

  const rootRect = root.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const width = Math.max(root.scrollWidth, rootRect.width);
  const height = Math.max(body.scrollHeight, bodyRect.height);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const paths = collectDependencyArrows(tasks).map(arrow => {
    const sourceElement = visualMap.get(normalizeDependencyName(arrow.source.name));
    const targetElement = visualMap.get(normalizeDependencyName(arrow.target.name));
    if (!sourceElement || !targetElement) return "";

    const sourceRect = sourceElement.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const sourceIsMilestone = sourceElement.classList.contains("task-milestone");
    const targetIsMilestone = targetElement.classList.contains("task-milestone");
    const x1 = (sourceIsMilestone ? sourceRect.left + sourceRect.width / 2 : sourceRect.right) - rootRect.left;
    const y1 = sourceRect.top + sourceRect.height / 2 - bodyRect.top + body.scrollTop;
    const x2 = (targetIsMilestone ? targetRect.left - 6 : targetRect.left) - rootRect.left;
    const y2 = targetRect.top + targetRect.height / 2 - bodyRect.top + body.scrollTop;
    const midX = x2 >= x1 ? (x1 + x2) / 2 : Math.max(x1 + 36, x2 + 36);
    const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
    const title = `${arrow.source.name} -> ${arrow.target.name}`;
    return `<path class="dependency-path" d="${path}"><title>${escapeHtml(title)}</title></path>`;
  }).join("");

  svg.innerHTML = `
    <defs>
      <marker id="dependencyArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
    </defs>
    ${paths}`;
}

function collectDependencyArrows(tasks) {
  const arrows = [];
  const seen = new Set();
  const taskMap = new Map(tasks.map(task => [normalizeDependencyName(task.name), task]));

  tasks.forEach(task => {
    splitDependencyNames(task.blockedBy).forEach(sourceName => {
      const source = taskMap.get(normalizeDependencyName(sourceName));
      if (!source || source === task) return;
      const key = `${source.id}->${task.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      arrows.push({ source, target: task });
    });

    splitDependencyNames(task.blocking).forEach(targetName => {
      const target = taskMap.get(normalizeDependencyName(targetName));
      if (!target || target === task) return;
      const key = `${task.id}->${target.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      arrows.push({ source: task, target });
    });
  });

  return arrows;
}

function splitDependencyNames(value) {
  return String(value || "")
    .split(/\r?\n|;|,/)
    .map(name => name.trim())
    .filter(Boolean);
}

function normalizeDependencyName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getRange(tasks, scale) {
  const starts = tasks.map(task => task.startDate.getTime());
  const ends = tasks.map(task => task.dueDate.getTime());
  let start = new Date(Math.min(...starts));
  let end = new Date(Math.max(...ends));

  if (scale === "week") {
    start = startOfWeek(start);
    end = endOfWeek(end);
  } else if (scale === "month") {
    start = new Date(start.getFullYear(), start.getMonth(), 1);
    end = new Date(end.getFullYear(), end.getMonth() + 1, 0);
  } else if (scale === "quarter") {
    start = startOfQuarter(start);
    end = endOfQuarter(end);
  } else if (scale === "half") {
    start = startOfHalf(start);
    end = endOfHalf(end);
  } else if (scale === "year") {
    start = new Date(start.getFullYear(), 0, 1);
    end = new Date(end.getFullYear(), 11, 31);
  }

  return { start, end };
}

function buildUnits(start, end, scale) {
  const units = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    units.push(new Date(cursor));
    if (scale === "day") cursor.setDate(cursor.getDate() + 1);
    if (scale === "week") cursor.setDate(cursor.getDate() + 7);
    if (scale === "month") cursor.setMonth(cursor.getMonth() + 1);
    if (scale === "quarter") cursor.setMonth(cursor.getMonth() + 3);
    if (scale === "half") cursor.setMonth(cursor.getMonth() + 6);
    if (scale === "year") cursor.setFullYear(cursor.getFullYear() + 1);
  }
  return units;
}

function diffUnits(start, date, scale) {
  if (scale === "day") return Math.floor((date - start) / 86400000);
  if (scale === "week") return Math.floor((startOfWeek(date) - startOfWeek(start)) / (86400000 * 7));
  const monthDiff = (date.getFullYear() - start.getFullYear()) * 12 + date.getMonth() - start.getMonth();
  if (scale === "month") return monthDiff;
  if (scale === "quarter") return Math.floor(monthDiff / 3);
  if (scale === "half") return Math.floor(monthDiff / 6);
  return date.getFullYear() - start.getFullYear();
}

function groupBy(items, getKey) {
  const map = new Map();
  items.forEach(item => {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
}

function updateSourceStatus() {
  if (!state.rawCsv) {
    els.sourceStatus.textContent = "未読み込み";
    return;
  }
  els.sourceStatus.textContent = `${state.fileName} / ${state.tasks.length}件`;
}

function updateProjectTitle() {
  const projectName = state.rawCsv ? getProjectNameFromFile(state.fileName) : "タスクタイムライン";
  els.projectTitle.textContent = projectName;
  document.title = state.rawCsv ? `${projectName} | Asana Timeline Viewer` : "Asana Timeline Viewer";
}

function getProjectNameFromFile(fileName) {
  return String(fileName || "タスクタイムライン")
    .replace(/\.[^.]+$/, "")
    .trim() || "タスクタイムライン";
}

function updateSavedStatus() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    els.savedStatus.textContent = "localStorage保存: なし";
    return;
  }

  try {
    const parsed = JSON.parse(saved);
    els.savedStatus.textContent = `localStorage保存: ${parsed.fileName || "保存データ"}`;
  } catch {
    els.savedStatus.textContent = "localStorage保存: あり";
  }
}

function updateSummary(tasks) {
  const done = tasks.filter(task => task.completedAt).length;
  const open = tasks.length - done;
  els.taskCount.textContent = String(tasks.length);
  els.openCount.textContent = String(open);
  els.doneCount.textContent = String(done);

  if (!tasks.length) {
    els.dateRange.textContent = "-";
    return;
  }

  const range = getRange(tasks, "day");
  els.dateRange.textContent = `${formatDate(range.start)} - ${formatDate(range.end)}`;
}

function renderLegend(tasks) {
  const names = [...new Set(tasks.map(task => task.assignee))].sort((a, b) => a.localeCompare(b, "ja"));
  els.legend.innerHTML = names.length ? names.map(name => {
    const color = state.assigneeColors.get(name) || colors[0];
    return `<span class="legend-item"><span class="swatch" style="background: ${color};"></span>${escapeHtml(name)}</span>`;
  }).join("") : `<span class="drop-copy">CSV読み込み後に表示します。</span>`;
}

function showEmpty(title, copy) {
  els.timeline.hidden = true;
  els.emptyState.hidden = false;
  els.emptyState.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span>`;
}

function downloadTemplate() {
  const header = "Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task,Blocked By (Dependencies),Blocking (Dependencies),ID";
  const sample = "1,,,,Sample Task,0. Project Planning,Sample Owner,,2026/07/01,2026/07/05,,,Sample Project,,,,ID-00001";
  const blob = new Blob([`${header}\n${sample}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "asana-timeline-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function startOfWeek(date) {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return new Date(copy.getFullYear(), copy.getMonth(), copy.getDate());
}

function endOfWeek(date) {
  const copy = startOfWeek(date);
  copy.setDate(copy.getDate() + 6);
  return copy;
}

function startOfQuarter(date) {
  const month = Math.floor(date.getMonth() / 3) * 3;
  return new Date(date.getFullYear(), month, 1);
}

function endOfQuarter(date) {
  const start = startOfQuarter(date);
  return new Date(start.getFullYear(), start.getMonth() + 3, 0);
}

function startOfHalf(date) {
  const month = date.getMonth() < 6 ? 0 : 6;
  return new Date(date.getFullYear(), month, 1);
}

function endOfHalf(date) {
  const start = startOfHalf(date);
  return new Date(start.getFullYear(), start.getMonth() + 6, 0);
}

function getUnitWidth(scale) {
  if (scale === "day") return 46;
  if (scale === "week") return 74;
  if (scale === "month") return 96;
  if (scale === "quarter") return 118;
  if (scale === "half") return 132;
  return 150;
}

function formatUnit(date, scale) {
  if (scale === "day") return `${date.getMonth() + 1}/${date.getDate()}`;
  if (scale === "week") return `${date.getMonth() + 1}/${date.getDate()}週`;
  if (scale === "month") return `${date.getFullYear()}/${date.getMonth() + 1}`;
  if (scale === "quarter") return `${date.getFullYear()} Q${Math.floor(date.getMonth() / 3) + 1}`;
  if (scale === "half") return `${date.getFullYear()} H${date.getMonth() < 6 ? 1 : 2}`;
  return `${date.getFullYear()}`;
}

function formatDate(date) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
