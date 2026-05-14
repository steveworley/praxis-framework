export const STEPS = [
  'welcome',
  'organisation',
  'role-definition',
  'path-choice',
  'tool-selection',
  'voice',
  'capabilities',
  'accountabilities',
  'success-criteria',
  'inhibitions',
  'initial-verbs',
  'review',
  'wrote',
] as const;

export type Step = (typeof STEPS)[number];

export const firstStep = (): Step => STEPS[0];

export const nextStep = (current: Step): Step | null => {
  const idx = STEPS.indexOf(current);
  if (idx === -1 || idx === STEPS.length - 1) return null;
  return STEPS[idx + 1] ?? null;
};

export const previousStep = (current: Step): Step | null => {
  const idx = STEPS.indexOf(current);
  if (idx <= 0) return null;
  return STEPS[idx - 1] ?? null;
};

export const isLastStep = (current: Step): boolean =>
  current === STEPS[STEPS.length - 1];
