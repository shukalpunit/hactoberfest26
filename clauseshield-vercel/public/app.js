const SEVERITY_COLORS = { high: "#EF4444", medium: "#F59E0B", low: "#10B981" };
let state = { contractText: null, risks: null, sentiments: null, safetyScore: null, summary: null, metadata: null, messages: [] };
let pdfQueue = [];

// --- Tabs ---
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// --- Load files on start ---
async function loadFiles() {
  try {
    const res = await fetch("/api/files");
    const data = await res.json();
    const select = document.getElementById("file-select");
    select.innerHTML = '<option value="">-- Select a PDF --</option>';
    (data.files || []).forEach(f => {
      const opt = document.createElement("option");
      opt.value = f; opt.textContent = f;
      select.appendChild(opt);
    });
    document.getElementById("analyze-btn").disabled = false;
  } catch (e) {
    document.getElementById("file-select").innerHTML = '<option>Error loading files</option>';
  }
}

// --- PDF Queue ---
document.getElementById("add-pdf-btn").addEventListener("click", () => {
  const select = document.getElementById("file-select");
  const file = select.value;
  if (!file || pdfQueue.includes(file)) return;
  pdfQueue.push(file);
  renderPdfQueue();
});

function removePdf(file) {
  pdfQueue = pdfQueue.filter(f => f !== file);
  renderPdfQueue();
}

function renderPdfQueue() {
  const el = document.getElementById("pdf-queue");
  if (pdfQueue.length === 0) {
    el.innerHTML = '<div class="pdf-queue-empty">No PDFs queued. Select and click + Add.</div>';
    return;
  }
  el.innerHTML = pdfQueue.map(f =>
    `<div class="pdf-queue-item">
      <span class="filename">${escapeHtml(f)}</span>
      <button class="btn-danger-sm" onclick="removePdf('${f.replace(/'/g, "\\'")}')">Remove</button>
    </div>`
  ).join("");
}

// --- Status UI ---
const STEPS = [
  "Extracting text with PARSE_DOCUMENT...",
  "Running risk analysis with Cortex AI...",
  "Generating summary...",
  "Analyzing clause sentiment...",
  "Extracting contract metadata...",
];

function showSteps() {
  const box = document.getElementById("status-box");
  box.classList.remove("hidden");
  box.innerHTML = STEPS.map(s => `<div class="status-step"><span class="spinner"></span>${s}</div>`).join("");
}

function finishSteps() {
  const box = document.getElementById("status-box");
  box.innerHTML = STEPS.map(s => `<div class="status-step done">${s}</div>`).join("") +
    '<div class="status-step done" style="font-weight:600;margin-top:4px">Analysis complete</div>';
}

// --- Analyze ---
document.getElementById("analyze-btn").addEventListener("click", async () => {
  // Use first item from queue, or fallback to dropdown selection
  const filename = pdfQueue.length > 0 ? pdfQueue[0] : document.getElementById("file-select").value;
  if (!filename) return;

  const btn = document.getElementById("analyze-btn");
  btn.disabled = true; btn.textContent = "Analyzing...";
  showSteps();

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.contractText = data.contract_text;
    state.risks = data.risks;
    state.sentiments = data.sentiments;
    state.safetyScore = data.safety_score;
    state.summary = data.summary;
    state.metadata = data.metadata;
    state.messages = [];

    finishSteps();
    renderScore();
    renderSummary();
    renderRiskCards();
    renderMetadata();
    enableChat();
  } catch (e) {
    document.getElementById("status-box").innerHTML = `<div class="error-box">Error: ${escapeHtml(e.message)}</div>`;
  }
  btn.disabled = false; btn.textContent = "Analyze Contract";
});

// --- Renders ---
function renderScore() {
  const s = state.safetyScore;
  let color, verdict;
  if (s >= 70) { color = "#059669"; verdict = "Low risk - likely safe to proceed"; }
  else if (s >= 40) { color = "#d97706"; verdict = "Caution - negotiate before signing"; }
  else { color = "#dc2626"; verdict = "High risk - do not sign without legal review"; }
  document.getElementById("score-section").innerHTML = `
    <div class="score-container">
      <div class="score-ring" style="border:6px solid ${color}">
        <span class="score-number" style="color:${color}">${s}</span>
      </div>
      <div class="score-label">Contract safety score</div>
      <div class="score-verdict" style="color:${color}">${verdict}</div>
    </div>`;
}

