import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { draftActionsFor, loadReadyCommit } from './approval.ts';
import { STATUS_ENUM, type OutputStatus } from './types.ts';

describe('draftActionsFor', () => {
  const cases: [OutputStatus, { canApprove: boolean; canMarkSent: boolean; approved: boolean }][] =
    [
      ['draft', { canApprove: true, canMarkSent: true, approved: false }],
      ['review', { canApprove: true, canMarkSent: true, approved: false }],
      ['ready', { canApprove: false, canMarkSent: true, approved: true }],
      ['sent', { canApprove: false, canMarkSent: false, approved: false }],
      ['done', { canApprove: false, canMarkSent: false, approved: false }],
      ['archived', { canApprove: false, canMarkSent: false, approved: false }],
    ];

  it('covers every status in the lifecycle enum', () => {
    expect(cases.map(([status]) => status).sort()).toEqual([...STATUS_ENUM].sort());
  });

  it.each(cases)('status %s → %o', (status, expected) => {
    expect(draftActionsFor(status)).toEqual(expected);
  });

  it('offers Approve on ready when the ready commit was not by the operator', () => {
    expect(draftActionsFor('ready', { byOperator: false }).canApprove).toBe(true);
  });

  it('hides Approve on ready when the operator already approved', () => {
    expect(draftActionsFor('ready', { byOperator: true }).canApprove).toBe(false);
  });

  it('hides Approve on ready when the approver is unknown', () => {
    expect(draftActionsFor('ready', null).canApprove).toBe(false);
  });

  it('ignores the ready commit for non-ready statuses', () => {
    expect(draftActionsFor('sent', { byOperator: false }).canApprove).toBe(false);
    expect(draftActionsFor('draft', { byOperator: true }).canApprove).toBe(true);
  });
});

describe('loadReadyCommit', () => {
  const REL = 'output/draft/cold-mary.md';
  const OPERATOR = { name: 'Steve Operator', email: 'steve@example.test' };
  const ROLE = { name: 'Praxis Role', email: 'role@praxis.local' };

  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-approval-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function initRepo(): Promise<void> {
    await simpleGit(tempDir).init();
  }

  async function writeDraft(status: string, body = 'Hi Mary.'): Promise<void> {
    const abs = path.join(tempDir, REL);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(
      abs,
      ['---', 'type: draft', 'slug: cold-mary', `status: ${status}`, '---', '', body].join('\n'),
      'utf-8',
    );
  }

  async function commitAs(who: { name: string; email: string }, subject: string): Promise<void> {
    const git = simpleGit(tempDir);
    await git.raw(['add', '-A', '--', REL]);
    await git.raw([
      '-c',
      `user.name=${who.name}`,
      '-c',
      `user.email=${who.email}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      `--author=${who.name} <${who.email}>`,
      '--no-gpg-sign',
      '-m',
      subject,
    ]);
  }

  it('returns the operator commit that set ready', async () => {
    await initRepo();
    await writeDraft('draft');
    await commitAs(ROLE, 'role(output): write draft cold-mary');
    await writeDraft('ready');
    await commitAs(OPERATOR, 'operator(output): status cold-mary: draft → ready');

    const result = await loadReadyCommit(tempDir, REL);
    expect(result).not.toBeNull();
    expect(result?.authorName).toBe(OPERATOR.name);
    expect(result?.authorEmail).toBe(OPERATOR.email);
    expect(result?.byOperator).toBe(true);
    expect(result?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('flags a ready set by the role itself as not operator-approved', async () => {
    await initRepo();
    await writeDraft('draft');
    await commitAs(ROLE, 'role(output): write draft cold-mary');
    await writeDraft('ready');
    await commitAs(ROLE, 'role(output): status cold-mary: draft → ready');

    const result = await loadReadyCommit(tempDir, REL);
    expect(result?.authorEmail).toBe(ROLE.email);
    expect(result?.byOperator).toBe(false);
  });

  it('ignores later commits that edit the body without touching status', async () => {
    await initRepo();
    await writeDraft('draft');
    await commitAs(ROLE, 'role(output): write draft cold-mary');
    await writeDraft('ready');
    await commitAs(OPERATOR, 'operator(output): status cold-mary: draft → ready');
    await writeDraft('ready', 'Hi Mary, edited.');
    await commitAs(ROLE, 'role(output): tweak body');

    const result = await loadReadyCommit(tempDir, REL);
    expect(result?.authorEmail).toBe(OPERATOR.email);
    expect(result?.byOperator).toBe(true);
  });

  it('attributes a role re-ready after an operator approval to the role', async () => {
    await initRepo();
    await writeDraft('draft');
    await commitAs(ROLE, 'role(output): write draft cold-mary');
    await writeDraft('ready');
    await commitAs(OPERATOR, 'operator(output): status cold-mary: draft → ready');
    await writeDraft('review');
    await commitAs(ROLE, 'role(output): status cold-mary: ready → review');
    await writeDraft('ready');
    await commitAs(ROLE, 'role(output): status cold-mary: review → ready');

    const result = await loadReadyCommit(tempDir, REL);
    expect(result?.byOperator).toBe(false);
  });

  it('returns null when the role home is not a git repo', async () => {
    await writeDraft('ready');
    expect(await loadReadyCommit(tempDir, REL)).toBeNull();
  });

  it('returns null when the file has no committed history', async () => {
    await initRepo();
    await writeDraft('ready');
    expect(await loadReadyCommit(tempDir, REL)).toBeNull();
  });
});
