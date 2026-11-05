import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { discoveryAddress } from '../worker/address.js';
import { roomIdentifier } from '../worker/index.js';

const secret = 'synthetic-unit-test-secret-at-least-32-characters';

test('IPv6 discovery matches normalized /64 prefixes, including compressed addresses', async () => {
  for (const addresses of [
    ['2001:db8:abcd:1234::1', '2001:0DB8:ABCD:1234:ffff:abcd:5678:9abc', '2001:db8:abcd:1234::'],
    ['2001:db8::1', '2001:0db8:0:0:abcd::2', '2001:db8:0:0:0:0:0:1'],
    ['::', '::1', '0:0:0:0:ffff:ffff:ffff:ffff'],
    ['2001:db8::192.0.2.1', '2001:db8:0:0:0:0:c000:201'],
  ]) {
    const normalized = discoveryAddress(addresses[0]);
    const room = await roomIdentifier(addresses[0], secret);
    assert.match(room, /^[0-9a-f]{64}$/);
    assert.equal(room, createHmac('sha256', secret).update(normalized).digest('hex'));
    for (const address of addresses) {
      assert.equal(discoveryAddress(address), normalized);
      assert.equal(await roomIdentifier(address, secret), room);
    }
  }
  assert.equal(discoveryAddress('2001:db8::1'), 'ipv6:2001:0db8:0000:0000/64');
});

test('different IPv6 prefixes stay isolated and room identifiers remain secret-keyed', async () => {
  const room = await roomIdentifier('2001:db8:abcd:1234::1', secret);
  for (const address of ['2000:db8:abcd:1234::1', '2001:db9:abcd:1234::1', '2001:db8:abce:1234::1', '2001:db8:abcd:1235::1']) {
    assert.notEqual(await roomIdentifier(address, secret), room);
  }
  assert.notEqual(await roomIdentifier('2001:db8:abcd:1234::1', secret + '-other'), room);
});

test('IPv4 discovery preserves exact-address matching and stays separate from IPv6', async () => {
  const room = await roomIdentifier('203.0.113.1', secret);
  assert.equal(room, createHmac('sha256', secret).update('203.0.113.1').digest('hex'));
  assert.equal(await roomIdentifier('203.0.113.1', secret), room);
  for (const address of ['203.0.113.2', '203.0.114.1', '::ffff:203.0.113.1']) {
    assert.notEqual(await roomIdentifier(address, secret), room);
  }
  assert.equal(discoveryAddress('0.0.0.0'), '0.0.0.0');
  assert.equal(discoveryAddress('255.255.255.255'), '255.255.255.255');
});

test('malformed addresses cannot produce a discovery room', async () => {
  for (const address of [
    null, undefined, 123, '', 'example.com', '203.0.113', '203.0.113.256', '203.00.113.1',
    '203.0.113.1:80', ' 203.0.113.1', '203.0.113.1,198.51.100.1',
    '2001:db8:1:2:3:4:5', '2001:db8:1:2:3:4:5:6:7', '2001:db8:1:2:3:4:5:6::',
    '2001:db8::1::2', '2001:db8:::1', ':2001:db8:1:2:3:4:5', '2001:db8:1:2:3:4:5:',
    '2001:db8::gggg', '2001:db8::12345', '[2001:db8::1]', 'fe80::1%eth0', '2001:db8::1/64',
    '2001:db8::1\n', '::ffff:192.0.2.256', '::ffff:192.00.2.1', '192.0.2.1::',
  ]) {
    assert.equal(discoveryAddress(address), null, String(address));
    assert.equal(await roomIdentifier(address, secret), null, String(address));
  }
});
