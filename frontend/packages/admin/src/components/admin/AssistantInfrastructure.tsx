/**
 * WHERE AN ASSISTANT LIVES IN AWS: every resource that serves it, each linked to its own console page.
 *
 * Three kinds, said in place, because the difference decides what an operator may change from here
 * (ADR-054): the assistant's OWN resources (its identity, its Amazon Lex bot, its definition), the ones
 * SHARED BY ITS CLASSIFICATION'S ASSISTANTS (the processor, the router, the acting role and its boundary),
 * and the ones SHARED BY THE DEPLOYMENT (the channel flow). A change to a shared resource changes every
 * assistant that shares it, and is a deploy.
 *
 * Every identifier comes from the server's live resolution (`resolved`, `lib/profile-infra.ts`). One that
 * was not resolved says so; it never falls back to a list or search page that names a different resource.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedInfra } from '../../services/profileService';
import { DocLink } from './AdminHelp';
import {
  awsRegion,
  bedrockGuardrailUrl,
  cloudwatchLogGroupUrl,
  cloudwatchLogsUrl,
  describeCommand,
  iamPolicyUrl,
  iamRoleUrl,
  lambdaFunctionUrl,
  lexBotUrl,
  s3PrefixUrl,
  ssmParameterUrl,
} from '../../services/awsConsole';

const DIRECTORY = 'directory';
const LOGS_KEY = 'admin.infra.logs';

interface Row {
  id: string;
  /** The link, when the resource has a console page and was resolved. */
  href?: string;
  /** What is shown: the resource's name or id. */
  value?: string;
  /** A second link, to the resource's logs. */
  logs?: string;
  /** The CLI command for a resource with no console page. */
  command?: string;
}

/** An AWS console page, opened like every external link in the console (`DocLink`). */
const Ext: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <DocLink href={href}>{children}</DocLink>
);

/** The rows of each scope, built from what the server resolved. */
export function infrastructureRows(r: ResolvedInfra | undefined): Record<'assistant' | 'classification' | 'deployment', Row[]> {
  const region = r?.region || awsRegion();
  const ssm = (name?: string) => (name ? { href: ssmParameterUrl(name, region), value: name } : {});
  const fn = (name?: string) => (name
    ? { href: lambdaFunctionUrl(name, region), value: name, logs: cloudwatchLogsUrl(name, undefined, region) }
    : {});
  return {
    assistant: [
      { id: 'identity', ...(r?.botArn ? { value: r.botArn, command: describeCommand(r.botArn, region) } : {}) },
      { id: 'lexBot', ...(r?.lexBotId ? { href: lexBotUrl(r.lexBotId, region), value: r.lexBotAliasId ? `${r.lexBotId} / ${r.lexBotAliasId}` : r.lexBotId } : {}) },
      { id: 'definition', ...ssm(r?.definitionParam) },
      { id: 'assignment', ...ssm(r?.assignmentParam) },
      ...(r?.directoryParam ? [{ ...ssm(r.directoryParam), id: DIRECTORY }] : []),
      { id: 'bodies', ...(r?.profileBodies ? { href: s3PrefixUrl(r.profileBodies.bucket, r.profileBodies.prefix, region), value: `${r.profileBodies.bucket}/${r.profileBodies.prefix}` } : {}) },
    ],
    classification: [
      { id: 'actingRole', ...(r?.actingRoleName ? { href: iamRoleUrl(r.actingRoleName), value: r.actingRoleName } : {}) },
      { id: 'boundary', ...(r?.boundaryPolicyArn ? { href: iamPolicyUrl(r.boundaryPolicyArn), value: r.boundaryPolicyName ?? r.boundaryPolicyArn } : {}) },
      { id: 'processor', ...fn(r?.processorFunctionName) },
      { id: 'router', ...fn(r?.routerFunctionName) },
      { id: 'guardrail', ...(r?.guardrailId && r.guardrailName ? { href: bedrockGuardrailUrl(r.guardrailName, r.guardrailId, region), value: `${r.guardrailName} (${r.guardrailId})` } : r?.guardrailId ? { value: r.guardrailId } : {}) },
      { id: 'templates', ...(r?.templates ? { href: s3PrefixUrl(r.templates.bucket, r.templates.prefix, region), value: `${r.templates.bucket}/${r.templates.prefix}` } : {}) },
      { id: 'lexLogs', ...(r?.lexLogGroup ? { href: cloudwatchLogGroupUrl(r.lexLogGroup, undefined, region), value: r.lexLogGroup } : {}) },
    ],
    deployment: [
      { id: 'channelFlow', ...(r?.channelFlowArn ? { value: r.channelFlowArn, command: describeCommand(r.channelFlowArn, region) } : {}) },
      { id: 'channelFlowProcessor', ...fn(r?.channelFlowProcessorFunctionName) },
    ],
  };
}

const AssistantInfrastructure: React.FC<{ resolved?: ResolvedInfra; classification?: string }> = ({ resolved, classification }) => {
  const { t } = useTranslation();
  const rows = infrastructureRows(resolved);
  const c = resolved?.classification ?? classification ?? '';
  const scopeTitle = {
    assistant: t('admin.infra.scope.assistant'),
    classification: t('admin.infra.scope.classification', { classification: c }),
    deployment: t('admin.infra.scope.deployment'),
  };
  return (
    <div data-testid="assistant-infrastructure">
      {(['assistant', 'classification', 'deployment'] as const).map((scope) => (
        <div key={scope} data-infra-scope={scope}>
          <h5>{scopeTitle[scope]}</h5>
          <p className="admin-field-hint">{t(`admin.infra.scopeHelp.${scope}`)}</p>
          <dl className="admin-config-list">
            {rows[scope].map((row) => (
              <React.Fragment key={row.id}>
                <dt>{t(`admin.infra.row.${row.id}`)}</dt>
                <dd data-infra-row={row.id}>
                  {row.href
                    ? <Ext href={row.href}><code>{row.value}</code></Ext>
                    : row.value
                      ? <code>{row.value}</code>
                      : <span className="admin-muted">{t('admin.infra.notResolved')}</span>}
                  {row.logs && <> <Ext href={row.logs}>{t(LOGS_KEY)}</Ext></>}
                  {row.command && (
                    <div className="admin-field-hint">
                      {t('admin.infra.noConsolePage')} <code>{row.command}</code>
                    </div>
                  )}
                  <div className="admin-field-hint">{t(`admin.infra.what.${row.id}`)}</div>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
};

export default AssistantInfrastructure;
