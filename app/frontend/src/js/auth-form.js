/**
 * auth-form.js: shared behaviour for the log-in and sign-up forms.
 *
 * Client-side validation here is a UX feature (instant, specific feedback).
 * It is NOT security: the backend validates every request again, because a
 * request can come from curl just as easily as from this form.
 */
import { ApiError, getCurrentUser } from './api.js';
import { $, el } from './dom.js';

/* Same rules as the backend (see app/backend/src/validation.js). */
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt ignores everything after 72 bytes, so we cap it

/** Sign-up: enforce the full rules so the user hears about them before the round trip. */
export function validateSignup({ username, password }) {
  const errors = {};
  if (!username) errors.username = 'Enter a username.';
  else if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    errors.username = `Use ${USERNAME_MIN} to ${USERNAME_MAX} characters.`;
  } else if (!USERNAME_PATTERN.test(username)) {
    errors.username = 'Use only letters, numbers and underscores.';
  }

  if (!password) errors.password = 'Enter a password.';
  else if (password.length < PASSWORD_MIN) errors.password = `Use at least ${PASSWORD_MIN} characters.`;
  else if (password.length > PASSWORD_MAX) errors.password = `Use at most ${PASSWORD_MAX} characters.`;
  return errors;
}

/**
 * Log-in: only check that something was typed. Repeating the sign-up rules
 * here would leak them to someone guessing, and the server answers with one
 * generic "Invalid username or password" anyway.
 */
export function validateLogin({ username, password }) {
  const errors = {};
  if (!username) errors.username = 'Enter your username.';
  if (!password) errors.password = 'Enter your password.';
  return errors;
}

/** Already logged in? Skip the form. Network errors are ignored: the form still works. */
export async function redirectIfLoggedIn(target = '/dashboard.html') {
  try {
    if (await getCurrentUser()) window.location.replace(target);
  } catch {
    /* API unreachable: let the user try the form, which will show the real error. */
  }
}

/**
 * Wire up a form with `username` and `password` fields.
 *
 * @param {HTMLFormElement} form
 * @param {object} options
 * @param {(username: string, password: string) => Promise<unknown>} options.submit  API call to make.
 * @param {(values: {username: string, password: string}) => Record<string, string>} options.validate
 * @param {string} options.pendingLabel  Button text while the request is in flight.
 * @param {string} [options.successUrl]
 */
export function setupAuthForm(form, { submit, validate, pendingLabel, successUrl = '/dashboard.html' }) {
  const alert = $('[data-form-alert]', form);
  const button = $('[data-submit]', form);
  const idleLabel = button.textContent.trim();
  const fields = {
    username: form.elements.namedItem('username'),
    password: form.elements.namedItem('password'),
  };

  setupPasswordToggle(form);

  // Clear a field's error as soon as the user starts fixing it.
  for (const [name, input] of Object.entries(fields)) {
    input.addEventListener('input', () => setFieldError(name, ''));
  }

  function setFieldError(name, message) {
    const input = fields[name];
    const slot = $(`[data-error-for="${name}"]`, form);
    slot.textContent = message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function showAlert(message) {
    // No argument -> no children at all, so the CSS :empty rule can collapse the slot.
    if (message) alert.replaceChildren(el('p', { class: 'notice notice--error', text: message }));
    else alert.replaceChildren();
  }

  function setBusy(busy) {
    button.disabled = busy;
    button.textContent = busy ? pendingLabel : idleLabel;
    form.setAttribute('aria-busy', String(busy));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showAlert('');

    const values = {
      // Usernames never contain spaces, so trimming only removes typos.
      // Passwords are sent exactly as typed: spaces can be part of a password.
      username: fields.username.value.trim(),
      password: fields.password.value,
    };

    const errors = validate(values);
    setFieldError('username', errors.username ?? '');
    setFieldError('password', errors.password ?? '');
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      fields[firstInvalid].focus(); // screen readers read the label plus the error (aria-describedby)
      return;
    }

    setBusy(true);
    try {
      await submit(values.username, values.password);
      window.location.assign(successUrl);
    } catch (error) {
      setBusy(false);
      handleError(error);
    }
  });

  function handleError(error) {
    if (!(error instanceof ApiError)) {
      showAlert('Something went wrong in the browser. Reload the page and try again.');
      return;
    }
    if (error.status === 409) {
      // Username taken: the most useful place for that message is the field itself.
      setFieldError('username', error.message);
      fields.username.focus();
      return;
    }
    if (error.status === 429) {
      showAlert('Too many attempts from this network. Wait a few minutes, then try again.');
      return;
    }
    // 400 (validation), 401 (wrong credentials), 5xx, network: the server's message is the best one.
    showAlert(error.message);
  }
}

/** "Show / Hide" password button. aria-pressed tells screen readers its state. */
function setupPasswordToggle(form) {
  for (const toggle of form.querySelectorAll('[data-toggle-password]')) {
    const input = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!input) continue;
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(show));
    });
  }
}
