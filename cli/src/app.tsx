import React, { useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { emptyForm, type Form, type Organisation, type RoleDefinition } from './state/form.js';
import { firstStep, type Step } from './state/steps.js';
import { Welcome } from './flows/welcome.js';
import { OrganisationFlow } from './flows/organisation.js';
import { RoleDefinitionFlow } from './flows/role-definition.js';
import { PathChoiceFlow } from './flows/path-choice.js';
import { Stub } from './flows/stub.js';
import { ok, accent, muted, warn } from './ui/theme.js';

interface Props {
  scaffoldPath: string;
}

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
        <Text>{warn('cancelled')} — no changes were written.</Text>
      </Box>
    );
  }

  if (step === 'welcome') {
    return (
      <Welcome onNext={() => goTo('organisation')} onCancel={cancel} />
    );
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
          goTo('stub-voice');
        }}
      />
    );
  }

  if (step === 'stub-voice') {
    return (
      <Stub
        title="Voice & traits"
        form={form}
        onCancel={cancel}
        onNext={() => goTo('stub-review')}
      />
    );
  }

  if (step === 'stub-review') {
    return (
      <Stub
        title="Review"
        form={form}
        onCancel={cancel}
        onNext={() => goTo('done')}
      />
    );
  }

  // 'done'
  return (
    <Box flexDirection="column">
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
