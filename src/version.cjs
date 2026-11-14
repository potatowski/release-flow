'use strict';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseTag(tag) {
  const match = TAG.exec(String(tag || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function format(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Returns the highest `vX.Y.Z` tag among the given names, or null.
 */
function latestTag(names) {
  let best = null;
  for (const name of names) {
    const version = parseTag(name);
    if (version && (!best || compare(version, best.version) > 0)) {
      best = { tag: name.trim(), version };
    }
  }
  return best;
}

/**
 * Decides the bump type from aggregated changelog facts.
 * Returns { type, reason } or null when there is nothing to release.
 */
function decideBump({ breaking, added, total }, current) {
  if (!total) return null;
  if (breaking) {
    if (current.major === 0) {
      return { type: 'minor', reason: 'breaking change while major version is 0' };
    }
    return { type: 'major', reason: 'breaking change' };
  }
  if (added) return { type: 'minor', reason: 'new features added' };
  return { type: 'patch', reason: 'changes and fixes only' };
}

function bump(version, type) {
  switch (type) {
    case 'major':
      return { major: version.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: version.major, minor: version.minor + 1, patch: 0 };
    case 'patch':
      return { major: version.major, minor: version.minor, patch: version.patch + 1 };
    default:
      throw new Error(`Unknown bump type: ${type}`);
  }
}

const ZERO = Object.freeze({ major: 0, minor: 0, patch: 0 });

module.exports = { ZERO, parseTag, compare, format, latestTag, decideBump, bump };
