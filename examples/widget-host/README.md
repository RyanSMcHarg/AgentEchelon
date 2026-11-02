# Sample widget host

A static page that embeds the assistant widget the way a host website does: it loads `embed.js` from the widget's origin and calls `AEWidget.mount()` in guest mode (`host.js`). It is served from an origin of its own, so the widget's `frame-ancestors` policy is exercised for real: the frame loads here only because the guest issuer declares this page among its hosts.

## Hosting

The page is hosted by the opt-in `<prefix>WidgetHost` stack (`backend/lib/stacks/widget-host-stack.ts`): a private S3 bucket behind its own CloudFront distribution, with origin access control and HTTPS only, built from the same `FrontendDistribution` construct as the chat app, the admin console and the widget.

A deployment asks for it by listing `"widget-host"` in the guest issuer's `allowedOrigins` in `deploy.config.json`. That value stands for the stack's own distribution origin, which the CDK app reads from the stack, so no domain is typed into the configuration. The widget's `frame-ancestors` names it; `PersonApi`'s CORS does not, because the page calls no API (the frame calls from the widget's origin). Synth refuses `"widget-host"` in production, on an issuer that is not the guest issuer, and without the `widget` capability. The example configuration is `backend/deploy.config.guest-widget.example.json`.

## Publishing

`npm run deploy` publishes the page after the widget when `"widget-host"` is declared. To publish it alone:

```bash
cd backend && node scripts/deploy-frontend.mjs --widget-host
```

It uploads this directory, except this README and `host-config.js`, and writes a `host-config.js` naming the widget's origin, read from the `<prefix>Widget` stack's `WidgetDistributionUrl` output. The page itself names no deployment.

## Local use

Set `widgetOrigin` in `host-config.js` to a widget served locally (for example `http://localhost:5175`) and serve this directory on another port. The local widget's frame policy is the dev server's, so a local run shows the page and the loader, not the deployed `frame-ancestors`.
