'use strict';

const { AUDIENCE, resolveToken, revokeToken } = require('./token.cjs');

/**
 * Action body with injected dependencies (@actions/core, @actions/github,
 * process.env, fetch and the phase functions).
 */
async function runAction({ core, github, env, fetch, phases }) {
  let token = null;
  let fromBroker = false;
  try {
    const inputs = {
      stagingBranch: core.getInput('staging_branch') || 'dev',
      mainBranch: core.getInput('main_branch') || 'main',
      updateMajorTag: core.getInput('update_major_tag').trim().toLowerCase() === 'true',
      since: core.getInput('since').trim(),
    };
    const { context } = github;

    const phase = phases.detectPhase({
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

    ({ token, fromBroker } = await resolveToken({
      githubToken: core.getInput('github_token').trim(),
      brokerUrl: core.getInput('token_broker_url').trim(),
      audience: AUDIENCE,
      serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
      getIDToken: core.getIDToken,
      fetch,
    }));
    core.setSecret(token);
    if (fromBroker) core.info('Using Changelog Release Flow app token.');

    const octokit = github.getOctokit(token);
    const log = { info: core.info, warning: core.warning };
    const run = phase === 'prepare' ? phases.runPrepare : phases.runFinalize;
    const result = await run({ octokit, context, inputs, log });

    core.setOutput('next_version', result.nextVersion || '');
    core.setOutput('release_body', result.body || '');
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  } finally {
    if (fromBroker) {
      await revokeToken({ token, apiUrl: env.GITHUB_API_URL || 'https://api.github.com', fetch });
    }
  }
}

module.exports = { runAction };
