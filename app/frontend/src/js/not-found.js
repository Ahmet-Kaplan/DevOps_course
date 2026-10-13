/** Entry module for /404.html: shared header state and footer only. */
import { getCurrentUser } from './api.js';
import { initLayout, renderNav } from './layout.js';

initLayout();
getCurrentUser()
  .then((user) => renderNav(user))
  .catch(() => {
    /* API unreachable: keep the logged-out navigation. */
  });
