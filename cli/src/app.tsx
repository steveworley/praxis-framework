import React, { useState } from 'react';
import { Box, Text, useApp } from 'ink';
import {
  emptyForm,
  type Form,
  type InitialVerb,
  type Organisation,
  type RoleDefinition,
  type VoiceTrait,
} from './state/form.js';
import { firstStep, type Step } from './state/steps.js';
import { Welcome } from './flows/welcome.js';
import { OrganisationFlow } from './flows/organisation.js';
import { RoleDefinitionFlow } from './flows/role-definition.js';
import { PathChoiceFlow } from './flows/path-choice.js';
import { ToolSelection } from './flows/tools.js';
import { VoiceFlow } from './flows/voice.js';
import { CapabilitiesFlow } from './flows/capabilities.js';
import { InhibitionsFlow } from './flows/inhibitions.js';
import { InitialVerbsFlow } from './flows/initial-verbs.js';
import { Review } from './flows/review.js';
import { Wrote } from './flows/wrote.js';
import { adaptFormToSeedInput } from './lib/seed-adapter.js';
import { Header } from './ui/header.js';
import type { Catalog } from './lib/catalog.js';
import type { SeedInput } from '@praxis-framework/seed';
import { warn } from './ui/theme.js';

interface Props {
  scaffoldPath: string;
  catalog: Catalog;
}

/**
 * Wraps the active step's content in a Box that always has the praxis
 * pixel-art Header at top. The Header is rendered once at the App level
 * and persists across every state transition — keeps the brand presence
 * consistent throughout the wizard.
 */
export const App = ({ scaffoldPath, catalog }: Props) => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(firstStep());
  const [form, setForm] = useState<Form>(emptyForm());
  const [seedInput, setSeedInput] = useState<SeedInput | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const cancel = () => {
    setCancelled(true);
    exit();
  };

  const goTo = (next: Step) => setStep(next);

  return (
    <Box flexDirection="column">
      <Header />
      {cancelled ? (
        <Text>{warn('cancelled')} — no changes were written.</Text>
      ) : (
        renderStep({
          step,
          form,
          setForm,
          seedInput,
          setSeedInput,
          goTo,
          cancel,
          exit,
          scaffoldPath,
          catalog,
        })
      )}
    </Box>
  );
};

interface StepArgs {
  step: Step;
  form: Form;
  setForm: (f: Form) => void;
  seedInput: SeedInput | null;
  setSeedInput: (input: SeedInput) => void;
  goTo: (s: Step) => void;
  cancel: () => void;
  exit: () => void;
  scaffoldPath: string;
  catalog: Catalog;
}

const renderStep = ({
  step,
  form,
  setForm,
  seedInput,
  setSeedInput,
  goTo,
  cancel,
  exit,
  scaffoldPath,
  catalog,
}: StepArgs) => {
  if (step === 'welcome') {
    return <Welcome onNext={() => goTo('organisation')} onCancel={cancel} />;
  }

  if (step === 'organisation') {
    return (
      <OrganisationFlow
        initial={form.organisation}
        onCancel={cancel}
        onNext={(next: Partial<Organisation>) => {
          setForm({ ...form, organisation: next });
          goTo('role-definition');
        }}
      />
    );
  }

  if (step === 'role-definition') {
    return (
      <RoleDefinitionFlow
        initial={form.role_definition}
        onCancel={cancel}
        onNext={(next: Partial<RoleDefinition>) => {
          setForm({ ...form, role_definition: next });
          goTo('path-choice');
        }}
      />
    );
  }

  if (step === 'path-choice') {
    return (
      <PathChoiceFlow
        onCancel={cancel}
        onNext={(path) => {
          setForm({ ...form, path });
          goTo('tool-selection');
        }}
      />
    );
  }

  if (step === 'tool-selection') {
    return (
      <ToolSelection
        catalog={catalog}
        initial={form.tools}
        onCancel={cancel}
        onNext={(tools) => {
          setForm({ ...form, tools });
          goTo('voice');
        }}
      />
    );
  }

  if (step === 'voice') {
    return (
      <VoiceFlow
        initial={form.voice_traits}
        onCancel={cancel}
        onNext={(voice_traits: VoiceTrait[]) => {
          setForm({ ...form, voice_traits });
          goTo('capabilities');
        }}
      />
    );
  }

  if (step === 'capabilities') {
    return (
      <CapabilitiesFlow
        initial={form.capabilities}
        onCancel={cancel}
        onNext={(capabilities: string[]) => {
          setForm({ ...form, capabilities });
          goTo('inhibitions');
        }}
      />
    );
  }

  if (step === 'inhibitions') {
    return (
      <InhibitionsFlow
        initial={form.inhibitions}
        onCancel={cancel}
        onNext={(inhibitions: string[]) => {
          setForm({ ...form, inhibitions });
          goTo('initial-verbs');
        }}
      />
    );
  }

  if (step === 'initial-verbs') {
    return (
      <InitialVerbsFlow
        initial={form.initial_verbs}
        onCancel={cancel}
        onNext={(initial_verbs: InitialVerb[]) => {
          setForm({ ...form, initial_verbs });
          goTo('review');
        }}
      />
    );
  }

  if (step === 'review') {
    return (
      <Review
        form={form}
        scaffoldPath={scaffoldPath}
        onCancel={cancel}
        onConfirm={() => {
          // Re-validate at the seam — the review screen has already shown
          // any issues, but we don't trust it to be the only source of
          // truth. If validation fails here it's a wizard bug.
          const result = adaptFormToSeedInput(form);
          if (!result.ok) return;
          setSeedInput(result.input);
          goTo('wrote');
        }}
      />
    );
  }

  // 'wrote'
  if (seedInput === null) {
    // Defensive: someone landed on `wrote` without a validated input.
    // Treat as cancellation rather than try to seed an empty form.
    return <Text>{warn('Internal: no seed input available — cancelled.')}</Text>;
  }
  return <Wrote input={seedInput} scaffoldPath={scaffoldPath} onExit={exit} />;
};
