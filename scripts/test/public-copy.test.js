// Guards on what the STORE says, as opposed to whether the builder works.
//
// Everything else in this suite tests behaviour. This file tests claims,
// because that is where our defects have actually been: a headline price
// that was arithmetically false, a docs link that pointed at a page we had
// never published, line counts that went stale three times in one day, and a
// FAQ item that explained our own pricing strategy to customers.
//
// A rule that lives only in someone's memory decays the moment the thing it
// describes moves. These run on every build instead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Everything a visitor or a buyer can read. dist/ is generated, so checking
// the sources catches it before it is ever built, and the dist check below
// catches anything that reaches the page by another route.
function publicSources() {
  const out = [];
  for (const dir of ['products', 'pages', 'docs']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.md')) out.push(path.join(dir, f));
    }
  }
  out.push('store.config.json', 'README.md');
  return out.filter((f) => fs.existsSync(path.join(ROOT, f)));
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// How many we have sold is nobody's business but ours. The trap is that this
// leaks sideways rather than as a number: "$29 for the first 25 copies" is a
// price sentence that also announces we have sold fewer than 25. It shipped
// on both product pages and read as pricing, not as disclosure, until the
// owner caught it.
const SALES_STATE = [
  /first\s+\d+\s+copies/i,
  /first\s+(ten|twenty|twenty-five|fifty|hundred)\s+copies/i,
  /after\s+those\s+are\s+sold/i,
  /copies\s+(sold|remaining|left)/i,
  /\b\d+\s+(sales|orders|customers|buyers)\s+(so far|to date)/i,
  /(sold|shipped)\s+\d+\s+(copies|licen[cs]es)/i,
];

test('public copy states no sales figures and no sales state', () => {
  const hits = [];
  for (const f of publicSources()) {
    const body = read(f);
    body.split('\n').forEach((line, i) => {
      for (const re of SALES_STATE) {
        if (re.test(line)) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `sales state on a public surface:\n  ${hits.join('\n  ')}`);
});

// We reason about pricing psychology, funnels and conversion constantly. None
// of it belongs in front of a customer. The removed FAQ did not just state the
// ladder, it explained why we had chosen it and why we had left a counter off
// the page, which tells a reader they are being managed.
// Deliberately NOT a vocabulary blocklist. The first draft of this flagged
// "launch price" and "upsell treadmill" and caught two innocent lines: the Pro
// page listing the playbook's chapters, and a buyer-facing promise not to
// nickel and dime anyone. Pricing words are legitimate here because a pricing
// playbook is part of what Pro sells. A guard that cries wolf gets switched
// off, so these match the SHAPE of us narrating ourselves, not the topic.
const INTERNAL_REASONING = [
  /why\s+(does|do|did)\s+(the|our|we)\s+(price|pricing)/i,  // the FAQ that started this
  /why\s+we\s+(price|charge|chose|decided)/i,
  /\bour\s+(margin|pricing strategy|positioning|conversion)\b/i,
  /because\s+a\s+number\s+nobody\s+can\s+audit/i,           // the exact sentence that shipped
  /\bwe\s+(decided|chose)\s+(not\s+)?to\s+(show|put|add|display)\b/i,
];

test('public copy does not explain our own commercial reasoning', () => {
  const hits = [];
  for (const f of publicSources()) {
    // The playbook and evidence docs teach pricing to BUYERS as the product;
    // that is the thing they paid for, not us thinking out loud.
    if (/pro-evidence|playbook/i.test(f)) continue;
    const body = read(f);
    body.split('\n').forEach((line, i) => {
      for (const re of INTERNAL_REASONING) {
        if (re.test(line)) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `internal commercial reasoning on a public surface:\n  ${hits.join('\n  ')}`);
});

// The sources can be clean while the built page is not: a section type, a
// theme layout or a config string can put text on the page that never appears
// in products/ or pages/. Check what actually ships, when it exists.
test('the built store carries neither, if it has been built', () => {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return; // build not run in this environment
  const hits = [];
  for (const f of fs.readdirSync(dist)) {
    if (!f.endsWith('.html')) continue;
    const body = fs.readFileSync(path.join(dist, f), 'utf8');
    for (const re of [...SALES_STATE, ...INTERNAL_REASONING]) {
      const m = body.match(re);
      if (m) hits.push(`dist/${f}  ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `leaked into the built store:\n  ${hits.join('\n  ')}`);
});
