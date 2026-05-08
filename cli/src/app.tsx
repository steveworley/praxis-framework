import React, { useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { emptyForm, type Form, type Organisation, type RoleDefinition } from './state/form.js';
import { firstStep, type Step } from './state/steps.js';
import { Welcome } from './flows/welcome.js';
import { OrganisationFlow } from './flows/organisation.js';
import { RoleDefinitionFlow } from './flows/role-definition.js';
import { PathChoiceFlow } from './flows/path-choice.js';
import { Stub } from './flows/stub.js';
import { CompactHeader } from './ui/header.js';
import { ok, accent, muted, warn } from './ui/theme.js';

interface Props {
  scaffoldPath: string;
}

/** Human-readable wayfinding label per step. Shown in the compact header. */
const STEP_CONTEXT: Record<Step, string> = {
  welcome: 'welcome',
  organisation: 'organisation',
  'role-definition': 'role definition',
  'path-choice': 'path',
  'stub-voice': 'voice & traits',
  'stub-review': 'review',
  done: 'done',
};

export const App = ({ scaffoldPath }: Props) => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(firstStep());
  const [form, setForm] = useState<Form>(emptyForm());
  const [cancelled, setCancelled] = useState(false);

  const cancel = () => {
    setCancelled(true);
    exit();
  };

  const goTo = (next: Step) => setStep(next);

  if (cancelled) {
    return (
      <Box flexDirection="column">
        <CompactHeader context="cancelled" />
        <Text>{warn('cancelled')} — no changes were written.</Text>
      </Box>
    );
  }

  // Welcome owns its own full hero header, so we render it without the
  // compact one. Every other step gets the compact header at top.
  if (step === 'welcome') {
    return <Welcome onNext={() => goTo('organisation')} onCancel={cancel} />;
  }

  const compactHeader = <CompactHeader context={STEP_CONTEXT[step]} />;

  if (step === 'organisation') {
    return (
      <Box flexDirection="column">
        {compactHeader}
        <OrganisationFlow
          initial={form.organisation}
          onCancel={cancel}
          onNext={(next: Partial<Organisation>) => {
            setForm({ ...form, organisation: next });
            goTo('role-definition');
          }}
        />
      </Box>
    );
  }

  if (step === 'role-definition') {
    return (
      <Box flexDirection="column">
        {compactHeader}
        <RoleDefinitionFlow
          initial={form.role_definition}
          onCancel={cancel}
          onNext={(next: Partial<RoleDefinition>) => {
            setForm({ ...form, role_definition: next });
            goTo('path-choice');
          }}
        />
      </Box>
    );
  }

  if (step === 'path-choice') {
    return (
      <Box flexDirection="column">
        {compactHeader}
        <PathChoiceFlow
          onCancel={cancel}
          onNext={(path) => {
            setForm({ ...form, path });
            goTo('stub-voice');
          }}
        />
      </Box>
    );
  }

  if (step === 'stub-voice') {
    return (
      <Box flexDirection="column">
        {compactHeader}
        <Stub
          title="Voice & traits"
          form={form}
          onCancel={cancel}
          onNext={() => goTo('stub-review')}
        />
      </Box>
    );
  }

  if (step === 'stub-review') {
    return (
      <Box flexDirection="column">
        {compactHeader}
        <Stub
          title="Review"
          form={form}
          onCancel={cancel}
          onNext={() => goTo('done')}
        />
      </Box>
    );
  }

  // 'done'
  return (
    <Box flexDirection="column">
      {compactHeader}
      <Text>{ok('Done.')}</Text>
      <Box marginTop={1}>
        <Text>
          {muted('Scaffold ends here — the seed flow comes in a follow-up.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          {muted('Target path:')} {accent(scaffoldPath)}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{muted('Captured form:')}</Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          {muted('organisation:')} {JSON.stringify(form.organisation)}
        </Text>
        <Text>
          {muted('role_definition:')} {JSON.stringify(form.role_definition)}
        </Text>
        <Text>
          {muted('path:')} {form.path}
        </Text>
      </Box>
    </Box>
  );
};
