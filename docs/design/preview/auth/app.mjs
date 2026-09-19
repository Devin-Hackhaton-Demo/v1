export const TERMS_VERSION = '2026-09-19';

const MODES = Object.freeze({
  login: { title: 'Welcome back.', description: 'A fresh start, right where you left off.', eyebrow: 'MAKE YOURSELF AT HOME', submit: 'Sign in', pending: 'Signing you in…', switchPrompt: 'New around here?', switchLabel: 'Create an account', switchHref: '/signup' },
  signup: { title: 'Make room for your ideas.', description: 'Create your account. Your personal AI home starts here.', eyebrow: 'SOMETHING GOOD IS BREWING', submit: 'Create account', pending: 'Creating your account…', switchPrompt: 'Already have an account?', switchLabel: 'Sign in', switchHref: '/login' },
  'forgot-password': { title: 'A fresh start.', description: 'Enter your email and we’ll help you reset your password.', eyebrow: 'LET’S GET YOU BACK IN', submit: 'Send reset link', pending: 'Requesting your link…', switchPrompt: 'Remember your password?', switchLabel: 'Back to sign in', switchHref: '/login' },
  'reset-password': { title: 'Choose a new password.', description: 'One small reset. Then back to your space.', eyebrow: 'YOUR NEXT CHAPTER', submit: 'Save new password', pending: 'Updating your password…', switchPrompt: 'Need a new reset link?', switchLabel: 'Request a link', switchHref: '/forgot-password' },
});

const CALLBACK_ERRORS = Object.freeze({
  access_denied: 'Google sign-in was cancelled. You can try again or use your email.',
  oauth_cancelled: 'Google sign-in was cancelled. You can try again or use your email.',
  oauth_denied: 'Google sign-in was cancelled. You can try again or use your email.',
  callback_failed: 'We couldn’t complete sign-in. Please start again.',
  auth_callback_failed: 'We couldn’t complete sign-in. Please start again.',
  auth_failed: 'We couldn’t complete sign-in. Please start again.',
  oauth_failed: 'We couldn’t complete Google sign-in. Please try again.',
  invalid_callback: 'This sign-in link is not valid. Please start again.',
  invalid_state: 'This sign-in request has expired. Please start again.',
  callback_expired: 'This sign-in link has expired. Please start again.',
  link_expired: 'This email link has expired or has already been used. Please request a new one.',
  otp_expired: 'This email link has expired or has already been used. Please request a new one.',
  recovery_expired: 'Your password reset link has expired. Please request a new one.',
  recovery_required: 'Open the password reset link from your email, or request a new one.',
  invalid_recovery_session: 'Open the latest password reset link from your email, or request a new one.',
  confirmation_failed: 'We couldn’t verify this email link. Please use the latest email or try signing in.',
  auth_confirmation_failed: 'We couldn’t verify this email link. Please use the latest email or try signing in.',
  email_confirmation_failed: 'We couldn’t verify this email link. Please use the latest email or try signing in.',
  provider_unavailable: 'Google sign-in is temporarily unavailable. Please try again later or use your email.',
  auth_unavailable: 'Authentication is temporarily unavailable. Please try again.',
  terms_required: 'Please accept the Terms and acknowledge the Privacy notice before continuing with Google.',
});

const POST_ROUTES = new Set(['login', 'signup', 'google', 'forgot-password', 'reset-password']);
const CONNECTION_ERROR = 'We couldn’t reach the account service. Check your connection and try again.';
const RESPONSE_ERROR = 'The account service returned an unexpected response. Please try again.';
const hasUser = (user) => typeof user?.id === 'string' && Boolean(user.id) && typeof user?.email === 'string' && Boolean(user.email);

