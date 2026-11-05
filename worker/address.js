function ipv4Octets(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

// Normalize only trusted CF-Connecting-IP values; never accept a client room key.
export function discoveryAddress(address) {
  if (typeof address !== 'string') return null;
  if (!address.includes(':')) return ipv4Octets(address) ? address : null;
  if (!/^[0-9a-fA-F:.]+$/.test(address)) return null;

  // An embedded IPv4 tail occupies the final two IPv6 hextets.
  if (address.includes('.')) {
    const end = address.lastIndexOf(':');
    const octets = ipv4Octets(address.slice(end + 1));
    if (!octets) return null;
    address = address.slice(0, end + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const count = left.length + right.length;
  if ([...left, ...right].some(part => !/^[0-9a-fA-F]{1,4}$/.test(part)) ||
      (halves.length === 1 ? count !== 8 : count >= 8)) return null;
  const words = halves.length === 2 ? [...left, ...Array(8 - count).fill('0'), ...right] : left;
  return `ipv6:${words.slice(0, 4).map(word => word.toLowerCase().padStart(4, '0')).join(':')}/64`;
}
