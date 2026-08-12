export type AutomaticVoteResult = 'passed' | 'failed' | undefined;

export function nextUnvotedMemberID<T>(
  memberIDs: string[],
  currentMemberID: string,
  votes: Record<string, T>
): string | undefined {
  const currentIndex = memberIDs.indexOf(currentMemberID);
  const orderedAfterCurrent = [
    ...memberIDs.slice(currentIndex + 1),
    ...memberIDs.slice(0, Math.max(0, currentIndex))
  ];

  return orderedAfterCurrent.find(memberID => votes[memberID] === undefined);
}

export function getAutomaticVoteResult(input: {
  eligibleVoters: number;
  votesFor: number;
  votesCast: number;
  threshold: number;
  vetoed?: boolean;
  requireAllVotes?: boolean;
}): AutomaticVoteResult {
  const {
    eligibleVoters,
    votesFor,
    votesCast,
    threshold,
    vetoed = false,
    requireAllVotes = false
  } = input;

  if (requireAllVotes && votesCast < eligibleVoters) {
    return undefined;
  }
  if (vetoed) {
    return undefined;
  }
  if (eligibleVoters <= 0) {
    return 'failed';
  }
  if (votesFor >= threshold) {
    return 'passed';
  }

  const remaining = Math.max(0, eligibleVoters - votesCast);
  return votesFor + remaining < threshold ? 'failed' : undefined;
}
