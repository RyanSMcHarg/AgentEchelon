/**
 * WHAT THE ROLE'S ROLLOUT ACTUALLY CREATED, read back from the deployment.
 *
 * A second assistant inside one classification is the least visible thing this platform does: nothing
 * about the chat window says whether the answer came from a different principal with a different
 * reach, or from the same one with a different prompt. So the demo shows the infrastructure the deploy
 * produced, by name, and the profile that governs the assistant's behavior - the two halves of the
 * behavior/boundary split this design rests on.
 *
 * READ BACK FROM AWS RATHER THAN PRINTED FROM CONFIG. The question a viewer has is "is that really
 * deployed", and a script that echoes its own source answers a different one.
 *
 * ROLLOUT AND ROLLBACK ARE ONE DECLARATION, and the script says so at the end rather than leaving it implied:
 * the role exists because the deployment names its assistant in `profiles` (`npm run add-assistant-role`),
 * and deploying without the name (`npm run add-assistant-role -- --remove`) takes every artifact below away again.
 *
 * Usage: node scripts/show-ops-rollout.mjs [classification] [role]
 *
 * The role defaults to `ops`, and the classification to the first one this deployment declares holding
 * that role (`lib/deployment-profiles.mjs`, so the registry is the deployment's set). Run `npm run build` first.
 */
import { execSync } from 'child_process';
import { createRequire } from 'node:module';
// The deployment's set, imported before the registry so the registry is built from it.
import './lib/deployment-profiles.mjs';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry.js';

const { resolveInstanceName } = createRequire(import.meta.url)('./lib/stack-lookup.cjs');
const { botIdFromArn } = createRequire(import.meta.url)('./lib/person-arn.cjs');

const [, , CLASSIFICATION_ARG, ROLE = 'ops'] = process.argv;
const CLASSIFICATION = CLASSIFICATION_ARG
  || profiles.classificationValues().find((c) => profiles.rolesFor(c).includes(ROLE));
// NOT DECLARED IS AN ANSWER, not an error: a deployment that names no assistant for the role holds none,
// and the phase that runs this says so rather than failing.
if (!CLASSIFICATION_ARG && !CLASSIFICATION) {
  console.log(`No classification this deployment declares holds the role "${ROLE}", so it is not deployed. Roll it out with:`);
  console.log('  npm run add-assistant-role');
  process.exit(0);
}
if (!CLASSIFICATION || !profiles.isKnownClassification(CLASSIFICATION)) {
  console.error(`✗ ${CLASSIFICATION ? `"${CLASSIFICATION}" is not a classification this deployment declares` : `no classification this deployment declares holds the role "${ROLE}"`}`);
  console.error('Usage: node scripts/show-ops-rollout.mjs [classification] [role]');
  process.exit(1);
}
const INSTANCE = resolveInstanceName(process.env);

/** Set once the CLI answers something other than "not found", so a credentials problem cannot be
 *  reported as an absent role. */
let awsReachable = false;

function aws(args) {
  try {
    const out = execSync(`aws ${args} --output json`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
    awsReachable = true;
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    // ABSENT IS AN ANSWER HERE, not an error: this script runs against deployments that never declared
    // the role, and it should say so rather than fail the phase that runs it.
    //
    // BUT ONLY "NOT FOUND" IS THAT ANSWER. Swallowing every failure meant a missing CLI, expired
    // credentials or the wrong region all printed "the role is not deployed" - the single wrong answer
    // a script whose whole premise is "read it back from AWS rather than from config" can give.
    const text = String(err?.stderr || err?.message || '');
    if (/ParameterNotFound|ResourceNotFound|NotFound/i.test(text)) awsReachable = true;
    else lastAwsError = text.split('\n').find((l) => l.trim()) || text;
    return null;
  }
}

let lastAwsError = '';

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(`── ${s} ${'─'.repeat(Math.max(0, 66 - s.length))}`); };

line(`\nROLLOUT OF (${CLASSIFICATION}, ${ROLE}) - read back from the deployment`);

