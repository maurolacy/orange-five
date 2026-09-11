// Single source of truth (shared.js, loaded before this script): the popup
// defaults are the POPUP_DEFAULTS subset of the full content-script DEFAULTS.
const DEFAULTS = window.__orangeFiveShared.POPUP_DEFAULTS;


// The "Selectivity" sliders are gone; drop their stale stored values so they
// can't linger in chrome.storage.sync.
chrome.storage.sync.remove(['orangeSense', 'pinkSense', 'cyanSense']);

const KEYS = [
  'enabled', 'orangeEnabled', 'pinkEnabled', 'cyanEnabled',
  'tableEnabled', 'tableDebug',
  'orangeSat', 'pinkSat', 'cyanSat',
];

const els = {
  enabled: document.getElementById('enabled'),
  orangeEnabled: document.getElementById('orangeEnabled'),
  pinkEnabled: document.getElementById('pinkEnabled'),
  cyanEnabled: document.getElementById('cyanEnabled'),
  tableEnabled: document.getElementById('tableEnabled'),
  tableDebug: document.getElementById('tableDebug'),
  tableSection: document.getElementById('tableSection'),
  orangeSection: document.getElementById('orangeSection'),
  pinkSection: document.getElementById('pinkSection'),
  cyanSection: document.getElementById('cyanSection'),
  orangeSat: document.getElementById('orangeSat'),
  orangeSatOut: document.getElementById('orangeSatOut'),
  pinkSat: document.getElementById('pinkSat'),
  pinkSatOut: document.getElementById('pinkSatOut'),
  cyanSat: document.getElementById('cyanSat'),
  cyanSatOut: document.getElementById('cyanSatOut'),
  reset: document.getElementById('reset'),
};

function fmt(n) {
  return Number(n).toFixed(2);
}

function readUi() {
  return {
    enabled: els.enabled.checked,
    orangeEnabled: els.orangeEnabled.checked,
    pinkEnabled: els.pinkEnabled.checked,
    cyanEnabled: els.cyanEnabled.checked,
    tableEnabled: els.tableEnabled.checked,
    tableDebug: els.tableDebug.checked,
    orangeSat: Number(els.orangeSat.value),
    pinkSat: Number(els.pinkSat.value),
    cyanSat: Number(els.cyanSat.value),
  };
}

function writeUi(settings) {
  els.enabled.checked = !!settings.enabled;
  els.orangeEnabled.checked = settings.orangeEnabled !== false;
  els.pinkEnabled.checked = settings.pinkEnabled !== false;
  els.cyanEnabled.checked = !!settings.cyanEnabled;
  els.tableEnabled.checked = settings.tableEnabled !== false;
  els.tableDebug.checked = !!settings.tableDebug;
  els.orangeSat.value = settings.orangeSat;
  els.pinkSat.value = settings.pinkSat;
  els.cyanSat.value = settings.cyanSat;
  syncOutputs();
  syncDisabledState();
}

function syncOutputs() {
  els.orangeSatOut.textContent = fmt(els.orangeSat.value);
  els.pinkSatOut.textContent = fmt(els.pinkSat.value);
  els.cyanSatOut.textContent = fmt(els.cyanSat.value);
}

function syncDisabledState() {
  const masterOff = !els.enabled.checked;
  document.body.classList.toggle('is-off', masterOff);
  els.tableSection.classList.toggle('is-disabled', masterOff);
  els.orangeSection.classList.toggle('is-disabled', masterOff || !els.orangeEnabled.checked);
  els.pinkSection.classList.toggle('is-disabled', masterOff || !els.pinkEnabled.checked);
  els.cyanSection.classList.toggle('is-disabled', masterOff || !els.cyanEnabled.checked);
}

// chrome.storage.sync allows ~120 writes/min — slider "input" fires far more often.
let saveTimer = null;

function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  syncOutputs();
  syncDisabledState();
  chrome.storage.sync.set(readUi());
}

function persistDebounced() {
  syncOutputs();
  syncDisabledState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.sync.set(readUi());
  }, 100);
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  const settings = {};
  for (const k of KEYS) settings[k] = stored[k] ?? DEFAULTS[k];
  writeUi(settings);
});

// Checkboxes / reset: write immediately
els.enabled.addEventListener('change', persistNow);
els.orangeEnabled.addEventListener('change', persistNow);
els.pinkEnabled.addEventListener('change', persistNow);
els.cyanEnabled.addEventListener('change', persistNow);
els.tableEnabled.addEventListener('change', persistNow);
els.tableDebug.addEventListener('change', persistNow);
els.reset.addEventListener('click', () => {
  writeUi(DEFAULTS);
  persistNow();
});

// Sliders: debounce while dragging, flush on release
['orangeSat', 'pinkSat', 'cyanSat'].forEach((id) => {
  els[id].addEventListener('input', persistDebounced);
  els[id].addEventListener('change', persistNow);
});
