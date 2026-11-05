# Hopvium

Part of Mick's Tools.

Hopvium transfers files directly between browsers. GitHub Pages hosts the website, while Cloudflare helps browsers discover each other and establish a WebRTC connection.

## Usage

1. Open Hopvium on both devices. Browsers with the same public IPv4 address or the same public IPv6 /64 prefix (first 64 bits) can discover each other automatically.
2. Select a nearby device by its temporary celestial name, then choose the files to send.
3. The recipient reviews the files and selects **Accept** or **Decline**. File contents are sent only after acceptance.
4. Received files trigger individual browser downloads where permitted. If a download is blocked, use its download link. Select **Done** to clear the temporary downloads and return to discovery.

For additional assurance, both users can compare the connection's security code through a separate trusted channel. Verification is optional; a celestial name alone does not identify a trusted device.

## Features

- Automatic discovery for up to eight connected browsers per room.
- Temporary celestial names that are not reused during a room's lifetime.
- One approval for a batch of up to 256 files.
- Direct, encrypted WebRTC transfers without a file relay.
- Original file bytes and filenames, without compression or conversion.
- Individual downloads, transfer progress, cancellation, and manual restart after interruptions.
- Dark-only interface with keyboard support.
- No accounts, analytics, transfer history, or persistent device identities.

## Privacy

Cloudflare groups browsers by exact public IPv4 address or by the first 64 bits of their public IPv6 addresses, and exchanges information needed to establish a WebRTC connection. IPv6 addresses are normalized so compressed and expanded representations of the same prefix match. Hopvium derives room identifiers using HMAC-SHA256 with a secret key; it does not expose IP addresses or prefixes in room identifiers or the user interface. Cloudflare STUN helps establish direct connections; Hopvium does not configure a TURN relay.

File metadata and contents are exchanged between browsers over the WebRTC DataChannel, not through Hopvium's Cloudflare signaling service. The application has no server-side file-upload or storage feature. It does not scan or alter transferred files.

GitHub may process website access information. Cloudflare may observe public IP addresses, connection activity, room associations, and signaling or STUN metadata. WebRTC peers may also learn each other's network addresses. Infrastructure logging and retention by these providers are outside Hopvium's control.

Hopvium does not create cookies, store browser preferences or transfer history, or collect application analytics. Temporary download links are cleared when the page closes. Cloudflare keeps active room information until that room ends. Optional code comparison helps verify a connection, but unverified devices should not be treated as trusted.

## Limitations

- Sharing a public IPv4 address or IPv6 /64 prefix does not prove device identity, physical proximity, or membership in the same local network. Unrelated devices may be grouped together. Devices on the same Wi-Fi may not appear if they use different prefixes or address families (IPv4 versus IPv6).
- Direct WebRTC connections can fail on restrictive networks. There is no relay fallback.
- Hopvium sets no artificial file-size limit. Received files use browser memory, so transfers depend on available device and browser resources.
- File batches are limited to 256 files and must fit the transfer protocol's metadata limits.
- Browsers may block automatic or multiple downloads. Download initiation does not confirm that a file was saved.
- Transfers can stop when a browser is suspended, a connection drops, or the page closes. Interrupted transfers must be restarted manually.
- Browser behavior varies. Real-device testing, particularly on iOS Safari, is still necessary.

## Local development

Requires Node.js 22.20 or newer and npm.

```sh
npm ci --ignore-scripts
npm run dev
```

Open `http://127.0.0.1:8788/hopvium/`. Local development runs the frontend and a local Cloudflare Worker; it does not require a Cloudflare account. Temporary secrets, runtime state, and test files are stored in the ignored `.private/` directory.

In a separate terminal, with the development server running for integration tests:

```sh
npm run check
npm test
npm run test:integration
npm run build
```

Browser tests are optional and require Playwright-managed browsers:

```sh
npm run browsers:install
npm run test:browser
```

The build creates the ignored `dist/` directory for publishing at `/hopvium/`. Browser test results and downloads stay in `.private/`.

## Deployment

The repository owner manages deployment.

1. Confirm `ALLOWED_ORIGINS` in `worker/wrangler.jsonc` matches the website's origin (`https://micknorj.github.io`).
2. Generate a private random secret and add it to Cloudflare as `ROOM_HMAC_KEY`:

   ```sh
   npx wrangler secret put ROOM_HMAC_KEY --config worker/wrangler.jsonc
   ```

3. Deploy the signaling Worker:

   ```sh
   npx wrangler deploy --config worker/wrangler.jsonc
   ```

4. In the GitHub repository, create an **Actions repository variable** named `HOPVIUM_SIGNAL_URL` with the value `wss://YOUR-WORKER.workers.dev/signal`.
5. In **Settings → Pages**, choose **GitHub Actions**. Manually run **Publish GitHub Pages (owner initiated)** from the Actions tab.
6. Test discovery, acceptance, downloads, and direct connections on the deployed website using two real devices.

Keep the Cloudflare secret out of source code, GitHub Pages variables, and commits. The Pages workflow publishes only when manually started.

Before committing, inspect `git status --short --untracked-files=all`, `git diff --cached --name-only`, and `git diff --cached --check`. Do not publish `.private/`, `node_modules/`, `dist/`, local environment files, or credentials.

## Third-party software

Hopvium's frontend and Worker have no npm runtime dependencies. Development uses [Wrangler](https://github.com/cloudflare/workers-sdk) (MIT OR Apache-2.0), [Playwright](https://github.com/microsoft/playwright) (Apache-2.0), and [ws](https://github.com/websockets/ws) (MIT). They are not bundled into the deployed website. Their licenses are included with their installed packages.

Hopvium is an independent implementation. No PairDrop or LocalSend Web source code is included.

## License

Licensed under the [MIT License](LICENSE). This license applies to Hopvium's code, not to the files people transfer.