// ── 1. THE ACTING ROLE ──────────────────────────────────────────────────────────────────────────
// ONE ROLE PER CLASSIFICATION, NOT ONE PER ASSISTANT (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
// Adding a role creates no IAM role: the classification's acting role accepts one more `role` session tag,
// and the statements that are the role's reach are conditioned on it. So this reads the one role back and
// shows exactly that: whether its trust admits the tag, and what it grants only to a session carrying it.
head(`1. The ${CLASSIFICATION} acting role, and what it grants the ${ROLE} role`);
const roles = aws(`iam list-roles --path-prefix /${INSTANCE}/assistant/ --query "Roles[].RoleName"`) || [];
// Generated names are truncated and carry no classification, so the role is found by the stack's
// `classification` tag, the same tag the vend invoke is scoped by.
const actingName = roles.filter((n) => /AssistantActingRole/.test(n)).find((n) => {
  const tags = aws(`iam list-role-tags --role-name ${n} --query "Tags"`) || [];
  return tags.some((t) => t.Key === 'classification' && t.Value === CLASSIFICATION);
});
const tagValues = (doc, key) => {
  const out = new Set();
  for (const st of [doc?.Statement ?? []].flat()) {
    for (const cond of Object.values(st.Condition || {})) {
      const v = cond?.[key];
      for (const x of [v ?? []].flat()) out.add(x);
    }
  }
  return [...out];
};
let admitsRole = false;
if (!actingName) {
  if (!awsReachable) {
    // SAY WHICH IT IS. "Not deployed" and "I could not ask" look identical from here and mean opposite
    // things to someone deciding whether the demo is broken.
    line('\n   COULD NOT READ THE DEPLOYMENT, so whether the role exists is unknown.');
    line(`   ${lastAwsError}`);
    line('   Check AWS_PROFILE, the region, and that the session has not expired.');
    line('');
    process.exit(0);
  }
  line(`   no acting role found for ${CLASSIFICATION}; the classification stack is not deployed.`);
  line('');
  process.exit(0);
}
const role = aws(`iam get-role --role-name ${actingName} --query "Role"`);
const admitted = tagValues(role?.AssumeRolePolicyDocument, 'aws:RequestTag/role');
admitsRole = admitted.includes(ROLE);
line(`   role       : ${actingName}`);
line(`   trust      : only the classification's vend; role tags admitted: ${admitted.join(', ') || '(none read)'}`);
const inline = aws(`iam list-role-policies --role-name ${actingName} --query "PolicyNames"`) || [];
const forRole = [];
for (const p of inline) {
  const doc = aws(`iam get-role-policy --role-name ${actingName} --policy-name ${p} --query "PolicyDocument"`);
  for (const st of [doc?.Statement ?? []].flat()) {
    if (tagValues({ Statement: [st] }, 'aws:PrincipalTag/role').includes(ROLE)) {
      forRole.push(`${st.Sid || '(no sid)'}: ${[st.Action].flat().join(', ')}`);
    }
  }
}
line(`   granted only to a session tagged role=${ROLE}:`);
for (const g of forRole) line(`     - ${g.slice(0, 150)}`);
if (!forRole.length) line('     (nothing: the role is not declared on this deployment)');

if (!admitsRole) {
  line(`\n   The ${ROLE} role is not deployed: the acting role's trust does not admit it. Roll it out with:`);
  line('     npm run add-assistant-role');
  line('');
  process.exit(0);
}

// ── 2. THE IDENTITY ─────────────────────────────────────────────────────────────────────────────
head('2. The assistant identity, and the Amazon Lex bot that makes it addressable');
// THE PROVISIONER'S, NOT THE STACK'S (ADR-048, amended 2026-10-23): the deploy seeded the role's declared
// assistant once, and its record and directory entry say so. A retire in the console sticks.
const ROLE_ASSISTANT = profiles.roleAssistantName(CLASSIFICATION, ROLE);
const raw = aws(`ssm get-parameter --name "/${INSTANCE}/assistant-assignments/${CLASSIFICATION}/${ROLE}/assistants/${ROLE_ASSISTANT}" --query "Parameter.Value"`);
const record = raw ? JSON.parse(raw) : {};
const entryRaw = aws(`ssm get-parameter --name "/${INSTANCE}/assistant-directory/${ROLE_ASSISTANT}" --query "Parameter.Value"`);
const entry = entryRaw ? JSON.parse(entryRaw) : {};
if (!record.botArn) {
  line(entry.status === 'retired'
    ? `   ${ROLE_ASSISTANT} is declared, but retired in the console; a deploy does not recreate it.`
    : `   ${ROLE_ASSISTANT} has no identity yet: the deploy that declares it seeds it.`);
}
if (record.botArn) {
  const bots = aws(`chime-sdk-identity describe-app-instance-bot --app-instance-bot-arn ${record.botArn} --query "AppInstanceBot.{Name:Name}"`);
  const tags = aws(`chime-sdk-identity list-tags-for-resource --resource-arn ${record.botArn} --query "Tags"`) || [];
  const tag = tags.find((t) => t.Key === 'classification');
  line(`   bot        : ${bots?.Name || '(unnamed)'}  ${botIdFromArn(record.botArn)}`);
  line(`   tagged     : classification=${tag?.Value || '(untagged)'}`);
  // THE LEX BOT IS THE CARRIER OF THE IDENTITY. Amazon Chime SDK tells a Lex turn which channel and
  // which sender, and NOT which assistant was addressed - so a role that shared its classification's
  // Lex bot could not be told apart from the primary, and the turn would answer as the wrong one.
  line(`   lex bot    : ${record.lexBotId || '(none - it would be indistinguishable from the primary)'}`);
  line(`   assistant  : ${record.assistant || '(unassigned)'}`);
  line(`   owned by   : the provisioner (${entry.origin === 'declared' ? 'declared in profiles, seeded once by a deploy' : 'created in the console'}); the console renames, owns and retires it`);
  line(`   acts as    : the ${CLASSIFICATION} acting role, on a session the vend tags role=${ROLE}, bot=<this bot>`);
}

