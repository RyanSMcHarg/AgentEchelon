/**
 * THE SIGN-IN MAIL IS SENT BY NOTIFICATIONS (ADR-055: the only SES send grant is there).
 *
 * The invitation and claim functions in `Conversations` hand their one email to the `TransactionalMail`
 * function by its fixed name (`lambda/src/lib/transactional-mail.ts`). That function sends only the two
 * mails it knows, to a well-formed request, and the hand-off answers "not sent", never a throw, when the
 * deployment sends no email or the send failed, because each caller has an answer for an unsent link.
 */
import { invokeTransactionalMail, transactionalMailOf, type TransactionalMail } from '../../lambda/src/lib/transactional-mail';
import { handler } from '../../lambda/src/transactional-mail';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app';
const MAIL: TransactionalMail = {
  mail: 'invitation', personArn: `${APP}/user/invitee`, address: 'jordan@example.org', name: 'Jordan',
  channelArn: `${APP}/channel/conv-1`, link: 'https://widget.example.com/invite.html#t=abc', sender: 'Riley',
};

const lambdaAnswering = (answer: { Payload?: Uint8Array; FunctionError?: string } | Error) => {
  const calls: any[] = [];
  return {
    calls,
    send: async (cmd: { input: any }) => {
      calls.push(cmd.input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};
const payload = (v: unknown) => new Uint8Array(Buffer.from(JSON.stringify(v)));

describe('the transactional mail request', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('is an invitation or a claim, with person and conversation ARNs, an address and a link', () => {
    expect(transactionalMailOf(MAIL)).toEqual(MAIL);
    expect(transactionalMailOf({ ...MAIL, mail: 'claim' })).toEqual({ mail: 'claim', personArn: MAIL.personArn, address: MAIL.address, name: 'Jordan', channelArn: MAIL.channelArn, link: MAIL.link });
  });

  it.each([
    ['another kind of mail', { ...MAIL, mail: 'share' }],
    ['a person that is not an AppInstanceUser', { ...MAIL, personArn: 'someone' }],
    ['an address that is not one', { ...MAIL, address: 'not an address' }],
    ['a link that is not a web address', { ...MAIL, link: 'javascript:alert(1)' }],
    ['nothing', null],
  ])('refuses %s, and the function sends nothing', async (_why, input) => {
    expect(transactionalMailOf(input)).toBeNull();
    expect(await handler(input)).toEqual({ sent: false });
  });
});

describe('the hand-off from Conversations', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('invokes the named function with the mail and answers what it says', async () => {
    const lambda = lambdaAnswering({ Payload: payload({ sent: true }) });
    expect(await invokeTransactionalMail(MAIL, { lambda, functionName: 'AgentEchelonNotifications-TransactionalMail' })).toBe(true);
    expect(lambda.calls[0].FunctionName).toBe('AgentEchelonNotifications-TransactionalMail');
    expect(JSON.parse(Buffer.from(lambda.calls[0].Payload).toString())).toEqual(MAIL);
  });

  it('answers "not sent" without asking, and without a word, when the deployment sends no email', async () => {
    // No `notifications` declared: the function is named no mail sender, so each link is answered as not emailed.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lambda = lambdaAnswering({ Payload: payload({ sent: true }) });
    expect(await invokeTransactionalMail(MAIL, { lambda, functionName: '' })).toBe(false);
    expect(lambda.calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['AccessDeniedException', 'ResourceNotFoundException'])('says so when a named mail sender refuses the invoke (%s)', async (name) => {
    // A function is named only where `notifications` is declared, so a refusal there is a fault an operator reads.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lambda = lambdaAnswering(Object.assign(new Error('x'), { name }));
    expect(await invokeTransactionalMail(MAIL, { lambda, functionName: 'fn' })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be handed to Notifications'), expect.objectContaining({ mail: 'invitation', err: name }));
  });

  it.each([
    ['the mail was not sent', { Payload: payload({ sent: false }) }],
    ['the function failed', { FunctionError: 'Unhandled', Payload: payload({}) }],
    ['the invoke failed', Object.assign(new Error('x'), { name: 'TooManyRequestsException' })],
  ])('answers "not sent", never a throw, when %s', async (_why, answer) => {
    expect(await invokeTransactionalMail(MAIL, { lambda: lambdaAnswering(answer), functionName: 'fn' })).toBe(false);
  });
});
