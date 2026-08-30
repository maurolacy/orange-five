const DEFAULTS = {
  enabled: true,
  orangeEnabled: true,
  pinkEnabled: true,
  cyanEnabled: false,
  orangeSat: 0.60,
  orangeSense: 0.75,
  pinkSat: 0.88,
  pinkSense: 0.50,
  cyanSat: 0.70,
  cyanSense: 0.55,
};

const KEYS = [
  'enabled', 'orangeEnabled', 'pinkEnabled', 'cyanEnabled',
  'orangeSat', 'orangeSense', 'pinkSat', 'pinkSense',
  'cyanSat', 'cyanSense',
];

const els = {
  enabled: document.getElementById('enabled'),
  orangeEnabled: document.getElementById('orangeEnabled'),
  pinkEnabled: document.getElementById('pinkEnabled'),
  cyanEnabled: document.getElementById('cyanEnabled'),
  orangeSection: document.getElementById('orangeSection'),
  pinkSection: document.getElementById('pinkSection'),
  cyanSection: document.getElementById('cyanSection'),
  orangeSat: document.getElementById('orangeSat'),
  orangeSatOut: document.getElementById('orangeSatOut'),
  orangeSense: document.getElementById('orangeSense'),
  orangeSenseOut: document.getElementById('orangeSenseOut'),
  pinkSat: document.getElementById('pinkSat'),
  pinkSatOut: document.getElementById('pinkSatOut'),
  pinkSense: document.getElementById('pinkSense'),
  pinkSenseOut: document.getElementById('pinkSenseOut'),
  cyanSat: document.getElementById('cyanSat'),
  cyanSatOut: document.getElementById('cyanSatOut'),
  cyanSense: document.getElementById('cyanSense'),
  cyanSenseOut: document.getElementById('cyanSenseOut'),
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
    orangeSat: Number(els.orangeSat.value),
    orangeSense: Number(els.orangeSense.value),
    pinkSat: Number(els.pinkSat.value),
    pinkSense: Number(els.pinkSense.value),
    cyanSat: Number(els.cyanSat.value),
    cyanSense: Number(els.cyanSense.value),
  };
}

function writeUi(settings) {
  els.enabled.checked = !!settings.enabled;
  els.orangeEnabled.checked = settings.orangeEnabled !== false;
  els.pinkEnabled.checked = settings.pinkEnabled !== false;
  els.cyanEnabled.checked = !!settings.cyanEnabled;
  els.orangeSat.value = settings.orangeSat;
  els.orangeSense.value = settings.orangeSense;
  els.pinkSat.value = settings.pinkSat;
  els.pinkSense.value = settings.pinkSense;
  els.cyanSat.value = settings.cyanSat;
  els.cyanSense.value = settings.cyanSense;
  syncOutputs();
  syncDisabledState();
}

function syncOutputs() {
  els.orangeSatOut.textContent = fmt(els.orangeSat.value);
  els.orangeSenseOut.textContent = fmt(els.orangeSense.value);
  els.pinkSatOut.textContent = fmt(els.pinkSat.value);
  els.pinkSenseOut.textContent = fmt(els.pinkSense.value);
  els.cyanSatOut.textContent = fmt(els.cyanSat.value);
  els.cyanSenseOut.textContent = fmt(els.cyanSense.value);
}

function syncDisabledState() {
  const masterOff = !els.enabled.checked;
  document.body.classList.toggle('is-off', masterOff);
  els.orangeSection.classList.toggle('is-disabled', masterOff || !els.orangeEnabled.checked);
  els.pinkSection.classList.toggle('is-disabled', masterOff || !els.pinkEnabled.checked);
  els.cyanSection.classList.toggle('is-disabled', masterOff || !els.cyanEnabled.checked);
}

function persist() {
  syncOutputs();
  syncDisabledState();
  chrome.storage.sync.set(readUi());
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  const settings = {};
  for (const k of KEYS) settings[k] = stored[k] ?? DEFAULTS[k];
  writeUi(settings);
});

els.enabled.addEventListener('change', persist);
els.orangeEnabled.addEventListener('change', persist);
els.pinkEnabled.addEventListener('change', persist);
els.cyanEnabled.addEventListener('change', persist);
['orangeSat', 'orangeSense', 'pinkSat', 'pinkSense', 'cyanSat', 'cyanSense'].forEach((id) => {
  els[id].addEventListener('input', persist);
});

els.reset.addEventListener('click', () => {
  writeUi(DEFAULTS);
  persist();
});
