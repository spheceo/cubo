import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LatestRequest } from './latest-request';

test('a delayed older read cannot publish after a newer read begins', async () => {
  const gate = new LatestRequest();
  const older = gate.begin();
  const newer = gate.begin();
  await Promise.resolve();
  assert.equal(gate.isCurrent(older), false);
  assert.equal(gate.isCurrent(newer), true);
});

test('a failed newest read is still authoritative over an older response', () => {
  const gate = new LatestRequest();
  const older = gate.begin();
  const newest = gate.begin();
  assert.equal(gate.isCurrent(newest), true);
  assert.equal(gate.isCurrent(older), false);
});

test('switching connections invalidates an in-flight read', () => {
  const gate = new LatestRequest();
  const oldConnectionRead = gate.begin();
  const newConnectionRead = gate.begin();
  assert.equal(gate.isCurrent(oldConnectionRead), false);
  assert.equal(gate.isCurrent(newConnectionRead), true);
});

test('an authoritative refresh supersedes a mutation response race', () => {
  const gate = new LatestRequest();
  const mutation = gate.begin();
  // A read that began while the mutation was in flight can see old Core state.
  const overlappingRead = gate.begin();
  // Once the mutation completes, the provider starts its authoritative read.
  const authoritativeRead = gate.begin();
  assert.equal(gate.isCurrent(mutation), false);
  assert.equal(gate.isCurrent(overlappingRead), false);
  assert.equal(gate.isCurrent(authoritativeRead), true);
});

test('a read that starts during a write cannot suppress the write refresh', async () => {
  const gate = new LatestRequest();
  let visible = '';
  let resolveRead!: (value: string) => void;
  const readResult = new Promise<string>((resolve) => {
    resolveRead = resolve;
  });

  const mutation = gate.begin();
  const overlappingRead = gate.begin();
  void readResult.then((value) => {
    if (gate.isCurrent(overlappingRead)) visible = value;
  });
  resolveRead('stale');
  await readResult;
  assert.equal(visible, 'stale');

  // The write completed after that read began, so it always starts a new
  // authoritative read rather than relying on mutation's old token.
  assert.equal(gate.isCurrent(mutation), false);
  const authoritativeRead = gate.begin();
  if (gate.isCurrent(authoritativeRead)) visible = 'fresh';
  assert.equal(visible, 'fresh');
});
