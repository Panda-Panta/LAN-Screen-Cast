const test = require('node:test');
const assert = require('node:assert/strict');
const invitation = import('../src/viewer/invitation.mjs');
const token = 'abcdefghijklmnopqrstuvwxyz012345';

test('viewer imports an absolute HTTP or HTTPS invitation while keeping its token in the fragment', async () => {
  const { parseInvitation } = await invitation;
  assert.equal(parseInvitation(`  http://192.168.1.2:8765/#token=${token}  `), `http://192.168.1.2:8765/#token=${token}`);
  assert.equal(parseInvitation(`https://cast.example/index.html#token=${token}`), `https://cast.example/index.html#token=${token}`);
});

test('viewer rejects executable schemes, credentials, redirects, controls and malformed invitations', async () => {
  const { parseInvitation } = await invitation;
  for (const value of [
    `javascript:alert(1)`, `file:///C:/private.txt`, `data:text/html,test`,
    `http:example.com/#token=${token}`, `http://alice:secret@example.com/#token=${token}`,
    `http://example.com/redirect#token=${token}`, `http://example.com/?next=https://evil.example#token=${token}`,
    `http://example.com/#token=${token}\n`, `http://example.com/#token=%0a${token}`,
    `http://example.com/#token=${token}&token=${token}`, `http://example.com/#token=${token}&other=x`,
    `http://example.com/`, `http://example.com/#token=short`, `http://example.com/#token=<script>`,
  ]) assert.throws(() => parseInvitation(value), /邀请/);
});

test('viewer only reads one valid token from the current invitation fragment', async () => {
  const { invitationToken } = await invitation;
  assert.equal(invitationToken(`#token=${token}`), token);
  assert.equal(invitationToken(''), '');
  assert.equal(invitationToken('#token=bad'), '');
  assert.equal(invitationToken(`#token=${token}&token=another`), '');
  assert.equal(invitationToken(`#token=${token}&foo=bar`), '');
});
