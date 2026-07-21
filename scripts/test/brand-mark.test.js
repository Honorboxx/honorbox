// Guards on the mark itself.
//
// The mark had drifted into six independent definitions: two lockups, an
// avatar, two favicons and a CSS data URI, each drawn from memory rather than
// from the one before it. They disagreed on proportion, on stroke, and one of
// them was a different drawing altogether. Nobody introduced that on purpose;
// it is what happens when the same shape is retyped in seven places over
// several weeks.
//
// So the shape lives here as one string, and every file that draws it has to
// match it exactly. A redraw is then a deliberate edit to this file rather
// than a slow divergence nobody notices until the favicon and the README
// disagree in public.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The one mark: a stand with a slot cut into it, over a foot. Drawn on a 48
// unit frame with every straight edge on a multiple of 3 so it lands on whole
// pixels at 16px and 32px.
const MARK = 'M9,15H39A3,3 0 0 1 42,18V42H6V18A3,3 0 0 1 9,15ZM4.5,39H43.5A1.5,1.5 0 0 1 45,40.5V43.5A1.5,1.5 0 0 1 43.5,45H4.5A1.5,1.5 0 0 1 3,43.5V40.5A1.5,1.5 0 0 1 4.5,39ZM18,24A3,3 0 0 0 15,27A3,3 0 0 0 18,30H30A3,3 0 0 0 33,27A3,3 0 0 0 30,24H18Z';

// Every file that draws the mark. Adding a new surface means adding it here.
const DRAWS_THE_MARK = [
  'assets/logo.svg',
  'assets/logo-dark.svg',
  'assets/avatar.svg',
  'themes/stand/favicon.svg',
  'themes/terminal/favicon.svg',
  'themes/stand/layout.html',
  'themes/terminal/layout.html',
];

test('every surface draws the same mark, character for character', () => {
  const wrong = DRAWS_THE_MARK.filter((f) => !read(f).includes(MARK));
  assert.deepEqual(wrong, [], 'these files draw a mark that is not the mark');
});

test('no surface draws the mark twice', () => {
  // Two copies in one file is how a lockup and its own favicon drifted apart.
  const doubled = DRAWS_THE_MARK.filter((f) => read(f).split(MARK).length - 1 > 1);
  assert.deepEqual(doubled, []);
});

test('the detached coin stays gone', () => {
  // A tilted coin floating clear of the box. It was the only coloured element
  // in the mark, it could not be attached to anything, and at 16px it degraded
  // to a speck. Its arc is distinctive enough to grep for.
  const back = DRAWS_THE_MARK.filter((f) => read(f).includes('M18.21,9.84'));
  assert.deepEqual(back, [], 'the coin is back');
});

test('the mark carries no accent hue', () => {
  // The mark is one colour so it holds in both schemes at every size. Gold in
  // the slot measured 7.71:1 on ink and 2.53:1 on the cream the mark flips to
  // at night, and pushing it to pass turned it brown. Greens are the terminal
  // theme's own phosphor and are allowed there only.
  const ACCENTS = /#(b5482a|d9603c|8f3820|c8891a|d99b1c|e0a92e|eab308)/i;
  const coloured = DRAWS_THE_MARK.filter((f) => ACCENTS.test(read(f)));
  assert.deepEqual(coloured, []);
});

test('both themes ship the identical nav mark', () => {
  // The themes are separately sold and separately edited, which is exactly how
  // one of them ended up with a different drawing.
  const svg = (f) => read(f).match(/<svg class="brand-mark"[\s\S]*?<\/svg>/)[0];
  assert.equal(svg('themes/stand/layout.html'), svg('themes/terminal/layout.html'));
});
