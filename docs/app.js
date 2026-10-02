const SEVERITY_COLORS = { high: "#EF4444", medium: "#F59E0B", low: "#10B981" };
const MODEL = "llama3.1-70b";

const RISK_PROMPT = `You are a contract risk analyst. Analyze the following contract text and return a JSON object with exactly 5 risk categories. Return ONLY valid JSON, no markdown fences, no prose, no explanation.

The JSON schema:
{
  "risks": [
    {
      "category": "Indemnification",
      "severity": "high" | "medium" | "low",
      "reason": "One sentence explaining the risk",
      "verbatim_clause": "The exact sentence from the contract that is problematic"
    },
    { "category": "Liability" },
    { "category": "Termination" },
    { "category": "IP Ownership" },
    { "category": "Auto-Renewal" }
  ]
}

Rules:
- severity is ONLY "high", "medium", or "low"
- verbatim_clause MUST be a direct quote from the contract, not a paraphrase
- If a category is not mentioned in the contract, set severity to "low" and reason to "Not addressed in contract"
- Return ONLY the JSON object. No markdown. No backticks. No explanation before or after.`;

const METADATA_PROMPT = 'Extract from this contract and return ONLY valid JSON, no markdown fences: {"parties": ["name1", "name2"], "effective_date": "...", "governing_law": "...", "contract_type": "...", "initial_term": "...", "notice_period": "..."}';

const CHAT_SYSTEM_PROMPT = "You are a contract analyst assistant. Answer questions about the following contract. Be specific: cite section numbers and quote relevant clauses. If something is not in the contract, say so.\n\nContract text:\n";

let state = { contractText: null, risks: null, sentiments: null, safetyScore: null, summary: null, metadata: null, messages: [] };

// --- Login ---
document.getElementById("connect-btn").addEventListener("click", async () => {
  const btn = document.getElementById("connect-btn");
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  btn.disabled = true; btn.textContent = "Connecting...";

  try {
    const account = document.getElementById("sf-account").value.trim();
    const user = document.getElementById("sf-user").value.trim();
    const key = document.getElementById("sf-key").value.trim();
    if (!account || !user || !key) throw new Error("All fields are required");

    await SF.init(account, user, key);
    // Test connection
    const testResult = await SF.executeSQL("SELECT 1");
    if (!testResult.data) throw new Error("Connection test failed");

    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app-screen").classList.remove("hidden");
    document.getElementById("conn-badge").classList.remove("hidden");
    loadFiles();
  } catch (e) {
    errEl.textContent = "Connection failed: " + e.message;
    errEl.classList.remove("hidden");
  }
  btn.disabled = false; btn.textContent = "Connect";
});

// --- Tabs ---
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// --- Load files ---
async function loadFiles() {
  try {
    const result = await SF.executeSQL("LIST @CLAUSESHIELD_DB.APP.CONTRACTS");
    const select = document.getElementById("file-select");
    select.innerHTML = '<option value="">-- Select a PDF --</option>';
    if (result.data) {
      result.data.forEach(row => {
        const name = row[0];
        if (name.toLowerCase().endsWith(".pdf")) {
          const fname = name.split("/").pop();
          const opt = document.createElement("option");
          opt.value = fname; opt.textContent = fname;
          select.appendChild(opt);
        }
      });
    }
    document.getElementById("analyze-btn").disabled = false;
  } catch (e) {
    document.getElementById("file-select").innerHTML = '<option>Error: ' + escapeHtml(e.message) + '</option>';
  }
}

