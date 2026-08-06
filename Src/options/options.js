import { DEFAULTS, PROVIDERS, loadSettings, saveSettings, validate } from '../core/settings.js';

const $ = (id) => document.getElementById(id);
const status = $('status');

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = kind;
}

function fillSelect(select, options, selected) {
  select.replaceChildren();
  for (const { value, label } of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (value === selected) option.selected = true;
    select.append(option);
  }
}

function renderProvider(providerId, selectedModel) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;

  fillSelect(
    $('model'),
    provider.models.map((model) => ({ value: model.id, label: model.label })),
    selectedModel
  );

  const hint = $('keyHint');
  hint.replaceChildren(document.createTextNode(`Keys start with ${provider.keyPrefix}. `));
  const link = document.createElement('a');
  link.href = provider.keyUrl;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Get one';
  hint.append(link);

  $('thinking').disabled = !provider.supportsThinking;
}

function readForm() {
  return {
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    effort: $('effort').value,
    thinking: $('thinking').value,
    maxClaims: Number($('maxClaims').value),
    minDurationSeconds: Number($('minDurationSeconds').value),
    autoCheck: $('autoCheck').checked
  };
}

function writeForm(settings) {
  fillSelect(
    $('provider'),
    Object.entries(PROVIDERS).map(([id, provider]) => ({ value: id, label: provider.label })),
    settings.provider
  );
  renderProvider(settings.provider, settings.model);

  $('apiKey').value = settings.apiKey;
  $('effort').value = settings.effort;
  $('thinking').value = settings.thinking;
  $('maxClaims').value = settings.maxClaims;
  $('minDurationSeconds').value = settings.minDurationSeconds;
  $('autoCheck').checked = settings.autoCheck;
}

/**
 * A real request against the provider. Cheaper than a support thread: a typo'd
 * key fails here rather than silently mid-check.
 */
async function testConnection(settings) {
  const provider = PROVIDERS[settings.provider];
  const response = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for browser-origin calls; without it the request is CORS-blocked.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    })
  });

  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => null);
  return { ok: false, status: response.status, message: body?.error?.message ?? response.statusText };
}

$('provider').addEventListener('change', () => {
  const providerId = $('provider').value;
  renderProvider(providerId, PROVIDERS[providerId]?.models[0]?.id);
});

$('reveal').addEventListener('click', () => {
  const field = $('apiKey');
  const hidden = field.type === 'password';
  field.type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
});

$('save').addEventListener('click', async () => {
  const result = await saveSettings(readForm());
  if (result.ok) {
    setStatus('Saved', 'ok');
    setTimeout(() => setStatus(''), 2000);
    return;
  }
  setStatus(result.problems.map((problem) => problem.message).join(' · '), 'err');
});

$('test').addEventListener('click', async () => {
  const settings = { ...DEFAULTS, ...readForm() };
  const problems = validate(settings).filter((problem) => problem.field === 'apiKey' || problem.field === 'model');
  if (problems.length) {
    setStatus(problems[0].message, 'err');
    return;
  }

  setStatus('Testing…');
  try {
    const result = await testConnection(settings);
    if (result.ok) setStatus(`${PROVIDERS[settings.provider].label} responded — key works`, 'ok');
    else setStatus(`${result.status}: ${result.message}`, 'err');
  } catch (error) {
    setStatus(`Could not reach the provider — ${error.message}`, 'err');
  }
});

loadSettings().then(writeForm);
