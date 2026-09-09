import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePullRequests } from './render-status.mjs';

test('parsePullRequests counts merged rows', () => {
  const md = `## Pull Requests
| key | branch | PR | state |
|---|---|---|---|
| api | feat/x | http://p/1 | merged |
| web | feat/x | http://p/2 | open |
| lib | feat/x | — | not started |

## Next section
`;
  assert.deepEqual(parsePullRequests(md), { merged: 1, total: 3 });
});

test('parsePullRequests is case-insensitive on state', () => {
  const md = `## Pull Requests
| key | branch | PR | state |
|---|---|---|---|
| api | feat/x | http://p/1 | MERGED |
`;
  assert.deepEqual(parsePullRequests(md), { merged: 1, total: 1 });
});

test('parsePullRequests returns null when the section is absent', () => {
  assert.equal(parsePullRequests('# plan\nno table here'), null);
});

test('parsePullRequests returns null for an N/A section with no table', () => {
  assert.equal(parsePullRequests('## Pull Requests\n\nN/A — single-repo effort.\n\n## Self-Review'), null);
});

test('parsePullRequests tolerates rows with no trailing pipe', () => {
  const md = `## Pull Requests
| key | branch | PR | state
|---|---|---|---
| api | feat/x | http://p/1 | merged
| web | feat/x | http://p/2 | open
`;
  assert.deepEqual(parsePullRequests(md), { merged: 1, total: 2 });
});

test('parsePullRequests ignores an example table inside a fenced block', () => {
  const md = `Some intro.

\`\`\`markdown
## Pull Requests
| key | branch | PR | state |
|---|---|---|---|
| api | feat/x | http://p/1 | merged |
\`\`\`

## Pull Requests
| key | branch | PR | state |
|---|---|---|---|
| api | feat/x | http://p/9 | open |
`;
  assert.deepEqual(parsePullRequests(md), { merged: 0, total: 1 });
});
