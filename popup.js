const DEFAULTS = {
  enabled: true,
  orangeSat: 0.78,
  orangeSense: 0.55,
  pinkSat: 0.65,
  pinkSense: 0.55,
};

const KEYS = ['enabled', 'orangeSat', 'orangeSense', 'pinkSat', 'pinkSense'];

const els = {
  enabled: document.getElementById('enabled'),
  orangeSat: document.getElementById('orangeSat'),
  orangeSatOut: document.getElementById('orangeSatOut'),
  orangeSense: document.getElementById('orangeSense'),
  orangeSenseOut: document.getElementById('orangeSenseOut'),
  pinkSat: document.getElementById('pinkSat'),
  pinkSatOut: document.getElementById('pinkSatOut'),
  pinkSense: document.getElementById('pinkSense'),
  pinkSenseOut: document.getElementById('pinkSenseOut'),
  reset: document.getElementById('reset'),
};

function fmt(n) {
  return Number(n).toFixed(2);
}

function readUi() {
  return {
    enabled: els.enabled.checked,
    orangeSat: Number(els.orangeSat.value),
    orangeSense: Number(els.orangeSense.value),
    pinkSat: Number(els.pinkSat.value),
    pinkSense: Number(els.pinkSense.value),
  };
}

function writeUi(settings) {
  els.enabled.checked = !!settings.enabled;
  els.orangeSat.value = settings.orangeSat;
  els.orangeSense.value = settings.orangeSense;
  els.pinkSat.value = settings.pinkSat;
  els.pinkSense.value = settings.pinkSense;
  syncOutputs();
  document.body.classList.toggle('is-off', !settings.enabled);
}

function syncOutputs() {
  els.orangeSatOut.textContent = fmt(els.orangeSat.value);
  els.orangeSenseOut.textContent = fmt(els.orangeSense.value);
  els.pinkSatOut.textContent = fmt(els.pinkSat.value);
  els.pinkSenseOut.textContent = fmt(els.pinkSense.value);
}

function persistAndBroadcast() {
  const settings = readUi();
  document.body.classList.toggle('is-off', !settings.enabled);
  syncOutputs();
  chrome.storage.sync.set(settings);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'pool-color-update', settings }).catch(() => {});
  });
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  const settings = {};
  for (const k of KEYS) settings[k] = stored[k] ?? DEFAULTS[k];
  writeUi(settings);
});

els.enabled.addEventListener('change', persistAndBroadcast);
['orangeSat', 'orangeSense', 'pinkSat', 'pinkSense'].forEach((id) => {
  els[id].addEventListener('input', persistAndBroadcast);
});

els.reset.addEventListener('click', () => {
  writeUi(DEFAULTS);
  persistAndBroadcast();
});
