import { z } from 'zod';

export const Organisation = z.object({
  name: z.string().min(1),
  website: z.string().optional(),
  sector: z.string().optional(),
  size: z.enum(['solo', 'small', 'mid', 'large', 'enterprise']).optional(),
  description: z.string().optional(),
  moats: z.string().optional(),
  customer_profile: z.string().optional(),
});

export const RoleDefinition = z.object({
  role_name: z.string().min(1),
  working_title: z.string().optional(),
  one_sentence_purpose: z.string().min(1),
  day_to_day: z.string().optional(),
});

export const Form = z.object({
  organisation: Organisation.partial(),
  role_definition: RoleDefinition.partial(),
  path: z.enum(['research', 'manual', 'unset']).default('unset'),
  // voice_traits, capabilities, inhibitions, initial_agents — added later
});

export type Organisation = z.infer<typeof Organisation>;
export type RoleDefinition = z.infer<typeof RoleDefinition>;
export type Form = z.infer<typeof Form>;

export const emptyForm = (): Form => ({
  organisation: {},
  role_definition: {},
  path: 'unset',
});
