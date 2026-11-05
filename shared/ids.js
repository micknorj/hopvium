export function randomId(bytes = 12) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
