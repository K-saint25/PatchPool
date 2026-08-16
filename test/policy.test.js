import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIssueEligibility } from '../src/policy.js';

const repository = {
  active: true,
  public: true,
  requiredLabel: 'patchpool-ready',
  blockingLabels: ['blocked', 'wontfix'],
};

const issue = (overrides = {}) => ({
  state: 'open',
  assignees: [],
  labels: [{ name: 'patchpool-ready' }],
  ...overrides,
});

test('accepts an open unassigned issue with the required label', () => {
  assert.deepEqual(evaluateIssueEligibility(repository, issue()), { eligible: true, reason: 'eligible' });
});

test('rejects inactive or private repositories', () => {
  assert.equal(evaluateIssueEligibility({ ...repository, active: false }, issue()).reason, 'repository-inactive');
  assert.equal(evaluateIssueEligibility({ ...repository, public: false }, issue()).reason, 'repository-not-public');
});

test('rejects closed, assigned, blocked, and missing-label issues', () => {
  assert.equal(evaluateIssueEligibility(repository, issue({ state: 'closed' })).reason, 'issue-not-open');
  assert.equal(evaluateIssueEligibility(repository, issue({ assignees: [{ login: 'octo' }] })).reason, 'issue-assigned');
  assert.equal(evaluateIssueEligibility(repository, issue({ labels: [{ name: 'blocked' }, { name: 'patchpool-ready' }] })).reason, 'blocking-label');
  assert.equal(evaluateIssueEligibility(repository, issue({ labels: [] })).reason, 'missing-required-label');
});

test('does not require a label when the repository policy has none', () => {
  assert.deepEqual(
    evaluateIssueEligibility({ ...repository, requiredLabel: null }, issue({ labels: [] })),
    { eligible: true, reason: 'eligible' },
  );
});