// --- Cortex helpers ---
async function callComplete(messages, temperature) {
  const msgsJson = JSON.stringify(messages);
  const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('${MODEL}', PARSE_JSON($$ ${msgsJson} $$), {'temperature': ${temperature}}) AS response`;
  const result = await SF.executeSQL(sql);
  const raw = JSON.parse(SF.getValue(result));
  let text = raw.choices?.[0]?.messages ?? raw.messages ?? "";
  if (Array.isArray(text)) text = text[0]?.content ?? JSON.stringify(text);
  else if (typeof text === "object") text = text.content ?? JSON.stringify(text);
  return text;
}

// --- Status UI helper ---
const STEPS = [
  "Extracting text with PARSE_DOCUMENT...",
  "Running risk analysis with Cortex AI...",
  "Generating summary...",
  "Analyzing clause sentiment...",
  "Extracting contract metadata...",
];

function showStep(idx) {
  const box = document.getElementById("status-box");
  box.innerHTML = STEPS.map((s, i) => {
    if (i < idx) return `<div class="status-step done">${s}</div>`;
    if (i === idx) return `<div class="status-step active"><span class="spinner"></span>${s}</div>`;
    return `<div class="status-step">${s}</div>`;
  }).join("");
}

// --- Analyze ---
document.getElementById("analyze-btn").addEventListener("click", async () => {
  const filename = document.getElementById("file-select").value;
  if (!filename) return;

  const btn = document.getElementById("analyze-btn");
  btn.disabled = true; btn.textContent = "Analyzing...";
  const statusBox = document.getElementById("status-box");
  statusBox.classList.remove("hidden");

  try {
    // Step 0: Parse document
    showStep(0);
    const parseResult = await SF.executeSQL(
      `SELECT SNOWFLAKE.CORTEX.PARSE_DOCUMENT('@CLAUSESHIELD_DB.APP.CONTRACTS', '${SF.escapeSql(filename)}', {'mode': 'LAYOUT'})`
    );
    const parseJson = JSON.parse(SF.getValue(parseResult));
    state.contractText = parseJson.content || "";

    // Step 1: Risk analysis
    showStep(1);
    const riskText = await callComplete([
      { role: "system", content: RISK_PROMPT },
      { role: "user", content: state.contractText }
    ], 0);
    const risksData = SF.parseLlmJson(riskText);
    state.risks = risksData.risks;
    state.safetyScore = computeSafetyScore(state.risks);

    // Step 2: Summary
    showStep(2);
    try {
      const sumResult = await SF.executeSQL(`SELECT SNOWFLAKE.CORTEX.SUMMARIZE('${SF.escapeSql(state.contractText)}')`);
      state.summary = SF.getValue(sumResult);
    } catch { state.summary = null; }

    // Step 3: Sentiment
    showStep(3);
    state.sentiments = [];
    for (const risk of state.risks) {
      try {
        const sentResult = await SF.executeSQL(`SELECT SNOWFLAKE.CORTEX.SENTIMENT('${SF.escapeSql(risk.verbatim_clause)}')`);
        state.sentiments.push(parseFloat(SF.getValue(sentResult)));
      } catch { state.sentiments.push(null); }
    }

    // Step 4: Metadata
    showStep(4);
    try {
      const metaText = await callComplete([
        { role: "system", content: METADATA_PROMPT },
        { role: "user", content: state.contractText }
      ], 0);
      state.metadata = SF.parseLlmJson(metaText);
    } catch { state.metadata = null; }

    showStep(5); // all done
    state.messages = [];
    renderScore();
    renderSummary();
    renderRiskCards();
    renderMetadata();
    enableChat();
  } catch (e) {
    statusBox.innerHTML = `<div class="error-box">Error: ${escapeHtml(e.message)}</div>`;
  }
  btn.disabled = false; btn.textContent = "Analyze Contract";
});

function computeSafetyScore(risks) {
  const pts = { high: 30, medium: 15, low: 5 };
  return Math.max(0, 100 - risks.reduce((s, r) => s + (pts[r.severity] || 0), 0));
}

// --- Render score ---
function renderScore() {
  const s = state.safetyScore;
  let color, verdict;
  if (s >= 70) { color = "#10B981"; verdict = "Low risk - likely safe to proceed"; }
  else if (s >= 40) { color = "#F59E0B"; verdict = "Caution - negotiate before signing"; }
  else { color = "#EF4444"; verdict = "High risk - do not sign without legal review"; }
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
      if (sent < -0.3) { sLabel = `Negative tone (${sent.toFixed(2)})`; sColor = "#EF4444"; }
      else if (sent > 0.3) { sLabel = `Positive tone (${sent.toFixed(2)})`; sColor = "#10B981"; }
      else { sLabel = `Neutral tone (${sent.toFixed(2)})`; sColor = "#F59E0B"; }
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
    const conversation = [
      { role: "system", content: CHAT_SYSTEM_PROMPT + state.contractText },
      ...state.messages.slice(-6),
    ];
    const resp = await callComplete(conversation, 0.3);
    appendChat("assistant", resp);
    state.messages.push({ role: "assistant", content: resp });
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
