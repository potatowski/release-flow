'use strict';

const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const PLACEHOLDERS = new Set(['', '-', 'n/a', 'na', 'none', 'tbd']);

const H2 = /^ {0,3}##(?!#)\s*(.*?)\s*#*\s*$/;
const H3 = /^ {0,3}###(?!#)\s*(.*?)\s*#*\s*$/;
const BULLET = /^ ?[-*](?:\s+(.*))?$/;
const CONTINUATION = /^(?: {2,}|\t)\s*\S/;

function emptySections() {
  return Object.fromEntries(SECTIONS.map((name) => [name, []]));
}

function sectionName(heading) {
  const letters = heading.replace(/[^a-z]/gi, '').toLowerCase();
  return SECTIONS.find((name) => name.toLowerCase() === letters) || null;
}

function isPlaceholder(text) {
  return PLACEHOLDERS.has(
    text
      .trim()
      .toLowerCase()
      .replace(/[.!,;:]+$/, '')
      .trim(),
  );
}

/**
 * Extracts changelog items from a pull request body.
 * Returns an object keyed by section name with arrays of item strings.
 */
function parseChangelog(body) {
  const sections = emptySections();
  if (!body) return sections;

  const lines = String(body)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/);

  const start = lines.findIndex((line) => {
    const match = H2.exec(line);
    return match && /changelog entry/i.test(match[1]);
  });
  if (start === -1) return sections;

  let section = null;
  let item = null;

  const flush = () => {
    if (section && item !== null && !isPlaceholder(item)) {
      sections[section].push(item.trim());
    }
    item = null;
  };

  for (const line of lines.slice(start + 1)) {
    if (H2.test(line)) break;

    const h3 = H3.exec(line);
    if (h3) {
      flush();
      section = sectionName(h3[1]);
      continue;
    }
    if (!section) continue;

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      item = (bullet[1] || '').trim();
      continue;
    }

    if (item !== null && CONTINUATION.test(line)) {
      item = `${item} ${line.trim()}`.trim();
      continue;
    }

    flush();
  }
  flush();

  return sections;
}

function stripNoise(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '');
}

function breakingLabel(body) {
  const match = /\*\*Breaking Change:\*\*(.*)$/im.exec(body);
  if (!match) return false;
  const answer = match[1].replace(/\(\s*yes\s*\/\s*no\s*\)/gi, '');
  return /\byes\b/i.test(answer) && !/\bno\b/i.test(answer);
}

function isBreaking(pr) {
  const body = stripNoise(pr.body);
  const title = pr.title || '';
  return (
    breakingLabel(body) ||
    /^BREAKING[ -]CHANGE:/m.test(body) ||
    /^\s*\w+(\([^)]*\))?!:/.test(title)
  );
}

/**
 * Aggregates changelog entries from a list of pull requests.
 * Each entry keeps the pull request number it came from.
 */
function aggregate(prs) {
  const sections = emptySections();
  let breaking = false;
  let total = 0;

  for (const pr of prs) {
    const parsed = parseChangelog(pr.body);
    for (const name of SECTIONS) {
      for (const text of parsed[name]) {
        sections[name].push({ text, number: pr.number });
        total += 1;
      }
    }
    if (isBreaking(pr)) breaking = true;
  }

  return { sections, breaking, total };
}

function renderSections(agg, level = 3) {
  const hashes = '#'.repeat(level);
  return SECTIONS.filter((name) => agg.sections[name].length > 0)
    .map((name) => {
      const items = agg.sections[name].map((entry) => `- ${entry.text} (#${entry.number})`);
      return `${hashes} ${name}\n\n${items.join('\n')}`;
    })
    .join('\n\n');
}

function renderPullRequests(prs) {
  return prs.map((pr) => `- #${pr.number} ${pr.title}`).join('\n');
}

module.exports = {
  SECTIONS,
  parseChangelog,
  isBreaking,
  aggregate,
  renderSections,
  renderPullRequests,
};
