/** Entry module for /signup.html. The backend logs the new user in right away (Set-Cookie). */
import { api } from './api.js';
import { redirectIfLoggedIn, setupAuthForm, validateSignup } from './auth-form.js';
import { $ } from './dom.js';
import { initLayout } from './layout.js';

initLayout();
redirectIfLoggedIn();

setupAuthForm($('#signup-form'), {
  submit: api.signup,
  validate: validateSignup,
  pendingLabel: 'Creating account…',
});
