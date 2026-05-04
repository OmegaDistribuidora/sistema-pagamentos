export function normalizeSupervisorCodesInput(input: Array<number | string | null | undefined>): number[] {
  const normalized: number[] = [];
  const seen = new Set<number>();

  for (const item of input) {
    const value = Number(item);
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function getEffectiveSupervisorCodes(user: {
  supervisorCode?: number | null;
  supervisorCodes?: number[] | null;
}): number[] {
  const nextCodes = normalizeSupervisorCodesInput(user.supervisorCodes || []);
  if (nextCodes.length) {
    return nextCodes;
  }

  const legacyCode = Number(user.supervisorCode || 0);
  return Number.isInteger(legacyCode) && legacyCode > 0 ? [legacyCode] : [];
}

export function hasSupervisorCodeAccess(
  user: {
    role?: "ADMIN" | "USER";
    supervisorCode?: number | null;
    supervisorCodes?: number[] | null;
  },
  targetSupervisorCode: number
): boolean {
  if (user.role === "ADMIN") {
    return true;
  }

  return getEffectiveSupervisorCodes(user).includes(Number(targetSupervisorCode));
}
