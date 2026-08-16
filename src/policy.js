/**
 * Decide whether a GitHub issue is eligible for a registered repository.
 * This module deliberately has no command or network dependencies.
 */
export function evaluateIssueEligibility(repository, issue) {
  if (!repository || repository.active === false) {
    return { eligible: false, reason: 'repository-inactive' };
  }
  if (repository.public === false || repository.isPublic === false) {
    return { eligible: false, reason: 'repository-not-public' };
  }

  const state = String(issue?.state ?? '').toLowerCase();
  if (state !== 'open') return { eligible: false, reason: 'issue-not-open' };

  if ((issue?.assignees ?? []).length > 0) {
    return { eligible: false, reason: 'issue-assigned' };
  }

  const policy = repository.policy ?? {};
  const labels = (issue?.labels ?? []).map(label =>
    String(typeof label === 'string' ? label : label?.name ?? '').trim(),
  ).filter(Boolean);
  const normalizedLabels = new Set(labels.map(label => label.toLowerCase()));
  const blockingLabels = repository.blockingLabels ?? policy.blockingLabels ?? [];
  if (blockingLabels.some(label => normalizedLabels.has(String(label).trim().toLowerCase()))) {
    return { eligible: false, reason: 'blocking-label' };
  }

  const requiredLabel = repository.requiredLabel ?? policy.requiredLabel;
  if (requiredLabel && !normalizedLabels.has(String(requiredLabel).trim().toLowerCase())) {
    return { eligible: false, reason: 'missing-required-label' };
  }

  return { eligible: true, reason: 'eligible' };
}