export class AuthError extends Error {
  constructor(message, code = 'request_failed', retryable = true) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function getAuthMode(pathname = '/login') {
  const key = pathname.replace(/\/+$/, '').slice(1);
  return Object.hasOwn(MODES, key) ? key : 'login';
}

export function getCallbackFeedback(search = '') {
  const params = new URLSearchParams(search);
  const code = (params.get('error') || params.get('auth_error') || params.get('error_code'))?.toLowerCase();
  if (code) return { kind: 'error', message: Object.hasOwn(CALLBACK_ERRORS, code) ? CALLBACK_ERRORS[code] : 'We couldn’t complete that account request. Please try again.' };
  if (params.get('notice') === 'email_confirmed' || params.get('success') === 'email_confirmed') {
    return { kind: 'notice', message: 'Your email is confirmed. You can now sign in.' };
  }
  return null;
}

export function shouldRedirectToApp(mode, user) {
  return Boolean(user && (mode === 'login' || mode === 'signup'));
}

export function getSignupOutcome(data) {
  if (data?.requiresEmailConfirmation === true) return 'confirmation';
  if (data?.requiresEmailConfirmation === false || hasUser(data?.user)) return 'app';
  return null;
}

export function safeGoogleRedirect(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (!/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.pathname !== '/auth/v1/authorize') return null;
    if (url.searchParams.get('provider') !== 'google') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createAuthPayload(mode, { email = '', password = '', termsAccepted = false } = {}) {
  if (mode === 'signup' || mode === 'google') {
    if (termsAccepted !== true) throw new AuthError('Please agree to the Terms and acknowledge the Privacy notice to continue.', 'terms_required', false);
    const terms = { termsAccepted: true, termsVersion: TERMS_VERSION };
    return mode === 'google' ? terms : { email: email.trim(), password, ...terms };
  }
  if (mode === 'forgot-password') return { email: email.trim() };
  if (mode === 'reset-password') return { password };
  if (mode === 'login') return { email: email.trim(), password };
  throw new AuthError('This account action is not available.', 'invalid_action', false);
}

export function createAuthClient(fetcher = globalThis.fetch, timeoutMs = 20000) {
  let csrfToken = '';
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        ...options,
        signal: controller.signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new AuthError(RESPONSE_ERROR, 'invalid_response');
      }
      if (!response.ok || payload?.ok !== true) {
        const error = payload?.error;
        const message = typeof error?.message === 'string' && error.message.trim() && error.message.length <= 600 ? error.message : 'We couldn’t complete that request. Please try again.';
        throw new AuthError(message, typeof error?.code === 'string' ? error.code : 'request_failed', error?.retryable !== false);
      }
      if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new AuthError(RESPONSE_ERROR, 'invalid_response');
      return payload.data;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (controller.signal.aborted) throw new AuthError('The account service took too long to respond. Please try again.', 'timeout');
      throw new AuthError(CONNECTION_ERROR, 'network_error');
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    async session() {
      csrfToken = '';
      const data = await request('/api/auth/session');
      if (typeof data.csrfToken !== 'string' || !data.csrfToken || !(data.user === null || hasUser(data.user))) {
        throw new AuthError(RESPONSE_ERROR, 'invalid_response');
      }
      csrfToken = data.csrfToken;
      return data;
    },
    async post(action, payload) {
      if (!POST_ROUTES.has(action)) throw new AuthError('This account action is not available.', 'invalid_action', false);
      if (!csrfToken) throw new AuthError('Reconnect to the account service before trying again.', 'session_required');
      return request(`/api/auth/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(payload),
      });
    },
  };
}

export function togglePasswordVisibility(input, button, slash) {
  const focused = input.ownerDocument.activeElement === input;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const direction = input.selectionDirection;
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  button.setAttribute('title', visible ? 'Hide password' : 'Show password');
  if (slash) slash.toggleAttribute('hidden', !visible);
  if (focused) input.focus({ preventScroll: true });
  if (start !== null && end !== null) input.setSelectionRange(start, end, direction || 'none');
  return visible;
}

export function startAuthPage(document, window) {
  const get = (id) => document.getElementById(id);
  const mode = getAuthMode(window.location.pathname);
  const copy = MODES[mode];
  const client = createAuthClient(window.fetch.bind(window));
  const form = get('auth-form');
  const email = get('email');
  const password = get('password');
  const terms = get('terms-accepted');
  const submit = get('submit-button');
  const google = get('google-button');
  const errorBox = get('error-message');
  const noticeBox = get('notice-message');
  const sessionStatus = get('session-status');
  const isAccount = mode === 'login' || mode === 'signup';
  const hasEmail = mode !== 'reset-password';
  const hasPassword = mode !== 'forgot-password';
  let ready = false;
  let busy = false;
  let completed = false;
  let navigating = false;

  document.title = `${mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'forgot-password' ? 'Reset your password' : 'New password'} · Coffeenator`;
  get('form-title').textContent = copy.title;
  get('form-description').textContent = copy.description;
  get('form-eyebrow').textContent = copy.eyebrow;
  get('submit-label').textContent = copy.submit;
  get('switch-prompt').textContent = copy.switchPrompt;
  for (const link of [get('switch-link'), get('nav-switch')]) {
    link.textContent = copy.switchLabel;
    link.href = copy.switchHref;
  }
  get('google-section').hidden = !isAccount;
  get('email-field').hidden = !hasEmail;
  get('password-field').hidden = !hasPassword;
  get('terms-field').hidden = !isAccount;
  get('forgot-link').hidden = mode !== 'login';
  get('privacy-note').hidden = !isAccount;
  get('password-hint').hidden = !hasPassword || mode === 'login';
  email.required = hasEmail;
  email.disabled = !hasEmail;
  password.required = hasPassword;
  password.disabled = !hasPassword;
  password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  if (mode !== 'login') {
    password.placeholder = 'Choose a password';
    get('password-label').textContent = mode === 'reset-password' ? 'New password' : 'Password';
    password.setAttribute('aria-describedby', 'password-hint');
  }
  terms.required = mode === 'signup';
  terms.disabled = !isAccount;
  terms.setAttribute('aria-describedby', 'terms-hint');
  if (mode === 'signup') get('terms-hint').textContent = 'Applies to email and Google sign-up. AI data consent is separate.';
  google.setAttribute('aria-describedby', 'terms-hint');
  form.noValidate = true;
  form.hidden = false;

  const callback = getCallbackFeedback(window.location.search);
  if (window.location.search || window.location.hash) window.history.replaceState(null, '', window.location.pathname);

  function showError(message, focus = true) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    noticeBox.hidden = true;
    if (focus) errorBox.focus({ preventScroll: false });
  }

  function showNotice(message) {
    noticeBox.textContent = message;
    noticeBox.hidden = false;
    errorBox.hidden = true;
  }

  function syncControls(action = '') {
    submit.disabled = !ready || busy || completed;
    google.disabled = !ready || busy || completed;
    email.readOnly = busy;
    password.readOnly = busy;
    terms.disabled = !isAccount || busy;
    get('password-toggle').disabled = busy;
    get('retry-session').disabled = busy;
    form.setAttribute('aria-busy', String(busy));
    get('submit-label').textContent = busy && action === 'session' ? 'Connecting…' : busy && action !== 'google' ? copy.pending : copy.submit;
    get('google-label').textContent = busy && action === 'google' ? 'Opening Google…' : 'Continue with Google';
    get('submit-spinner').hidden = !busy || action === 'google';
    get('submit-arrow').hidden = busy && action !== 'google';
  }

  function goToApp(message) {
    navigating = true;
    sessionStatus.textContent = message;
    window.location.assign('/app');
  }

  async function loadSession() {
    if (busy) return;
    ready = false;
    busy = true;
    get('retry-session').hidden = true;
    sessionStatus.textContent = 'Connecting to your account service…';
    syncControls('session');
    try {
      const session = await client.session();
      ready = true;
      if (shouldRedirectToApp(mode, session.user)) {
        goToApp('You’re signed in. Opening your space…');
        return;
      }
      errorBox.hidden = true;
      sessionStatus.textContent = '';
      if (callback?.kind === 'error') showError(callback.message, false);
      else if (callback?.kind === 'notice') showNotice(callback.message);
    } catch (error) {
      showError(error.message, false);
      get('retry-session').hidden = false;
      sessionStatus.textContent = 'Sign-in is paused until the account service reconnects.';
    } finally {
      if (!navigating) busy = false;
      syncControls();
    }
  }

  function validateForm() {
    for (const field of [email, password, terms]) {
      field.setCustomValidity('');
      field.removeAttribute('aria-invalid');
    }
    email.value = email.value.trim();
    if (hasEmail && !email.value) email.setCustomValidity('Enter your email address.');
    else if (hasEmail && email.validity.typeMismatch) email.setCustomValidity('Enter a valid email address.');
    if (hasPassword && !password.value) password.setCustomValidity('Enter your password.');
    if (mode === 'signup' && !terms.checked) terms.setCustomValidity('Please agree to the Terms and acknowledge the Privacy notice.');
    const invalid = [email, password, terms].find((field) => !field.disabled && !field.validity.valid);
    if (!invalid) return true;
    invalid.setAttribute('aria-invalid', 'true');
    invalid.reportValidity();
    invalid.focus();
    return false;
  }

  function showEmailSuccess(signup, address) {
    completed = true;
    password.value = '';
    form.hidden = true;
    get('account-switch').hidden = true;
    get('form-title').textContent = signup ? 'One last little step.' : 'Your next step is in your inbox.';
    get('form-description').textContent = signup ? 'Confirm your email to finish setting up your space.' : 'If an account matches, a password reset email is on its way.';
    get('success-title').textContent = 'Check your inbox';
    get('success-description').textContent = signup ? `If confirmation is needed for ${address}, look for an email with your confirmation link. Follow that link, then sign in.` : `If an account exists for ${address}, you’ll receive a link to reset its password.`;
    get('success-hint').textContent = signup ? 'Check your spam folder, too. Already confirmed your email? You can sign in below.' : 'Check your spam folder, too. For your privacy, we don’t confirm whether an email has an account.';
    get('try-another-email').hidden = signup;
    get('success-panel').hidden = false;
    sessionStatus.textContent = '';
    get('success-title').focus();
  }

  async function runAction(action) {
    if (!ready || busy || completed) return;
    if (action === 'google') {
      if (!terms.checked) {
        showError('Before continuing with Google, agree to the Terms and acknowledge the Privacy notice below.', false);
        terms.setAttribute('aria-invalid', 'true');
        terms.focus();
        return;
      }
    } else if (!validateForm()) return;
    busy = true;
    errorBox.hidden = true;
    noticeBox.hidden = true;
    get('retry-session').hidden = true;
    sessionStatus.textContent = action === 'google' ? 'Preparing Google sign-in…' : copy.pending;
    syncControls(action);
    try {
      const payload = createAuthPayload(action, { email: email.value, password: password.value, termsAccepted: terms.checked });
      const data = await client.post(action, payload);
      if (action === 'google') {
        const redirect = safeGoogleRedirect(data.redirectUrl);
        if (!redirect) throw new AuthError('Google sign-in could not be started safely. Please try again later.', 'invalid_redirect');
        navigating = true;
        window.location.assign(redirect);
      } else if (action === 'signup') {
        const outcome = getSignupOutcome(data);
        if (outcome === 'confirmation') showEmailSuccess(true, payload.email);
        else if (outcome === 'app') goToApp('Your account is ready. Opening your space…');
        else throw new AuthError(RESPONSE_ERROR, 'invalid_response');
      } else if (action === 'forgot-password') {
        showEmailSuccess(false, payload.email);
      } else if (action === 'login') {
        if (!hasUser(data.user)) throw new AuthError(RESPONSE_ERROR, 'invalid_response');
        password.value = '';
        goToApp('You’re signed in. Opening your space…');
      } else if (action === 'reset-password') {
        password.value = '';
        showNotice('Your password has been updated. Opening your space…');
        goToApp('Your password has been updated. Opening your space…');
      }
    } catch (error) {
      showError(error instanceof AuthError ? error.message : 'We couldn’t complete that request. Please try again.');
      sessionStatus.textContent = '';
      if (['csrf_invalid', 'csrf_failed', 'invalid_csrf', 'session_required'].includes(error.code?.toLowerCase())) {
        ready = false;
        get('retry-session').hidden = false;
      }
    } finally {
      if (!navigating) busy = false;
      syncControls(action);
    }
  }

  for (const field of [email, password, terms]) {
    field.addEventListener('input', () => {
      field.setCustomValidity('');
      field.removeAttribute('aria-invalid');
    });
  }
  get('password-toggle').addEventListener('pointerdown', (event) => {
    if (document.activeElement === password) event.preventDefault();
  });
  get('password-toggle').addEventListener('click', () => togglePasswordVisibility(password, get('password-toggle'), get('eye-slash')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void runAction(mode);
  });
  google.addEventListener('click', () => { void runAction('google'); });
  get('retry-session').addEventListener('click', () => { void loadSession(); });
  get('try-another-email').addEventListener('click', () => {
    completed = false;
    get('success-panel').hidden = true;
    form.hidden = false;
    get('account-switch').hidden = false;
    get('form-title').textContent = copy.title;
    get('form-description').textContent = copy.description;
    syncControls();
    email.focus();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      password.value = '';
      navigating = false;
      busy = false;
      void loadSession();
    }
  });
  void loadSession();
}

if (typeof document !== 'undefined' && document.getElementById('auth-form')) startAuthPage(document, window);
