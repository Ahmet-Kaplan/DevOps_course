/** Entry module for /login.html. */
import { api } from './api.js';
import { redirectIfLoggedIn, setupAuthForm, validateLogin } from './auth-form.js';
import { $ } from './dom.js';
import { initLayout } from './layout.js';

initLayout();
redirectIfLoggedIn();

setupAuthForm($('#login-form'), {
  submit: api.login,
  validate: validateLogin,
  pendingLabel: 'Logging in…',
});
