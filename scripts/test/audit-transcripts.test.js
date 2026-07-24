'use strict';
// The audit transcripts published in docs/ are what the Pro tool prints.
//
// docs/bring-your-own-store.md is the page a prospect opens before deciding to
// spend money, and docs/pro-evidence.md is what they read to judge whether the
// paid suite does anything. Both publish output from a tool that does not live
// in this repository, so until now nothing here could tell whether a copy pass,
// a rebase, or a well-meant tidy had edited that output into something the tool
// does not produce. That is not a formatting concern: showing a buyer invented
// output is showing them a product that does not exist.
//
// The expectation is vendored (scripts/test/fixtures/audit-transcripts.js)
// rather than read from the Pro repo, because that repo is private and this one
// is public. The fixture's header carries the full reasoning and the command
// that regenerates it.
//
// Run: node --test scripts/test/audit-transcripts.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { BROKEN, FIXED, ACME } = require('./fixtures/audit-transcripts.js');
const DOCS = path.join(__dirname, '..', '..', 'docs');

// Fenced blocks, parsed by walking lines rather than with a regex. A regex that
// pairs ``` naively mispairs the moment one fence in the file carries a
// language tag, and it then compares the wrong text and passes, which is the
// worst outcome available to a test whose whole job is comparing text.
function fencedBlocks(file) {
  const out = [];
  let cur = null;
  for (const line of fs.readFileSync(path.join(DOCS, file), 'utf8').split('\n')) {
    if (line.startsWith('```')) { if (cur === null) cur = []; else { out.push(cur.join('\n')); cur = null; } }
    else if (cur !== null) cur.push(line);
  }
  assert.equal(cur, null, `${file} has an unclosed code fence`);
  return out;
}

test('the fixture is not vacuous', () => {
  // A pin that compares against an empty string passes forever. Every one of
  // these is a real transcript, and they are three DIFFERENT ones: the same
  // block vendored three times would still satisfy the tests below.
  for (const [name, block] of [['BROKEN', BROKEN], ['FIXED', FIXED], ['ACME', ACME]]) {
    assert.ok(block.split('\n').length > 40, `${name} is too short to be a transcript`);
    assert.match(block, /^HonorBox audit: /, `${name} is not an audit transcript`);
  }
  assert.equal(new Set([BROKEN, FIXED, ACME]).size, 3, 'two of the vendored transcripts are identical');
});

test('pro-evidence.md publishes the audit transcripts unedited', () => {
  const blocks = fencedBlocks('pro-evidence.md');
  assert.ok(blocks.includes(BROKEN),
    'the store-with-four-mistakes transcript has been edited since it was generated');
  assert.ok(blocks.includes(FIXED),
    'the same-store-fixed transcript has been edited since it was generated');
});

test('bring-your-own-store.md publishes its audit transcript unedited', () => {
  // The page a cold prospect reads. An edit here is the expensive one.
  assert.ok(fencedBlocks('bring-your-own-store.md').includes(ACME),
    'the bring-your-own-store transcript has been edited since it was generated');
});

test('the transcripts still show what the pages claim they show', () => {
  // Byte equality alone would happily pin three transcripts that had quietly
  // become meaningless. These are the claims the surrounding prose makes about
  // them, so if a regeneration ever lands a set that no longer demonstrates the
  // failures, this says so rather than reporting a tidy pass.
  assert.match(BROKEN, /^10 entries checked: 4 exposed · 0 warn · 0 unchecked · 6 guarded$/m);
  assert.match(BROKEN, /payment_link is a checkout URL, not an id/);
  assert.match(BROKEN, /fetch\(\) with no signal/);
  assert.match(BROKEN, /accepts 201 and 204 as one outcome/);

  assert.match(FIXED, /^10 entries checked: 0 exposed · 0 warn · 0 unchecked · 10 guarded$/m);
  assert.doesNotMatch(FIXED, /\[EXPOSED\]/, 'the "same store fixed" block must actually be clean');

  // The bring-your-own-store page's whole argument is that a store with no
  // engine files gets told what could NOT be checked, never a quiet pass.
  assert.match(ACME, /^10 entries checked: 0 exposed · 0 warn · 3 unchecked · 7 guarded$/m);
  assert.match(ACME, /UNCHECKED is not a pass/);
});
