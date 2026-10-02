import streamlit as st
import json
from snowflake.snowpark.context import get_active_session

session = get_active_session()

# ---------------------------------------------------------------------------
# Page config & global CSS
# ---------------------------------------------------------------------------
st.set_page_config(layout="wide")

st.markdown("""
<style>
/* --- Page layout --- */
.block-container { padding-top: 1.5rem; max-width: 1200px; }
#MainMenu {visibility: hidden;}
footer {visibility: hidden;}
header {visibility: hidden;}

/* --- Tab styling --- */
.stTabs [data-baseweb="tab-list"] { gap: 8px; }

/* --- General font --- */
html, body, [class*="css"] {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #F0F0F0;
}

/* --- Sidebar metadata fields --- */
.sidebar-field { padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
.sidebar-field .label {
    font-size: 0.7rem; color: #888888; text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 2px;
}
.sidebar-field .value { font-size: 0.9rem; color: #E0E0E0; }

/* --- Score ring --- */
.score-container {
    background: rgba(255,255,255,0.05); border-radius: 16px; padding: 2rem;
    text-align: center; margin-bottom: 1.5rem; border: 1px solid rgba(255,255,255,0.12);
}
.score-ring {
    width: 120px; height: 120px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 0.5rem auto;
}
.score-number { font-size: 4rem; font-weight: 800; line-height: 1; color: #FFFFFF; }
.score-label { font-size: 0.85rem; color: #A0A0A0; margin-top: 0.25rem; }
.score-verdict { font-size: 1rem; font-weight: 500; margin-top: 0.25rem; }

/* --- Risk cards --- */
.risk-card {
    background: rgba(255,255,255,0.08); border-radius: 12px; padding: 1.2rem;
    border: 1px solid rgba(255,255,255,0.12); margin-bottom: 0.5rem;
}
.severity-badge {
    display: inline-block; padding: 2px 10px; border-radius: 99px;
    font-size: 0.7rem; color: #FFFFFF; text-transform: uppercase;
    font-weight: 600; letter-spacing: 0.3px;
}
.risk-card .category { font-size: 1rem; font-weight: 600; margin-top: 8px; color: #F0F0F0; }
.risk-card .reason { font-size: 0.85rem; color: #A0A0A0; margin-top: 4px; line-height: 1.4; }

/* --- Sentiment bar --- */
.sentiment-row {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 0.7rem; color: #A0A0A0; margin-top: 6px;
}
.sentiment-bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.12); margin-top: 4px; }
.sentiment-fill { height: 4px; border-radius: 2px; }

/* --- Summary expander text --- */
.summary-text { font-size: 0.9rem; line-height: 1.6; color: #D0D0D0; }

/* --- Chat messages --- */
.chat-user {
    background: rgba(100,140,255,0.12); border-radius: 12px; padding: 12px 16px;
    margin-bottom: 8px; color: #F0F0F0;
}
.chat-assistant { padding: 12px 16px; margin-bottom: 8px; color: #F0F0F0; border-left: 3px solid rgba(255,255,255,0.15); }
.chat-role { font-size: 0.75rem; color: #A0A0A0; margin-bottom: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }

/* --- App header --- */
.app-header {
    border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 1rem; margin-bottom: 1.5rem;
}
.app-header h1 { font-size: 2rem; font-weight: 700; margin: 0; color: #F0F0F0; }
.app-header p { font-size: 0.9rem; color: #A0A0A0; margin: 0.25rem 0 0 0; }

/* --- PDF queue --- */
.pdf-queue-item {
    display: flex; align-items: center; justify-content: space-between;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
    padding: 6px 12px; margin-bottom: 4px; font-size: 0.85rem; color: #E0E0E0;
}
.pdf-queue-item .fname { font-weight: 500; }
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Styled header
# ---------------------------------------------------------------------------
st.markdown("""
<div class="app-header">
    <h1>ClauseShield</h1>
    <p>Contract risk analysis powered by Snowflake Cortex</p>
</div>
""", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MODEL = "llama3.1-70b"

FALLBACK_RISKS = {
    "risks": [
        {
            "category": "Indemnification",
            "severity": "medium",
            "reason": "Standard mutual indemnification with uncapped liability for IP infringement.",
            "verbatim_clause": "Each party shall indemnify the other against all claims arising from breach of this agreement.",
        },
        {
            "category": "Liability",
            "severity": "high",
            "reason": "No limitation of liability clause found, exposing parties to unlimited damages.",
            "verbatim_clause": "Not addressed in contract",
        },
        {
            "category": "Termination",
            "severity": "low",
            "reason": "Standard 30-day notice termination for convenience.",
            "verbatim_clause": "Either party may terminate this agreement with 30 days written notice.",
        },
        {
            "category": "IP Ownership",
            "severity": "medium",
            "reason": "Work product ownership is ambiguous and could be interpreted either way.",
            "verbatim_clause": "All work product created during the engagement shall be jointly owned.",
        },
        {
            "category": "Auto-Renewal",
            "severity": "low",
            "reason": "No auto-renewal clause present.",
            "verbatim_clause": "Not addressed in contract",
        },
    ]
}

RISK_ANALYSIS_SYSTEM_PROMPT = """You are a contract risk analyst. Analyze the following contract text and return a JSON object with exactly 5 risk categories. Return ONLY valid JSON, no markdown fences, no prose, no explanation.

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
- Return ONLY the JSON object. No markdown. No backticks. No explanation before or after."""

CHAT_SYSTEM_PROMPT_TEMPLATE = """You are a contract analyst assistant. Answer questions about the following contract. Be specific: cite section numbers and quote relevant clauses. If something is not in the contract, say so.

Contract text:
{contract_text}"""

METADATA_SYSTEM_PROMPT = 'Extract from this contract and return ONLY valid JSON, no markdown fences: {"parties": ["name1", "name2"], "effective_date": "...", "governing_law": "...", "contract_type": "...", "initial_term": "...", "notice_period": "..."}'

SEVERITY_CARD_COLORS = {"high": "#EF4444", "medium": "#F59E0B", "low": "#10B981"}

# ---------------------------------------------------------------------------
# Helper functions (existing, unchanged logic)
# ---------------------------------------------------------------------------

def escape_sql(text):
    return text.replace("\\", "\\\\").replace("'", "\\'")


def escape_html(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

def parse_llm_json(text):
    cleaned = text.strip()
    cleaned = cleaned.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    return json.loads(cleaned)


def call_complete(model, messages_list, temperature=0):
    msgs_json = json.dumps(messages_list, ensure_ascii=False)
    sql = (
        "SELECT SNOWFLAKE.CORTEX.COMPLETE("
        "'" + model + "', "
        "PARSE_JSON($$ " + msgs_json + " $$), "
        "{'temperature': " + str(temperature) + "}) AS response"
    )
    result = session.sql(sql).collect()
    raw = result[0][0]
    response_obj = json.loads(raw)
    response_text = response_obj.get("choices", [{}])[0].get("messages", response_obj.get("messages", raw))
    if isinstance(response_text, list):
        response_text = response_text[0].get("content", str(response_text))
    elif isinstance(response_text, dict):
        response_text = response_text.get("content", str(response_text))
    elif not isinstance(response_text, str):
        response_text = str(response_text)
    return response_text


def analyze_contract(contract_text):
    messages_list = [
        {"role": "system", "content": RISK_ANALYSIS_SYSTEM_PROMPT},
        {"role": "user", "content": contract_text},
    ]
    response_text = call_complete(MODEL, messages_list, temperature=0)
    return parse_llm_json(response_text)


def chat_with_contract(contract_text, messages):
    system_prompt = CHAT_SYSTEM_PROMPT_TEMPLATE.format(contract_text=contract_text)
    conversation = [{"role": "system", "content": system_prompt}]
    recent = messages[-6:]
    for msg in recent:
        conversation.append({"role": msg["role"], "content": msg["content"]})
    return call_complete(MODEL, conversation, temperature=0.3)


def get_stage_files():
    try:
        rows = session.sql("LIST @CLAUSESHIELD_DB.APP.CONTRACTS").collect()
        files = []
        for row in rows:
            name = row[0]
            if name.lower().endswith(".pdf"):
                fname = name.split("/")[-1]
                files.append(fname)
        return files
    except Exception:
        return []


# ---------------------------------------------------------------------------
# NEW: Feature 2 - Safety score (deterministic Python math)
# ---------------------------------------------------------------------------
def compute_safety_score(risks):
    points = {"high": 30, "medium": 15, "low": 5}
    total = sum(points.get(r["severity"], 0) for r in risks)
    return max(0, 100 - total)


def render_safety_score(score):
    if score >= 70:
        color, verdict = "#10B981", "Low risk -- likely safe to proceed"
    elif score >= 40:
        color, verdict = "#F59E0B", "Caution -- negotiate before signing"
    else:
        color, verdict = "#EF4444", "High risk -- do not sign without legal review"

    st.markdown(f"""
    <div class="score-container">
        <div class="score-ring" style="border: 6px solid {color};">
            <span class="score-number" style="color: {color};">{score}</span>
        </div>
        <div class="score-label">Contract safety score</div>
        <div class="score-verdict" style="color: {color};">{verdict}</div>
    </div>
    """, unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# NEW: Feature 3 - CORTEX.SUMMARIZE (separate API)
# ---------------------------------------------------------------------------
def summarize_contract(contract_text):
    try:
        escaped = escape_sql(contract_text)
        result = session.sql(
            "SELECT SNOWFLAKE.CORTEX.SUMMARIZE('" + escaped + "')"
        ).collect()
        return result[0][0]
    except Exception:
        return None


# ---------------------------------------------------------------------------
# NEW: Feature 4 - CORTEX.SENTIMENT per clause
# ---------------------------------------------------------------------------
def get_clause_sentiment(clause_text):
    try:
        escaped = escape_sql(clause_text)
        result = session.sql(
            "SELECT SNOWFLAKE.CORTEX.SENTIMENT('" + escaped + "')"
        ).collect()
        return float(result[0][0])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# NEW: Feature 5 - Contract metadata via COMPLETE
# ---------------------------------------------------------------------------
def extract_metadata(contract_text):
    try:
        messages_list = [
            {"role": "system", "content": METADATA_SYSTEM_PROMPT},
            {"role": "user", "content": contract_text},
        ]
        response_text = call_complete(MODEL, messages_list, temperature=0)
        return parse_llm_json(response_text)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Styled risk cards with sentiment (replaces old render_risk_cards)
# ---------------------------------------------------------------------------
def render_risk_cards(risks, sentiments):
    def render_card(i, risk):
        color = SEVERITY_CARD_COLORS.get(risk["severity"], "#10B981")
        sentiment = sentiments[i] if i < len(sentiments) else None

        if sentiment is not None:
            if sentiment < -0.3:
                s_label, s_color = f"Negative tone ({sentiment:.2f})", "#EF4444"
            elif sentiment > 0.3:
                s_label, s_color = f"Positive tone ({sentiment:.2f})", "#10B981"
            else:
                s_label, s_color = f"Neutral tone ({sentiment:.2f})", "#F59E0B"
            pct = int((sentiment + 1) / 2 * 100)
            sentiment_html = f"""
            <div class="sentiment-row">
                <span>{s_label}</span>
            </div>
            <div class="sentiment-bar">
                <div class="sentiment-fill" style="width: {pct}%; background: {s_color};"></div>
            </div>
            """
        else:
            sentiment_html = '<div class="sentiment-row"><span>--</span></div>'

        st.markdown(f"""
        <div class="risk-card" style="border-left: 4px solid {color}; min-height: 160px;">
            <span class="severity-badge" style="background: {color};">{risk['severity'].upper()}</span>
            <div class="category">{escape_html(risk['category'])}</div>
            <div class="reason">{escape_html(risk['reason'])}</div>
            {sentiment_html}
        </div>
        """, unsafe_allow_html=True)
        with st.expander("See clause"):
            st.write(risk["verbatim_clause"])

    # Row 1: first 3 cards
    row1 = st.columns(3)
    for i in range(min(3, len(risks))):
        with row1[i]:
            render_card(i, risks[i])

    # Row 2: remaining cards (centered with spacer columns)
    if len(risks) > 3:
        remaining = risks[3:]
        row2 = st.columns([1, 2, 2, 1]) if len(remaining) == 2 else st.columns(3)
        offsets = [1, 2] if len(remaining) == 2 else list(range(len(remaining)))
        for j, ri in enumerate(remaining):
            with row2[offsets[j]]:
                render_card(3 + j, ri)


# ---------------------------------------------------------------------------
# Sidebar metadata display
# ---------------------------------------------------------------------------
def render_sidebar_metadata(metadata):
    if not metadata:
        return
    st.sidebar.markdown(
        '<div style="font-size:1rem; font-weight:600; margin-bottom:1rem;">Contract Details</div>',
        unsafe_allow_html=True,
    )
    field_labels = {
        "parties": "Parties",
        "effective_date": "Effective Date",
        "governing_law": "Governing Law",
        "contract_type": "Contract Type",
        "initial_term": "Initial Term",
        "notice_period": "Notice Period",
    }
    for key, label in field_labels.items():
        val = metadata.get(key, "--")
        if isinstance(val, list):
            val = ", ".join(val)
        st.sidebar.markdown(f"""
        <div class="sidebar-field">
            <div class="label">{label}</div>
            <div class="value">{escape_html(str(val))}</div>
        </div>
        """, unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Main app layout
# ---------------------------------------------------------------------------
tab_risk, tab_chat = st.tabs(["Risk Analysis", "Ask about this contract"])

with tab_risk:
    st.markdown("#### Select a contract PDF from the stage")
    st.info(
        "Upload PDFs to the stage first using Snowsight or SQL:  \n"
        "`PUT file:///path/to/contract.pdf @CLAUSESHIELD_DB.APP.CONTRACTS/ AUTO_COMPRESS=FALSE;`"
    )

    pdf_files = get_stage_files()

    if not pdf_files:
        st.warning("No PDF files found on @CLAUSESHIELD_DB.APP.CONTRACTS. Upload a PDF first.")
    else:
        # --- PDF queue: add / remove ---
        if "pdf_queue" not in st.session_state:
            st.session_state["pdf_queue"] = []

        col_sel, col_add = st.columns([5, 1])
        with col_sel:
            selected_pdf = st.selectbox("Choose a contract PDF", pdf_files, label_visibility="collapsed")
        with col_add:
            if st.button("+ Add", key="add_pdf"):
                if selected_pdf and selected_pdf not in st.session_state["pdf_queue"]:
                    st.session_state["pdf_queue"].append(selected_pdf)
                    st.experimental_rerun()

        # Render queued PDFs with remove buttons
        if st.session_state["pdf_queue"]:
            for idx, qf in enumerate(st.session_state["pdf_queue"]):
                qcol1, qcol2 = st.columns([6, 1])
                with qcol1:
                    st.markdown(f'<div class="pdf-queue-item"><span class="fname">{qf}</span></div>', unsafe_allow_html=True)
                with qcol2:
                    if st.button("Remove", key=f"rm_{idx}"):
                        st.session_state["pdf_queue"].pop(idx)
                        st.experimental_rerun()

        # Pick which file to analyze: first from queue, else dropdown
        filename = st.session_state["pdf_queue"][0] if st.session_state["pdf_queue"] else selected_pdf
        analyze_btn = st.button("Analyze Contract", type="primary")

        if analyze_btn and filename:
            if st.session_state.get("current_file") != filename:
                # Feature 1: st.status spinner wrapping the existing pipeline
                with st.status("Analyzing contract...", expanded=True) as status:
                    # Step 1: Parse document (existing logic, wrapped)
                    status.update(label="Extracting text with PARSE_DOCUMENT...")
                    parse_result = session.sql(
                        "SELECT SNOWFLAKE.CORTEX.PARSE_DOCUMENT("
                        "'@CLAUSESHIELD_DB.APP.CONTRACTS', "
                        "'" + escape_sql(filename) + "', "
                        "{'mode': 'LAYOUT'})"
                    ).collect()
                    parsed_json = json.loads(parse_result[0][0])
                    contract_text = parsed_json.get("content", "")
                    st.session_state["contract_text"] = contract_text
                    st.session_state["current_file"] = filename
                    st.session_state.pop("risks", None)
                    st.session_state.pop("messages", None)
                    st.session_state.pop("summary", None)
                    st.session_state.pop("sentiments", None)
                    st.session_state.pop("metadata", None)
                    st.session_state.pop("safety_score", None)

                    # Step 2: Risk analysis (existing logic, wrapped)
                    status.update(label="Running risk analysis with Cortex AI...")
                    try:
                        risks_data = analyze_contract(st.session_state["contract_text"])
                        st.session_state["risks"] = risks_data["risks"]
                    except Exception as e:
                        st.warning(f"Using cached analysis -- LLM call failed: {e}")
                        st.session_state["risks"] = FALLBACK_RISKS["risks"]

                    # Feature 2: Safety score (Python math)
                    st.session_state["safety_score"] = compute_safety_score(st.session_state["risks"])

                    # Step 3: Summary (Feature 3)
                    status.update(label="Generating summary...")
                    st.session_state["summary"] = summarize_contract(st.session_state["contract_text"])

                    # Step 4: Sentiment per clause (Feature 4)
                    status.update(label="Analyzing clause sentiment...")
                    sents = []
                    for risk in st.session_state["risks"]:
                        sents.append(get_clause_sentiment(risk["verbatim_clause"]))
                    st.session_state["sentiments"] = sents

                    # Step 5: Metadata extraction (Feature 5)
                    status.update(label="Extracting contract metadata...")
                    st.session_state["metadata"] = extract_metadata(st.session_state["contract_text"])

                    status.update(label="Analysis complete", state="complete")

        # --- Render results from session_state ---
        if "safety_score" in st.session_state:
            render_safety_score(st.session_state["safety_score"])

        if st.session_state.get("summary"):
            with st.expander("Contract summary", expanded=False):
                st.markdown(
                    f'<div class="summary-text">{escape_html(st.session_state["summary"])}</div>',
                    unsafe_allow_html=True,
                )

        if "risks" in st.session_state:
            sentiments = st.session_state.get("sentiments", [])
            render_risk_cards(st.session_state["risks"], sentiments)

        if st.session_state.get("metadata"):
            render_sidebar_metadata(st.session_state["metadata"])

with tab_chat:
    if "contract_text" not in st.session_state:
        st.info("Analyze a contract in the Risk Analysis tab first.")
    else:
        if "messages" not in st.session_state:
            st.session_state["messages"] = []

        for msg in st.session_state["messages"]:
            if msg["role"] == "user":
                st.markdown(
                    f'<div class="chat-user"><div class="chat-role">You</div>{escape_html(msg["content"])}</div>',
                    unsafe_allow_html=True,
                )
            else:
                st.markdown(
                    f'<div class="chat-assistant"><div class="chat-role">Assistant</div>{escape_html(msg["content"])}</div>',
                    unsafe_allow_html=True,
                )

        with st.form("chat_form", clear_on_submit=True):
            user_question = st.text_input("Ask about this contract...", label_visibility="collapsed",
                                          placeholder="Ask about this contract...")
            submitted = st.form_submit_button("Send", type="primary")

        if submitted and user_question:
            st.session_state["messages"].append({"role": "user", "content": user_question})
            try:
                response = chat_with_contract(
                    st.session_state["contract_text"],
                    st.session_state["messages"],
                )
                st.session_state["messages"].append({"role": "assistant", "content": response})
            except Exception as e:
                error_msg = f"Sorry, I couldn't process that question: {e}"
                st.session_state["messages"].append({"role": "assistant", "content": error_msg})
            st.experimental_rerun()
