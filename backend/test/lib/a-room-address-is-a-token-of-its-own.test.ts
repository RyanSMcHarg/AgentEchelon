/**
 * `@all` AND `@humans` ADDRESS THE ROOM ONLY AS TOKENS OF THEIR OWN. An email address that contains one addresses nobody:
 * it starts no silence in a one-to-one and emails no membership. Written anywhere else in a message, as a word, it does.
 */
import { addressesTheRoom, matchesAtAll, matchesAtHumans, stripRoomAddress } from '../../lambda/src/lib/flow-bypass';

describe('a room address is a token of its own', () => {
  it.each(['@all please read', 'please read @all', '@humans over to you', 'over to you,\n@humans', 'hello @ALL.', '(@all) please read', 'Morning @all.Please read the plan', '**@all**', 'cc:@humans'])('%s addresses the room', (text) => {
    expect(addressesTheRoom(text)).toBe(true);
  });

  it.each(['please email ops@humans.example', 'write to x@all.example', '@allison can you look', '@humansfirst', '@all-hands is at 3', '@humans-team please look'])('%s does not', (text) => {
    expect(addressesTheRoom(text)).toBe(false);
  });

  it('an address inside an email address is not read as @humans', () => {
    expect(matchesAtHumans('please email ops@humans.example')).toBe(false);
    expect(matchesAtAll('write to x@all.example')).toBe(false);
  });

  it('removing the audience leaves an email address in the message whole', () => {
    expect(stripRoomAddress('@all write to ops@humans.example')).toBe('write to ops@humans.example');
  });
});
