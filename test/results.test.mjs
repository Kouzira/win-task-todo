import test from 'node:test';
import assert from 'node:assert/strict';
import { resultWords, toUnsigned } from '../lib/results.mjs';

test('known codes', () => {
  assert.equal(resultWords(0), 'Succeeded');
  assert.equal(resultWords(0x41300), 'Ready');
  assert.equal(resultWords(267009), 'Running');
  assert.equal(resultWords(0x41302), 'Disabled');
  assert.equal(resultWords(267011), 'Never run');
  assert.equal(resultWords(0x41304), 'No trigger');
  assert.equal(resultWords(0x41306), 'Stopped');
  assert.equal(resultWords(0x8004131f), 'Already running');
  assert.equal(resultWords(0x800710e0), 'Machine not ready (battery, network...)');
  assert.equal(resultWords(1), 'Failed (code 1)');
});

test('signed and unsigned values are the same code', () => {
  assert.equal(toUnsigned(-1225786), 4293741510);
  assert.equal(resultWords(-2147216609), 'Already running');
  assert.equal(resultWords(0x800710e0 | 0), 'Machine not ready (battery, network...)');
  assert.equal(resultWords(-1225786), 'Failed, code 0xFFED4BC6');
  assert.equal(resultWords(267009), 'Running');
});

test('unknown codes come out as eight hex digits', () => {
  assert.equal(resultWords(0xC000013A), 'Failed, code 0xC000013A');
  assert.equal(resultWords(2), 'Failed, code 0x00000002');
  assert.equal(resultWords(null), 'Unknown');
});
