/** Accept only a newly recorded review by the expected independent account on this head.
 * Input order is GitHub's chronological review history; dismissed/pending latest reviews
 * deliberately invalidate earlier approval rather than falling back to it. */
export function reviewVerdict({ reviews, reviewerLogin, authorLogin, headSha, previousCount = 0 }) {
  if (!Array.isArray(reviews) || !reviewerLogin || !authorLogin || reviewerLogin.toLowerCase() === authorLogin.toLowerCase() || !headSha) return null;
  const matching = reviews.filter(review => review.author?.login?.toLowerCase() === reviewerLogin.toLowerCase());
  if (matching.length <= previousCount) return null;
  const latest = matching.at(-1);
  if (latest.commit?.oid !== headSha) return null;
  return { APPROVED: 'approve', CHANGES_REQUESTED: 'request-changes', COMMENTED: 'comment' }[latest.state] ?? null;
}
