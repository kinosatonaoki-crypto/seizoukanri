// Netlify Function: simple shared-state persistence for the manufacturing
// schedule app, backed by Netlify Blobs. Replaces the Claude Artifact
// publish/reload mechanism used during prototyping.
//
// GET  /api/state  -> { state: <STATE object>|null, version: <int> }
// POST /api/state  body: { state: <STATE object>, expectedVersion: <int> }
//      -> 200 { version: <newInt> }
//      -> 409 { error: 'conflict', state: <latestState>, version: <latestVersion> }
//         (someone else saved first — caller should show the latest state
//         and ask the user to redo their change, same idea as the old
//         Claude Artifact 'conflict' error code)

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'seizoukanri-app-state';
const KEY = 'current';

export default async (req) => {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });

  if (req.method === 'GET') {
    const record = await store.get(KEY, { type: 'json' });
    return json({ state: record ? record.state : null, version: record ? record.version : 0 });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json({ error: 'invalid_json' }, 400);
    }
    if (!body || typeof body !== 'object' || typeof body.state !== 'object' || body.state === null) {
      return json({ error: 'invalid_body' }, 400);
    }

    const expected = typeof body.expectedVersion === 'number' ? body.expectedVersion : 0;
    const current = await store.get(KEY, { type: 'json' });
    const currentVersion = current ? current.version : 0;

    if (expected !== currentVersion) {
      return json({ error: 'conflict', state: current ? current.state : null, version: currentVersion }, 409);
    }

    const newVersion = currentVersion + 1;
    await store.set(KEY, JSON.stringify({ state: body.state, version: newVersion }));
    return json({ version: newVersion });
  }

  return json({ error: 'method_not_allowed' }, 405);
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const config = { path: '/api/state' };
