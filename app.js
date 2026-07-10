// ==== API access ====
// All external API calls go through local /api serverless routes, which hold
// the real keys server-side (see api/openai-chat.js, api/openai-tts.js,
// api/semantic-scholar-search.js). No key ever lives in browser code.

let studyCache = {};
let noteCache = [];
let ttsAudio = null;

// Holds the raw (unrendered) text of the latest AI response per result element id.
// The visible box shows formatted HTML, but "Add to Notes" always saves this
// exact raw text so notes stay clean and reliably comparable for de-duplication.
const resultRawContent = {};

// ==== Project persistence (autosave / restore / export / import / reset) ====

const PROJECT_APP_ID = 'previous-studies-builder';
const PROJECT_SCHEMA_VERSION = 1;
const AUTOSAVE_DEBOUNCE_MS = 800;

// Topic + papers currently shown in the "Search Real Studies by Topic" section.
// Tracked separately from studyCache (which may hold several searched topics)
// because only the currently displayed search is part of the saved project.
let currentStudiesTopic = '';

// Structured glossary entries (term/meaning/japanese), kept in parallel with
// the visible #glossaryList so autosave/export never has to scrape HTML back
// into data.
let glossaryEntries = [];

let autosaveTimer = null;

// ==== Utility Functions ====

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineFormat(text) {
  return escapeHTML(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/**
 * Converts a lightweight Markdown subset (headings, numbered lists with
 * nested bullets, plain bullets, bold text, paragraphs) into safe HTML so
 * AI responses render as readable sections instead of one text block.
 * Unrecognized text just becomes paragraphs with preserved line breaks.
 */
function renderMarkdownLite(raw) {
  if (!raw) return "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  let html = "";
  let i = 0;
  let paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length) {
      html += `<p>${paragraphBuffer.map(inlineFormat).join("<br>")}</p>`;
      paragraphBuffer = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      i++;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = Math.min(headingMatch[1].length + 1, 4);
      html += `<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`;
      i++;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      html += "<ol>";
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^\d+\.\s+/, "");
        i++;
        let nested = "";
        while (i < lines.length && /^\s+[-*]\s+/.test(lines[i])) {
          nested += `<li>${inlineFormat(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>`;
          i++;
        }
        html += `<li>${inlineFormat(itemText)}${nested ? `<ul>${nested}</ul>` : ""}</li>`;
      }
      html += "</ol>";
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      html += "<ul>";
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        html += `<li>${inlineFormat(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>`;
        i++;
      }
      html += "</ul>";
      continue;
    }

    paragraphBuffer.push(trimmed);
    i++;
  }

  flushParagraph();
  return html;
}

/**
 * Returns an <li>'s own text, excluding any nested <ul>/<ol> (subtopics,
 * or anything else nested one level down) and excluding any copy button
 * already appended to it.
 */
function ownListItemText(li) {
  const clone = li.cloneNode(true);
  clone.querySelectorAll('ul, ol, .copyItemBtn').forEach(el => el.remove());
  return clone.textContent.trim();
}

function makeCopyButton(getText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copyItemBtn';
  btn.textContent = '📋 Copy';
  btn.onclick = () => {
    const text = getText();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const original = btn.textContent;
      btn.textContent = '✅ Copied';
      setTimeout(() => { btn.textContent = original; }, 1200);
    });
  };
  return btn;
}

// Returns the sibling elements between `headingText` (matched case-insensitively)
// and the next heading of the same or shallower level, so a section's content
// can be processed without touching sections before or after it.
function getSectionElements(container, headingText) {
  const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  const heading = headings.find(h => h.textContent.trim().toLowerCase() === headingText.toLowerCase());
  if (!heading) return [];
  const level = Number(heading.tagName[1]);
  const elements = [];
  let node = heading.nextElementSibling;
  while (node) {
    const match = /^H([1-6])$/.exec(node.tagName);
    if (match && Number(match[1]) <= level) break;
    elements.push(node);
    node = node.nextElementSibling;
  }
  return elements;
}

function attachCopyButtonsToLists(root) {
  root.querySelectorAll('li').forEach(li => {
    const hasOwnButton = Array.from(li.children).some(child => child.classList.contains('copyItemBtn'));
    if (hasOwnButton) return;
    const text = ownListItemText(li);
    if (!text) return;
    const button = makeCopyButton(() => ownListItemText(li));
    // Insert right after the li's own text and before any nested subtopic
    // list, so the button sits next to its own line, not below its children.
    const nestedList = li.querySelector(':scope > ul, :scope > ol');
    if (nestedList) {
      li.insertBefore(button, nestedList);
    } else {
      li.appendChild(button);
    }
  });
}