// ── 3. THE PROFILE ──────────────────────────────────────────────────────────────────────────────
head('3. The profile - what the assistant DOES, editable with no deploy');
// GUARDED, or an assignment record without an assistant queries `/assistant/undefined/definition` and
// prints "no published version for undefined" - which reads as a naming bug rather than an empty assignment.
const defRaw = record.assistant
  ? aws(`ssm get-parameter --name "/${INSTANCE}/assistant/${record.assistant}/definition" --query "Parameter.Value"`)
  : null;
if (!record.assistant) {
  line('   the record names no assistant, so there is no profile to show. That is the between-battles');
  line('   state for an alt, and an unassigned state for any other role.');
} else if (!defRaw) {
  line(`   no published version for ${record.assistant}; the compiled seed is serving.`);
} else {
  const def = JSON.parse(defRaw);
  const version = aws(`ssm get-parameter --name "/${INSTANCE}/assistant/${record.assistant}/definition:active" --query "Parameter.Version"`);
  line(`   profile    : ${record.assistant}   active version ${version ?? '?'}   configId ${def.configId || '(unhashed)'}`);
  line(`   model      : ${def.modelKey || '(from seed)'}`);
  line(`   tools      : ${(def.tools || []).join(', ') || '(from seed - every registered tool)'}`);
  // THE WELCOME IS THE VERSION'S assistant-joined WORKFLOW (W1); the one that names no type answers in an ordinary room.
  const welcomes = Object.values(def.eventWorkflows || {}).filter((wf) => wf && wf.on === 'assistant-joined');
  const ordinary = welcomes.find((wf) => !(wf.types || []).length);
  const opening = ordinary && Object.values(ordinary.states || {}).find((d) => d && d.opening)?.opening;
  if (def.welcome) {
    line('   welcome    : a retired welcome field; run `npm run migrate-legacy-welcome` to carry it into its welcome workflows');
  } else if (opening && Object.keys(opening).length) {
    line('   welcome    : its own, so it introduces itself rather than the classification\'s primary');
    line(`                "${String(opening.companyBlurb || opening.text || '').slice(0, 88)}"`);
  } else {
    line('   welcome    : inherited from the classification (it will introduce itself as the primary)');
  }
}

// ── 4. THE CUT ──────────────────────────────────────────────────────────────────────────────────
head('4. What this role reaches that its classification\'s primary does not');
line('   CloudWatch metric and alarm READS and its own context prefixes, granted on the acting role only to a');
line('   session tagged with this role, and bounded by the classification boundary. The vend then narrows');
line('   each session to what the assistant\'s approved definition selects (session policies).');
line('   The deny-test in the `ops-role` phase proves the cut, in both directions, against these');
line('   same deployed documents - run it with: npm run validate -- --only=ops-role');

head('Rollback');
line('   npm run add-assistant-role -- --remove: the same stack deployed without the role\'s assistant in profiles.');
line('   The acting role stops admitting the tag,');
line('   and the bot, the Lex bot and the assignment record are removed with the stack. Conversation history is NOT removed, which');
line('   is correct: the archive records what happened, including turns this assistant answered.');
line('');
