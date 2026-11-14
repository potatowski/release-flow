'use strict';

const { detectPhase, runPrepare, runFinalize } = require('./phases.cjs');

async function main() {
  // The @actions packages are ESM-only; eager mode keeps them in the single bundle.
  const core = await import(/* webpackMode: "eager" */ '@actions/core');
  const github = await import(/* webpackMode: "eager" */ '@actions/github');

  try {
    const inputs = {
      stagingBranch: core.getInput('staging_branch') || 'dev',
      mainBranch: core.getInput('main_branch') || 'main',
      updateMajorTag: core.getInput('update_major_tag').trim().toLowerCase() === 'true',
    };
    const { context } = github;

    const phase = detectPhase({
      override: core.getInput('phase'),
      ref: context.ref,
      stagingBranch: inputs.stagingBranch,
      mainBranch: inputs.mainBranch,
    });
    if (!phase) {
      core.info(
        `Ref ${context.ref} is neither ${inputs.stagingBranch} nor ${inputs.mainBranch}; nothing to do.`,
      );
      return;
    }
    core.info(`Running ${phase} phase.`);

    const octokit = github.getOctokit(core.getInput('github_token', { required: true }));
    const log = { info: core.info, warning: core.warning };
    const run = phase === 'prepare' ? runPrepare : runFinalize;
    const result = await run({ octokit, context, inputs, log });

    core.setOutput('next_version', result.nextVersion || '');
    core.setOutput('release_body', result.body || '');
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

main();
