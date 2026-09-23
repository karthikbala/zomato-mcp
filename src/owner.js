let csrf = null;
let challengeId = null;
const $ = (id) => document.getElementById(id);
const message = (value) => {
  $('message').textContent = value;
};
async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: data === undefined ? undefined : JSON.stringify(data),
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}
async function showStatus() {
  $('status').textContent = JSON.stringify(await api('/owner/api/status'), null, 2);
}
$('unlockButton').onclick = async () => {
  try {
    const response = await fetch('/owner/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: $('key').value }),
    });
    if (!response.ok) throw Error('Owner key was not accepted.');
    csrf = (await response.json()).csrf;
    $('key').value = '';
    $('unlock').hidden = true;
    $('controls').hidden = false;
    await showStatus();
  } catch (error) {
    message(error.message);
  }
};
$('check').onclick = async () => {
  try {
    $('status').textContent = JSON.stringify(await api('/owner/api/check', {}), null, 2);
    message('Session checked.');
  } catch (error) {
    message(error.message);
  }
};
$('start').onclick = async () => {
  try {
    const result = await api('/owner/api/login/start', {});
    challengeId = result.challengeId;
    $('otpBox').hidden = false;
    message('OTP requested. Enter the code sent to your configured phone.');
  } catch (error) {
    message(error.message);
  }
};
$('complete').onclick = async () => {
  try {
    const status = await api('/owner/api/login/complete', { challengeId, otp: $('otp').value });
    $('otp').value = '';
    $('otpBox').hidden = true;
    challengeId = null;
    $('status').textContent = JSON.stringify(status, null, 2);
    message('Login completed and restaurant identity checked.');
  } catch (error) {
    $('otp').value = '';
    message(error.message);
  }
};
