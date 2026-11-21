export type TimeCategory = "BULLET" | "BLITZ" | "RAPID";
export type GameOutcome = 1 | 0.5 | 0;

/**
 * Normalizes emails so a single Gmail account cannot be registered multiple times
 * using dot tricks (j.o.h.n@gmail.com) or plus aliases (john+1@gmail.com).
 */
export function normalizeEmail(rawEmail: string): string {
  const trimmed = rawEmail.trim().toLowerCase();
  const [localPart, domain] = trimmed.split("@");
  if (!localPart || !domain) return trimmed;

  if (domain === "gmail.com" || domain === "googlemail.com") {
    const withoutPlus = localPart.split("+")[0];
    const withoutDots = withoutPlus.replace(/\./g, "");
    return `${withoutDots}@gmail.com`;
  }

  return trimmed;
}

/**
 * Standard Elo calculation:
 * K = 32 for provisional players (< 30 games in that format), K = 16 for established players.
 */
export function calculateStandardElo(
  white: { elo: number; games: number },
  black: { elo: number; games: number },
  outcome: GameOutcome
) {
  const expectedWhite = 1 / (1 + Math.pow(10, (black.elo - white.elo) / 400));
  const expectedBlack = 1 - expectedWhite;

  const kWhite = white.games < 30 ? 32 : 16;
  const kBlack = black.games < 30 ? 32 : 16;

  const whiteDiff = Math.round(kWhite * (outcome - expectedWhite));
  const blackDiff = Math.round(kBlack * (1 - outcome - expectedBlack));

  return {
    whiteNewElo: Math.max(100, white.elo + whiteDiff),
    blackNewElo: Math.max(100, black.elo + blackDiff),
    whiteDiff,
    blackDiff,
  };
}
