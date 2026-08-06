/**
 * Scoring — deliberately arithmetic, with no model involved.
 *
 * The number on the badge is the part people will argue with, so it has to be
 * reproducible: same verdicts in, same score out, forever. A model deciding the
 * score would make it unfalsifiable and unexplainable at the same time.
 */

/** How much a verdict counts toward accuracy. */
const VERDICT_VALUE = {
  supported: 1,
  misleading: 0.35,
  contradicted: 0
};

/** How load-bearing the claim is. A false aside is not a false thesis. */
const CENTRALITY_WEIGHT = { core: 3, supporting: 2, aside: 1 };

/**
 * Unverified claims are excluded from accuracy rather than counted against it.
 * Failing to find evidence is not evidence of falsehood, and treating it as
 * such would punish videos about obscure subjects.
 */
export function scoreAccuracy(claims) {
  let weighted = 0;
  let total = 0;
  let judged = 0;

  for (const claim of claims) {
    const value = VERDICT_VALUE[claim.verdict];
    if (value === undefined) continue;
    const weight = CENTRALITY_WEIGHT[claim.centrality] ?? 1;
    weighted += weight * value;
    total += weight;
    judged += 1;
  }

  return { accuracy: total ? Math.round((weighted / total) * 100) : null, judged };
}

/**
 * Confidence is about evidence volume, not about the model's certainty.
 * It is what stops a single checked claim being displayed as if it were a
 * settled assessment.
 */
export function scoreConfidence(judged) {
  if (judged === 0) return 0;
  if (judged < 3) return 25;
  if (judged < 6) return 50;
  if (judged < 12) return 75;
  return 100;
}

export function composite({ accuracy, framing, sourcing }) {
  const parts = [
    { value: accuracy, weight: 0.6 },
    { value: framing, weight: 0.25 },
    { value: sourcing, weight: 0.15 }
  ].filter((part) => typeof part.value === 'number');

  if (!parts.length) return null;
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  return Math.round(parts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight);
}

export function scoreVideo({ claims, framing, sourcing }) {
  const { accuracy, judged } = scoreAccuracy(claims);
  const counts = claims.reduce((tally, claim) => {
    tally[claim.verdict] = (tally[claim.verdict] ?? 0) + 1;
    return tally;
  }, {});

  return {
    accuracy,
    framing,
    sourcing,
    composite: composite({ accuracy, framing, sourcing }),
    confidence: scoreConfidence(judged),
    claimCount: claims.length,
    judged,
    counts
  };
}

/** Six month half-life: a channel's past is relevant but not permanent. */
const HALF_LIFE_DAYS = 182;

export function scoreChannel(videoScores, now = Date.now()) {
  const usable = videoScores.filter((video) => typeof video.composite === 'number');
  if (!usable.length) return null;

  let weighted = 0;
  let total = 0;
  let claims = 0;

  for (const video of usable) {
    const ageDays = (now - (video.checkedAt ?? now)) / 86_400_000;
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    // A video with more checked claims says more about the channel.
    const weight = recency * Math.min(video.judged ?? 1, 20);
    weighted += video.composite * weight;
    total += weight;
    claims += video.claimCount ?? 0;
  }

  return {
    composite: total ? Math.round(weighted / total) : null,
    videos: usable.length,
    claims,
    confidence: scoreConfidence(usable.reduce((sum, video) => sum + (video.judged ?? 0), 0))
  };
}