// Adds a "Copy" button to each Topic, Subtopic, and Search Query line inside
// the Introduction Analysis result box, scoped only to those two sections.
function addReuseCopyButtons(container) {
  getSectionElements(container, 'Suggested Literature Topics').forEach(attachCopyButtonsToLists);
  getSectionElements(container, 'Possible Search Queries').forEach(attachCopyButtonsToLists);
}

// ---- Save-status indicator ----

function showSaveStatus(text, isError = false) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('save-status-error', !!isError);
}

// ---- Debounced autosave ----
// Only ever reads from committed state (resultRawContent, currentStudiesTopic,
// studyCache, notes/references/glossary already in the DOM) -- never from a
// transient "Thinking..."/"Searching..." placeholder -- so loading messages
// are never persisted.

function scheduleAutosave(delay = AUTOSAVE_DEBOUNCE_MS) {
  showSaveStatus('Saving...');
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(performAutosave, delay);
}

async function performAutosave() {
  try {
    const payload = buildAutosavePayload();
    await ProjectDB.saveProject(payload);
    const time = new Date(payload.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    showSaveStatus(`Saved automatically at ${time}`);
  } catch (err) {
    console.error('Autosave failed:', err);
    showSaveStatus('Save failed', true);
  }
}

// ---- Project data: build / normalize / apply ----

function buildProjectData() {
  const notes = Array.from(document.getElementById('notesList').querySelectorAll('li[data-note-text]'))
    .map(li => li.dataset.noteText);
  const references = Array.from(document.getElementById('referencesList').children)
    .map(li => li.textContent);

  return {
    introduction: document.getElementById('introduction').value,
    introductionAnalysisRaw: resultRawContent['analyzeIntroductionResult'] || '',
    authorInput: document.getElementById('authorInput').value,
    currentStudiesTopic: currentStudiesTopic,
    currentStudies: currentStudiesTopic ? (studyCache[currentStudiesTopic] || []) : [],
    authorSuggestionsRaw: resultRawContent['authorSuggestions'] || '',
    generalChat: document.getElementById('generalChat').value,
    generalChatResultRaw: resultRawContent['generalChatResult'] || '',
    notes: notes,
    suggestedFullSectionRaw: resultRawContent['suggestedFullSection'] || '',
    references: references,
    glossary: glossaryEntries.slice()
  };
}

function buildAutosavePayload() {
  return {
    appId: PROJECT_APP_ID,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    ...buildProjectData()
  };
}

function buildExportPayload() {
  return {
    appId: PROJECT_APP_ID,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    ...buildProjectData()
  };
}

// Fills in sensible defaults for any missing/malformed field, so older or
// hand-edited project files still load instead of crashing the restore.
function normalizeProjectData(raw) {
  const r = raw || {};
  const isString = (v) => typeof v === 'string';
  return {
    schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : PROJECT_SCHEMA_VERSION,
    lastSavedAt: r.savedAt || r.exportedAt || null,
    introduction: isString(r.introduction) ? r.introduction : '',
    introductionAnalysisRaw: isString(r.introductionAnalysisRaw) ? r.introductionAnalysisRaw : '',
    authorInput: isString(r.authorInput) ? r.authorInput : '',
    currentStudiesTopic: isString(r.currentStudiesTopic) ? r.currentStudiesTopic : '',
    currentStudies: Array.isArray(r.currentStudies) ? r.currentStudies : [],
    authorSuggestionsRaw: isString(r.authorSuggestionsRaw) ? r.authorSuggestionsRaw : '',
    generalChat: isString(r.generalChat) ? r.generalChat : '',
    generalChatResultRaw: isString(r.generalChatResultRaw) ? r.generalChatResultRaw : '',
    notes: Array.isArray(r.notes) ? r.notes.filter(isString) : [],
    suggestedFullSectionRaw: isString(r.suggestedFullSectionRaw) ? r.suggestedFullSectionRaw : '',
    references: Array.isArray(r.references) ? r.references.filter(isString) : [],
    glossary: Array.isArray(r.glossary)
      ? r.glossary.filter(g => g && typeof g === 'object').map(g => ({
          term: isString(g.term) ? g.term : '',
          meaning: isString(g.meaning) ? g.meaning : '',
          japanese: isString(g.japanese) ? g.japanese : ''
        }))
      : []
  };
}

function clearRealNotes() {
  document.querySelectorAll('#notesList li[data-note-text]').forEach(li => li.remove());
}

// Appends a note exactly like the original "Add to Notes" button did:
// de-duplicated by exact text, with its own Delete button.
// Pass { silent: true } during restore/import so a duplicate (which
// shouldn't normally happen, since saved notes were already de-duplicated)
// doesn't pop up an alert mid-restore.
function addNoteToList(text, options = {}) {
  const notesList = document.getElementById("notesList");
  const isDuplicate = Array.from(notesList.querySelectorAll("li[data-note-text]"))
    .some(li => li.dataset.noteText === text);

  if (isDuplicate) {
    if (!options.silent) alert("This note has already been saved.");
    return;
  }

  const li = document.createElement("li");
  li.dataset.noteText = text;

  const noteBody = document.createElement("span");
  noteBody.className = "note-text";
  noteBody.textContent = text;

  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "🗑️ Delete";
  deleteBtn.className = "deleteNoteBtn";
  deleteBtn.onclick = () => {
    li.remove();
    scheduleAutosave();
  };

  li.appendChild(noteBody);
  li.appendChild(deleteBtn);
  notesList.appendChild(li);

  if (!options.silent) scheduleAutosave();
}

// Adds one glossary entry to both the visible list and the structured
// glossaryEntries array used for autosave/export.
function addGlossaryEntryToList(term, meaning, japanese, options = {}) {
  const li = document.createElement("li");
  li.innerHTML = `<strong>${escapeHTML(term)}</strong><br>
  <em>${escapeHTML(meaning)}</em><br>
  <span>${escapeHTML(japanese)}</span>`;
  document.getElementById("glossaryList").appendChild(li);
  glossaryEntries.push({ term, meaning, japanese });
  if (!options.silent) scheduleAutosave();
}

const DEFAULT_FULL_SECTION_MESSAGE = 'Click the button below to generate your "Previous Studies and Related Topics" section.';

// Applies a normalized project snapshot to the page. Used by page-load
// restore, Import, and Reset (with an all-empty snapshot) alike.
function applyProjectSnapshot(rawData) {
  const s = normalizeProjectData(rawData);

  document.getElementById('introduction').value = s.introduction;

  const introEl = document.getElementById('analyzeIntroductionResult');
  resultRawContent[introEl.id] = s.introductionAnalysisRaw;
  introEl.innerHTML = s.introductionAnalysisRaw ? renderMarkdownLite(s.introductionAnalysisRaw) : '';
  if (s.introductionAnalysisRaw) addReuseCopyButtons(introEl);

  document.getElementById('authorInput').value = s.authorInput;
  currentStudiesTopic = s.currentStudiesTopic;
  const studyBox = document.getElementById('authorStudiesBox');
  if (s.currentStudiesTopic && s.currentStudies.length) {
    studyCache[s.currentStudiesTopic] = s.currentStudies;
    renderStudies(s.currentStudies, studyBox);
  } else {
    studyBox.innerHTML = '';
  }

  const suggestionsEl = document.getElementById('authorSuggestions');
  resultRawContent[suggestionsEl.id] = s.authorSuggestionsRaw;
  suggestionsEl.innerHTML = s.authorSuggestionsRaw ? renderMarkdownLite(s.authorSuggestionsRaw) : '';

  document.getElementById('generalChat').value = s.generalChat;
  const chatEl = document.getElementById('generalChatResult');
  resultRawContent[chatEl.id] = s.generalChatResultRaw;
  chatEl.innerHTML = s.generalChatResultRaw ? renderMarkdownLite(s.generalChatResultRaw) : '';

  clearRealNotes();
  s.notes.forEach(noteText => addNoteToList(noteText, { silent: true }));

  const fullSectionEl = document.getElementById('suggestedFullSection');
  resultRawContent[fullSectionEl.id] = s.suggestedFullSectionRaw;
  fullSectionEl.innerHTML = s.suggestedFullSectionRaw
    ? renderMarkdownLite(s.suggestedFullSectionRaw)
    : DEFAULT_FULL_SECTION_MESSAGE;

  const referencesList = document.getElementById('referencesList');
  referencesList.innerHTML = '';
  s.references.forEach(ref => {
    const li = document.createElement('li');
    li.textContent = ref;
    referencesList.appendChild(li);
  });

  document.getElementById('glossaryList').innerHTML = '';
  glossaryEntries = [];
  s.glossary.forEach(entry => addGlossaryEntryToList(entry.term, entry.meaning, entry.japanese, { silent: true }));
}

function hasExistingWork() {
  const d = buildProjectData();
  return !!(
    d.introduction || d.introductionAnalysisRaw || d.authorInput || d.authorSuggestionsRaw ||
    d.generalChat || d.generalChatResultRaw || d.notes.length || d.suggestedFullSectionRaw ||
    d.references.length || d.glossary.length
  );
}

// ---- Generic confirmation modal (reused for restore/import-replace/reset) ----

function showConfirmModal({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  const overlay = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMessage').textContent = message;
  const confirmBtn = document.getElementById('confirmModalConfirmBtn');
  const cancelBtn = document.getElementById('confirmModalCancelBtn');
  confirmBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;

  const cleanup = () => {
    overlay.style.display = 'none';
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
  };
  confirmBtn.onclick = () => { cleanup(); if (onConfirm) onConfirm(); };
  cancelBtn.onclick = () => { cleanup(); if (onCancel) onCancel(); };
  overlay.style.display = 'flex';
}

// ---- Export / Import ----

function exportProjectAsJSON() {
  const payload = buildExportPayload();
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `previous-studies-project_${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Returns an error message string if invalid, or null if the file looks like
// a genuine Previous Studies Builder project.
function validateProjectFile(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'This file does not contain a valid JSON project object.';
  }
  if (parsed.appId === PROJECT_APP_ID) {
    return null;
  }
  if (typeof parsed.schemaVersion !== 'number') {
    return 'This does not look like a Previous Studies Builder project file (missing schemaVersion).';
  }
  const knownFields = ['introduction', 'introductionAnalysisRaw', 'authorInput', 'notes', 'suggestedFullSectionRaw', 'references', 'glossary'];
  const hasAnyKnownField = knownFields.some(f => Object.prototype.hasOwnProperty.call(parsed, f));
  if (!hasAnyKnownField) {
    return 'This file does not contain recognizable Previous Studies Builder project data.';
  }
  return null;
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (err) {
      alert('Import failed: this file is not valid JSON.');
      return;
    }

    const validationError = validateProjectFile(parsed);
    if (validationError) {
      alert(`Import failed: ${validationError}`);
      return;
    }

    const doImport = async () => {
      const normalized = normalizeProjectData(parsed);
      applyProjectSnapshot(normalized);
      try {
        await ProjectDB.saveProject(buildAutosavePayload());
        showSaveStatus('Project imported and saved.');
      } catch (err) {
        console.error('Failed to save imported project:', err);
        showSaveStatus('Save failed', true);
      }
      alert('Project imported successfully.');
    };

    if (hasExistingWork()) {
      showConfirmModal({
        title: 'Replace current work?',
        message: 'This will replace all current project data.',
        confirmLabel: 'Import and Replace',
        cancelLabel: 'Cancel',
        onConfirm: doImport
      });
    } else {
      doImport();
    }
  };
  reader.onerror = () => alert('Import failed: could not read the file.');
  reader.readAsText(file);
}

/**
 * Formats a paper's bibliographic information into a full APA style reference.
 * Handles journal names that might be objects.
 * @param {object} paper - The paper object from Semantic Scholar.
 * @returns {string} The full APA formatted reference string.
 */
function formatAPA(paper) {
  const authors = paper.authors.map(a => a.name).join(', ');
  let journalName = 'Journal Name'; // Default fallback
  if (paper.journal) {
    if (typeof paper.journal === 'string') {
      journalName = paper.journal;
    } else if (typeof paper.journal === 'object' && paper.journal.name) {
      journalName = paper.journal.name;
    }
  }
  return `${authors} (${paper.year}). ${paper.title}. ${journalName}, Retrieved from ${paper.url}`;
}

/**
 * Formats a list of authors for an APA in-text citation.
 * Applies "et al." rules for 3+ authors.
 * @param {Array<object>} authorsArray - An array of author objects ({name: "..."}).
 * @returns {string} The formatted author string for in-text citation.
 */
function formatInTextCitationAuthors(authorsArray) {
  if (!authorsArray || authorsArray.length === 0) {
    return "Anonymous";
  }
  const lastNames = authorsArray.map(a => a.name.split(' ').pop()); // Get last names

  if (lastNames.length === 1) {
    return lastNames[0];
  } else if (lastNames.length === 2) {
    return `${lastNames[0]} & ${lastNames[1]}`;
  } else {
    // For 3 or more authors, APA style uses et al.
    return `${lastNames[0]} et al.`;
  }
}

async function callOpenAI(prompt, resultElement, options = {}) {
  resultElement.textContent = '🧠 Thinking...';
  try {
    const response = await fetch("/api/openai-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        model: options.model || "gpt-4",
        max_tokens: options.max_tokens || 800,
        temperature: options.temperature === undefined ? 0.7 : options.temperature
      })
    });
    const data = await response.json();
    if (response.ok && data.content) {
      resultRawContent[resultElement.id] = data.content;
      resultElement.innerHTML = renderMarkdownLite(data.content);
    } else {
      resultRawContent[resultElement.id] = "";
      resultElement.innerHTML = `<p class="ai-error">⚠️ ${escapeHTML(data.error || "No response from OpenAI.")}</p>`;
    }
  } catch (error) {
    resultRawContent[resultElement.id] = "";
    resultElement.innerHTML = '<p class="ai-error">⚠️ Error calling OpenAI. Check your connection and try again.</p>';
    console.error(error);
  }
  scheduleAutosave();
}

async function playTextWithOpenAITTS(text, voice = "alloy") {
  try {
    const response = await fetch("/api/openai-tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text, voice })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      alert(`⚠️ ${data.error || "Could not generate audio."}`);
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (ttsAudio) ttsAudio.pause();
    ttsAudio = new Audio(URL.createObjectURL(new Blob([arrayBuffer])));
    ttsAudio.play();
  } catch (error) {
    console.error("TTS error:", error);
    alert("⚠️ Error generating audio. Check your connection and try again.");
  }
}

function makeDraggable(popup) {
  let isDragging = false;
  let offsetX, offsetY;

  popup.addEventListener("mousedown", (e) => {
    if (e.target.tagName !== "H3") return;
    isDragging = true;
    offsetX = e.clientX - popup.getBoundingClientRect().left;
    offsetY = e.clientY - popup.getBoundingClientRect().top;
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    popup.style.left = `${e.clientX - offsetX}px`;
    popup.style.top = `${e.clientY - offsetY}px`;
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
}
async function fetchGlossaryDefinitions(term) {
  const prompt = `
You are a bilingual glossary generator for academic English.

1. Define this term in simple, clear English.
2. Then explain its meaning specifically in the context of social science or thesis writing, if relevant.
3. Finally, give a short Japanese translation (not translation of the explanation—just the equivalent meaning in Japanese).

TERM: "${term}"

Respond in this format:

Definition: [English explanation]
Contextual Meaning: [Field-specific clarification]
Japanese: [Japanese equivalent]
`;

  try {
    const response = await fetch("/api/openai-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        temperature: 0.3,
        max_tokens: 300
      })
    });

    const data = await response.json();

    if (!response.ok) {
      document.getElementById("glossaryEnglish").textContent = data.error || "Error fetching definition.";
      document.getElementById("glossaryJapanese").textContent = "エラー";
      return;
    }

    const content = data.content || "";

    // Parse response
    const enMatch = content.match(/Definition:\s*(.+)/i);
    const jpMatch = content.match(/Japanese:\s*(.+)/i);

    document.getElementById("glossaryEnglish").textContent = enMatch?.[1]?.trim() || "No definition.";
    document.getElementById("glossaryJapanese").textContent = jpMatch?.[1]?.trim() || "日本語訳なし";

  } catch (err) {
    console.error("Glossary fetch error:", err);
    document.getElementById("glossaryEnglish").textContent = "Error fetching definition.";
    document.getElementById("glossaryJapanese").textContent = "エラー";
  }
}
// ==== Main Setup ====
document.addEventListener("DOMContentLoaded", () => {

  document.getElementById("sendGeneralChat").onclick = () => {
    const userMessage = document.getElementById("generalChat").value.trim();
    if (!userMessage) return alert("Please enter your request.");

    const prompt = `You are an academic writing expert helping a student improve their writing or argumentation.

Here is the user's request or question:
"${userMessage}"

Provide a clear, structured, academic explanation or advice. If applicable, include writing examples, citation suggestions, or conceptual clarification.`;

    callOpenAI(prompt, document.getElementById("generalChatResult"));
  };

  makeDraggable(document.getElementById("glossaryPopup"));

  // Debounced autosave on free-text typing (Introduction, Topic search, General Chat).
  document.getElementById("introduction").addEventListener("input", () => scheduleAutosave());
  document.getElementById("authorInput").addEventListener("input", () => scheduleAutosave());
  document.getElementById("generalChat").addEventListener("input", () => scheduleAutosave());

  document.getElementById("analyzeIntroduction").onclick = () => {
    const intro = document.getElementById("introduction").value.trim();
    if (!intro) return alert("Please paste your introduction.");
    const prompt = `You are an academic writing assistant. Analyze the following thesis introduction and respond using EXACTLY this Markdown structure and these five headings, in this order, each starting with "## ":

## Clarity and Coherence
(A short paragraph or bullet list evaluating clarity and coherence)

## Academic Structure
(A short paragraph or bullet list evaluating the strength of the academic structure)

## Suggestions for Improvement
(A bullet list of concrete, actionable suggestions, one per line starting with "- ")

## Suggested Literature Topics
(A numbered list of 2-4 related topics; under each topic, add 2-3 nested subtopics as indented bullet lines, like:
1. Topic Title
   - Subtopic A
   - Subtopic B
2. Another Topic Title
   - Subtopic A
   - Subtopic B
)

## Possible Search Queries
(For EACH topic listed above, repeat its exact title as a sub-heading starting with "### ", followed by 4-6 bullet lines (starting with "- ") giving alternative search queries likely to retrieve relevant studies on Semantic Scholar. These must be realistic multi-word search phrases, not single keywords. Vary specificity: include some queries that closely match the topic, some that use common research terminology, and some that use related constructs, so the student can try several searches. Optimize purely for discoverability, not grammatical readability -- imperfect English phrasing is fine. Format exactly like:
### Topic Title
- search query phrase one
- search query phrase two
- search query phrase three
- search query phrase four
### Another Topic Title
- search query phrase one
- search query phrase two
...
)

Do not add any headings, sections, or commentary other than these five.

Here is the introduction:
"${intro}"`;
    callOpenAI(prompt, document.getElementById("analyzeIntroductionResult")).then(() => {
      addReuseCopyButtons(document.getElementById("analyzeIntroductionResult"));
    });
  };

  document.getElementById("clearSearch").onclick = () => {
    const input = document.getElementById("authorInput");
    const studyBox = document.getElementById("authorStudiesBox");
    const suggestionsBox = document.getElementById("authorSuggestions");
    input.value = "";
    studyBox.innerHTML = "";
    suggestionsBox.innerHTML = "";
    resultRawContent[suggestionsBox.id] = "";
    currentStudiesTopic = "";
    input.focus();
    scheduleAutosave();
  };

  document.getElementById("refineIdeas").onclick = async () => {
    const topic = document.getElementById("authorInput").value.trim();
    const box = document.getElementById("authorSuggestions");
    const studyBox = document.getElementById("authorStudiesBox");
    if (!topic) return alert("Please enter a topic.");
    studyBox.textContent = '🔎 Now fetching studies...';
    if (studyCache[topic]) {
      currentStudiesTopic = topic;
      renderStudies(studyCache[topic], studyBox);
      generateNote(topic, studyCache[topic], box);
      scheduleAutosave();
    } else {
      const url = `/api/semantic-scholar-search?topic=${encodeURIComponent(topic)}`;
      try {
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) {
          studyBox.textContent = `⚠️ ${data.error || "Error fetching studies."}`;
          return;
        }
        if (data.warning) console.warn(data.warning);
        if (data.data && data.data.length) {
          studyCache[topic] = data.data;
          currentStudiesTopic = topic;
          renderStudies(data.data, studyBox);
          generateNote(topic, data.data, box);
          scheduleAutosave();
        } else {
          studyBox.textContent = "No studies found.";
        }
      } catch (err) {
        studyBox.textContent = "Error fetching studies.";
        console.error(err);
      }
    }
  };

  function generateNote(topic, papers, box) {
    const formattedStudies = papers.map(formatAPA).join("\n");
    
    let numberedStudiesPrompt = [];
    let suggestedSentenceInTextCitations = [];

    papers.forEach((p, i) => {
        numberedStudiesPrompt.push(`${i + 1}. ${formatAPA(p)}`);
        suggestedSentenceInTextCitations.push(`${formatInTextCitationAuthors(p.authors)} (${p.year})`);
    });
    
    const inTextCitationsExample = suggestedSentenceInTextCitations.join(" and ");

    const prompt = `You are an academic writing assistant.\n\nHere is a topic: "${topic}"\nAnd these are real academic studies related to it:\n${formattedStudies}\n\nWrite a note that includes:\n🔹 Topic: ${topic}\n📚 Study: (LIST THESE STUDIES EXACTLY AS PROVIDED BELOW, DO NOT REPHRASE OR ALTER, ENSURE EACH IS NUMBERED AND ON A NEW LINE)\n${numberedStudiesPrompt.join('\n')}\n📝 Suggested sentence: [A sample sentence showing how these studies could be used in academic writing, using in-text citations like: "${inTextCitationsExample}". IMPORTANT: Ensure all in-text citations follow APA format: "Lastname (Year)" for one author, "Lastname & Lastname (Year)" for two authors, "Lastname et al. (Year)" for three or more authors. ALWAYS include the year in parentheses after the authors for in-text citations.]\n\nDo not invent any sources. Only use what is listed.`;
    box.textContent = '📝 Generating writing suggestion...';
    callOpenAI(prompt, box);
  }


  document.getElementById("generateFullSection").onclick = () => {
    const intro = document.getElementById("introduction").value.trim();
    const notes = Array.from(document.getElementById("notesList").querySelectorAll("li[data-note-text]"))
      .map(li => li.dataset.noteText)
      .join("\n\n");
    const prompt = `You are an academic writing assistant.\n\nWrite a cohesive academic section titled \"Previous Studies and Related Topics\" for a student's thesis.\n\nStart from the student's research theme and introduction:\n\"${intro}\"\n\nThen, integrate the following real research notes collected by the student.\n\nEach note includes:\n- A topic\n- A real study (APA format)\n- A suggestion for how the study might support the paper\n\nYour task:\n1. Write as if you are the student.\n2. Use formal academic style and structure.\n3. Integrate the studies naturally — not just list them.\n4. Show how they support the purpose of the current study.\n5. Do not invent any additional sources or assumptions.\n\nHere are the notes:\n${notes}\n\nWrite the entire section in a unified paragraph flow.`;
    
    // Call OpenAI to generate the section. Use .then() to ensure updateReferencesFromNotes runs AFTER the AI response.
    callOpenAI(prompt, document.getElementById("suggestedFullSection")).then(() => {
      updateReferencesFromNotes();
      scheduleAutosave();
    });
  };


  document.querySelectorAll(".addNoteBtn").forEach(btn => {
    btn.onclick = () => {
      const targetId = btn.dataset.target;
      const text = (resultRawContent[targetId] || "").trim();
      if (!text) {
        alert("No content to save as note.");
        return;
      }
      addNoteToList(text);
    };
  });

  function setupGlossary() {
    document.querySelectorAll(".whatDoesItMean").forEach(btn => {
      btn.onclick = () => {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        if (!selectedText) return alert("Please highlight a word or phrase first.");

        const popup = document.getElementById("glossaryPopup");
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        popup.style.left = `${rect.left + window.scrollX}px`;
        popup.style.top = `${rect.bottom + window.scrollY + 10}px`;
        popup.style.display = "block";

        document.getElementById("glossaryTerm").textContent = selectedText;
        fetchGlossaryDefinitions(selectedText);
      };
    });
  }
  setupGlossary();

  document.getElementById("closeGlossary").onclick = () => {
    document.getElementById("glossaryPopup").style.display = "none";
  };

  document.getElementById("playIt").onclick = () => {
    const text = document.getElementById("glossaryTerm").textContent;
    if (!text) return alert("No term to read.");
    playTextWithOpenAITTS(text);
  };

  document.getElementById("addToGlossary").onclick = () => {
    const term = document.getElementById("glossaryTerm").textContent;
    const meaning = document.getElementById("glossaryEnglish").textContent;
    const japanese = document.getElementById("glossaryJapanese").textContent;
    addGlossaryEntryToList(term, meaning, japanese);
  };

  document.getElementById("copyToClipboard").onclick = () => {
    const text = `Phrase: ${document.getElementById("glossaryTerm").textContent}
Meaning (EN): ${document.getElementById("glossaryEnglish").textContent}
Meaning (JP): ${document.getElementById("glossaryJapanese").textContent}`;
    navigator.clipboard.writeText(text).then(() => alert("Copied to clipboard!"));
  };

  // Add the event listener for the "Save My Work" button
  document.getElementById("saveWork").onclick = downloadHTMLFile;

  // ---- Export / Import / Reset Project ----

  document.getElementById("exportProjectBtn").onclick = exportProjectAsJSON;

  document.getElementById("importProjectBtn").onclick = () => {
    document.getElementById("importFileInput").click();
  };

  document.getElementById("importFileInput").onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = ""; // allow re-selecting the same file later
  };

  document.getElementById("resetProjectBtn").onclick = () => {
    showConfirmModal({
      title: "Reset this project?",
      message: "This will delete the current work stored in this browser.",
      confirmLabel: "Reset Project",
      cancelLabel: "Cancel",
      onConfirm: async () => {
        applyProjectSnapshot({});
        try {
          await ProjectDB.deleteProject();
          showSaveStatus("Project reset.");
        } catch (err) {
          console.error("Failed to clear saved project:", err);
          showSaveStatus("Save failed", true);
        }
      }
    });
  };

  // ---- Restore previous work on page load ----

  (async function checkForSavedProject() {
    let saved = null;
    try {
      saved = await ProjectDB.loadProject();
    } catch (err) {
      console.error("Failed to check for a saved project:", err);
    }
    if (!saved) return;

    const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : "an earlier session";
    showConfirmModal({
      title: "📁 Previous work found",
      message: `Last saved: ${when}`,
      confirmLabel: "Continue Previous Work",
      cancelLabel: "Start a New Project",
      onConfirm: () => {
        applyProjectSnapshot(saved);
        showSaveStatus("Previous work restored.");
      },
      onCancel: () => {
        showConfirmModal({
          title: "Delete previous project?",
          message: "This will permanently delete your previously saved work stored in this browser.",
          confirmLabel: "Delete and Start New",
          cancelLabel: "Cancel",
          onConfirm: async () => {
            try {
              await ProjectDB.deleteProject();
              showSaveStatus("Previous project deleted.");
            } catch (err) {
              console.error("Failed to delete saved project:", err);
              showSaveStatus("Save failed", true);
            }
          }
        });
      }
    });
  })();

}); // End of DOMContentLoaded