function renderSummary() {
  const el = document.getElementById("summary-section");
  if (!state.summary) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="summary-section">
    <div class="summary-toggle" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">Contract summary</div>
    <div class="summary-text">${escapeHtml(state.summary)}</div>
  </div>`;
}

function renderRiskCards() {
  document.getElementById("risk-cards").innerHTML = '<div class="risk-grid">' + state.risks.map((risk, i) => {
    const color = SEVERITY_COLORS[risk.severity] || "#10B981";
    const sent = state.sentiments?.[i];
    let sentHtml = '<div class="sentiment-row"><span>-</span></div>';
    if (sent !== null && sent !== undefined) {
      let sLabel, sColor;
      if (sent < -0.3) { sLabel = `Negative tone (${sent.toFixed(2)})`; sColor = "#dc2626"; }
      else if (sent > 0.3) { sLabel = `Positive tone (${sent.toFixed(2)})`; sColor = "#059669"; }
      else { sLabel = `Neutral tone (${sent.toFixed(2)})`; sColor = "#d97706"; }
      const pct = Math.round((sent + 1) / 2 * 100);
      sentHtml = `<div class="sentiment-row"><span>${sLabel}</span></div>
        <div class="sentiment-bar"><div class="sentiment-fill" style="width:${pct}%;background:${sColor}"></div></div>`;
    }
    const cid = "clause-" + i;
    return `<div class="risk-card" style="border-left:4px solid ${color}">
      <span class="severity-badge" style="background:${color}">${risk.severity.toUpperCase()}</span>
      <div class="category">${escapeHtml(risk.category)}</div>
      <div class="reason">${escapeHtml(risk.reason)}</div>
      ${sentHtml}
      <span class="clause-toggle" onclick="document.getElementById('${cid}').classList.toggle('open')">See clause</span>
      <div class="clause-text" id="${cid}">${escapeHtml(risk.verbatim_clause)}</div>
    </div>`;
  }).join("") + "</div>";
}

function renderMetadata() {
  if (!state.metadata) return;
  document.getElementById("sidebar").classList.add("visible");
  const fields = { parties: "Parties", effective_date: "Effective Date", governing_law: "Governing Law", contract_type: "Contract Type", initial_term: "Initial Term", notice_period: "Notice Period" };
  document.getElementById("metadata-fields").innerHTML = Object.entries(fields).map(([k, l]) => {
    let v = state.metadata[k] || "-";
    if (Array.isArray(v)) v = v.join(", ");
    return `<div class="sidebar-field"><div class="label">${l}</div><div class="value">${escapeHtml(v)}</div></div>`;
  }).join("");
}

// --- Chat ---
function enableChat() {
  document.getElementById("chat-placeholder").classList.add("hidden");
  document.getElementById("chat-area").classList.remove("hidden");
}
document.getElementById("chat-send").addEventListener("click", sendChat);
document.getElementById("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

async function sendChat() {
  const input = document.getElementById("chat-input");
  const q = input.value.trim();
  if (!q || !state.contractText) return;
  input.value = "";
  appendChat("user", q);
  state.messages.push({ role: "user", content: q });
  document.getElementById("chat-send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, contract_text: state.contractText, messages: state.messages.slice(-6) }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    appendChat("assistant", data.response);
    state.messages.push({ role: "assistant", content: data.response });
  } catch (e) { appendChat("assistant", "Error: " + e.message); }
  document.getElementById("chat-send").disabled = false;
}

function appendChat(role, content) {
  const el = document.getElementById("chat-messages");
  const cls = role === "user" ? "chat-user" : "chat-assistant";
  const lbl = role === "user" ? "You" : "Assistant";
  el.innerHTML += `<div class="${cls}"><div class="chat-role">${lbl}</div>${escapeHtml(content)}</div>`;
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(t) {
  if (!t) return "";
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Init ---
loadFiles();
renderPdfQueue();
