import * as assert from 'node:assert/strict';

import { parsePromptFile } from '../../agents/promptFrontMatter.js';

describe('a prompt file header', () => {
  it('never reaches the model', () => {
    // Until this was written the whole file was sent, so the model read a header addressed to
    // the editor and answered as if it were part of the instructions.
    const parsed = parsePromptFile(
      [
        '---',
        "description: 'Research an issue'",
        'mode: agent',
        'model: model-a',
        "tools: ['research', 'readFile']",
        '---',
        '',
        'Summarize {{items}}.',
      ].join('\n'),
    );

    assert.equal(parsed.text, 'Summarize {{items}}.');
    assert.equal(parsed.frontMatter?.description, 'Research an issue');
    assert.equal(parsed.frontMatter?.model, 'model-a');
    assert.equal(parsed.frontMatter?.mode, 'agent');
    assert.deepEqual(parsed.frontMatter?.tools, ['research', 'readFile']);
  });

  it('reads a list written over several lines', () => {
    const parsed = parsePromptFile(
      ['---', 'tools:', '  - research', '  - readFile', '---', 'Body.'].join('\n'),
    );

    assert.deepEqual(parsed.frontMatter?.tools, ['research', 'readFile']);
    assert.equal(parsed.text, 'Body.');
  });

  it('reads a file written on another operating system', () => {
    const parsed = parsePromptFile('---\r\nmodel: model-a\r\n---\r\n\r\nBody.\r\n');

    assert.equal(parsed.frontMatter?.model, 'model-a');
    assert.equal(parsed.text.trim(), 'Body.');
  });

  it('leaves a file with no header exactly as it is', () => {
    const text = 'Summarize {{items}} and list what needs attention.';
    const parsed = parsePromptFile(text);

    assert.equal(parsed.text, text);
    assert.equal(parsed.frontMatter, undefined);
  });

  it('does not mistake a horizontal rule for a header', () => {
    // An opening delimiter with no closing one is a document that begins with a rule. Cutting at
    // the next one would take the first paragraph with it.
    const text = '---\n\nA document that opens with a rule and never closes it.';
    assert.equal(parsePromptFile(text).text, text);
  });

  it('ignores a key it does not understand rather than guessing', () => {
    const parsed = parsePromptFile(
      ['---', 'description: Something', 'agent:', '  nested: value', '---', 'Body.'].join('\n'),
    );

    assert.equal(parsed.frontMatter?.description, 'Something');
    assert.deepEqual(parsed.frontMatter?.tools, []);
    assert.equal(parsed.text, 'Body.');
  });

  it('drops the quotes a header may use, and the blank line under it', () => {
    const parsed = parsePromptFile(['---', 'model: "model-a"', '---', '', '', 'Body.'].join('\n'));

    assert.equal(parsed.frontMatter?.model, 'model-a');
    assert.equal(parsed.text, 'Body.');
  });

  it('reports an empty header as a header, so the text is still the text', () => {
    const parsed = parsePromptFile(['---', '---', 'Body.'].join('\n'));

    assert.deepEqual(parsed.frontMatter, { tools: [] });
    assert.equal(parsed.text, 'Body.');
  });
});
