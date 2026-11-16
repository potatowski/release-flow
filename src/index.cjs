'use strict';

const phases = require('./phases.cjs');
const { runAction } = require('./action.cjs');

async function main() {
  // The @actions packages are ESM-only; eager mode keeps them in the single bundle.
  const core = await import(/* webpackMode: "eager" */ '@actions/core');
  const github = await import(/* webpackMode: "eager" */ '@actions/github');
  await runAction({ core, github, env: process.env, fetch: globalThis.fetch, phases });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
