const TOKEN = /^[A-Za-z0-9_-]{24,128}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export function invitationToken(fragment) {
  if (typeof fragment !== 'string' || CONTROL.test(fragment)) return '';
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const entries = [...params];
  return entries.length === 1 && entries[0][0] === 'token' && TOKEN.test(entries[0][1]) ? entries[0][1] : '';
}

// An invitation opens the receiving page in the browser; it never invokes an
// application protocol or accepts credentials, redirects or script fragments.
export function parseInvitation(value) {
  const invalid = () => { throw new Error('邀请地址无效，请粘贴广播端复制的完整 HTTP / HTTPS 邀请。'); };
  if (typeof value !== 'string' || value.length > 4096 || CONTROL.test(value)) invalid();
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) invalid();
  let url;
  try { url = new URL(text); } catch { invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      !['/', '/index.html'].includes(url.pathname) || url.search) invalid();
  const token = invitationToken(url.hash);
  if (!token) invalid();
  url.hash = `token=${token}`;
  return url.href;
}
