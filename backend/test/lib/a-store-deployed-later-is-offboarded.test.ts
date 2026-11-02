/**
 * A STORE WHOSE STACK DEPLOYS AFTER OFFBOARDING'S IS STILL OFFBOARDED, IN THE SAME CONTAINER.
 *
 * Offboarding reads each store's name from SSM on use (`storeNamesReader`, lib/offboarding.ts). A store not
 * deployed yet has no parameter. Remembering that absence for the container's lifetime skipped the store
 * on every offboarding after its stack deployed, which answered 200 having removed nothing from it.
 */
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { storeNamesReader } from '../../lambda/src/lib/offboarding';

const notFound = () => Object.assign(new Error('missing'), { name: 'ParameterNotFound' });

function ssm(published: Record<string, string>) {
  const send = jest.fn(async (cmd: unknown) => {
    const name = (cmd as GetParameterCommand).input.Name as string;
    if (!(name in published)) throw notFound();
    return { Parameter: { Value: published[name] } };
  });
  return { send };
}

const PARAMS = {
  userProfile: '/ae/user-profile-name',
  turnState: '/ae/turn-state-name',
  attachmentsBucket: '/ae/attachments-bucket-arn',
};

describe('the stores offboarding removes from', () => {
  it('reads a store again once its parameter is published, without a cold start', async () => {
    const published: Record<string, string> = { '/ae/user-profile-name': 'UserProfile' };
    const client = ssm(published);
    const stores = storeNamesReader(client, PARAMS);

    expect(await stores()).toEqual({ userProfile: 'UserProfile' });

    // The turn-state stack and the bucket deploy afterwards.
    published['/ae/turn-state-name'] = 'TurnState';
    published['/ae/attachments-bucket-arn'] = 'arn:aws:s3:::attachments-bucket';
    expect(await stores()).toEqual({ userProfile: 'UserProfile', turnState: 'TurnState', attachmentsBucket: 'attachments-bucket' });
  });

  it('keeps a name once found, so a found store costs no read after', async () => {
    const client = ssm({ '/ae/user-profile-name': 'UserProfile', '/ae/turn-state-name': 'TurnState', '/ae/attachments-bucket-arn': 'arn:aws:s3:::b' });
    const stores = storeNamesReader(client, PARAMS);
    await stores();
    client.send.mockClear();
    expect(await stores()).toEqual({ userProfile: 'UserProfile', turnState: 'TurnState', attachmentsBucket: 'b' });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('throws on a read that fails for any other reason, and reads again next time', async () => {
    const client = { send: jest.fn().mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' })).mockResolvedValue({ Parameter: { Value: 'UserProfile' } }) };
    const stores = storeNamesReader(client, { userProfile: '/ae/user-profile-name' });
    await expect(stores()).rejects.toThrow('denied');
    expect(await stores()).toEqual({ userProfile: 'UserProfile' });
  });

  it('a store with no parameter configured is absent, and is never read', async () => {
    const client = ssm({});
    expect(await storeNamesReader(client, { userTasks: undefined })()).toEqual({});
    expect(client.send).not.toHaveBeenCalled();
  });
});