function downloadHTMLFile() {
  const intro = document.getElementById("introduction").value.trim();
  const fullSection = document.getElementById("suggestedFullSection").textContent.trim();

  const glossaryHTML = Array.from(document.querySelectorAll("#glossaryList li"))
    .map(li => `<li>${li.innerHTML}</li>`).join('\n');

  const referencesHTML = Array.from(document.querySelectorAll("#referencesList li"))
    .map(li => li.outerHTML).join('\n');

  const content = `<!DOCTYPE html>
<html>
<head>
  <meta charset=\"UTF-8\">
  <title>Saved Thesis Work</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 40px; }
    h1, h2 { color: #003366; }
    section { margin-bottom: 40px; }
    ul { padding-left: 20px; }
  </style>
</head>
<body>
  <h1>Thesis Writing Output</h1>
  <section><h2>📄 Introduction</h2><p>${intro}</p></section>
  <section><h2>📚 Previous Studies and Related Topics</h2><p>${fullSection}</p></section>
  <section><h2>📖 References (APA)</h2><ul>${referencesHTML}</ul></section>
  <section><h2>📘 Glossary</h2><ul>${glossaryHTML}</ul></section>
</body>
</html>`;

  const blob = new Blob([content], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "thesis_work.html";
  a.click();
  URL.revokeObjectURL(url);
}
function renderStudies(studies, container) {
  container.innerHTML = studies.map(paper => `
    <div class='paper-suggestion'>
      <h4><a href=\"${paper.url}\" target=\"_blank\">${paper.title}</a></h4>
      <p><strong>Authors:</strong> ${paper.authors.map(a => a.name).join(', ')}</p>
      <p><strong>Year:</strong> ${paper.year}</p>
      <p>${paper.abstract ? paper.abstract.slice(0, 200) + '...' : 'No abstract available.'}</p>
    </div>
  `).join('');
}

/**
 * Extracts APA-formatted references from the Personal Notes list.
 * This is a more reliable approach since notes are expected to contain the full APA strings.
 */
function updateReferencesFromNotes() {
  const notesList = document.getElementById("notesList");
  const referencesList = document.getElementById("referencesList");
  referencesList.innerHTML = ''; // Clear existing references

  const uniqueReferences = new Set();

  // Regex to broadly capture each numbered APA line within the note content.
  // This first stage extracts lines that look like: "X. Authors (Year). Title. Journal, Retrieved from URL"
  const rawApaLineRegex = /\d+\.\s*([A-Za-z\s.,&'\-—–—-]+?)\s*\(\s*(\d{4})\s*\)\.\s*([^.]+?)\.\s*([^,]+?)(?:,\s*(?:Retrieved from|Available from)?)?\s*(https?:\/\/[^\s]+)/g;

  Array.from(notesList.querySelectorAll("li[data-note-text]")).forEach(noteItem => {
    const noteText = noteItem.dataset.noteText;
    console.log("Processing noteText:\n", noteText); // DEBUG: Logs the exact text of each note for inspection

    let match;
    // Reset lastIndex for the regex for each new string processed
    rawApaLineRegex.lastIndex = 0; 
    while ((match = rawApaLineRegex.exec(noteText)) !== null) {
        // Reconstruct the full APA string from captured groups, trimming whitespace
        // Group 4 (Journal/Source) might contain extra commas or "Retrieved from" if the optional part matched nothing.
        const authors = match[1].trim();
        const year = match[2];
        const title = match[3].trim();
        const journalPart = match[4].trim().replace(/,\s*$/, ''); // Remove trailing comma if present
        const url = match[5];

        const fullReference = `${authors} (${year}). ${title}. ${journalPart}, Retrieved from ${url}`;
        uniqueReferences.add(fullReference);
        console.log("Found APA match:", fullReference); // DEBUG: Logs successfully found APA references
    }
  });

  if (uniqueReferences.size === 0) {
      console.warn("No APA references found in notes. Ensure notes contain numbered APA lines."); // DEBUG: Warns if no references are found
  }

  uniqueReferences.forEach(ref => {
    const li = document.createElement("li");
    li.textContent = ref;
    referencesList.appendChild(li);
  });
}