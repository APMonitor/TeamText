# Contributing to TeamText

Use fabricated roster data for development and issue reports. Never commit a real roster, phone number list, message export, database, or screenshot of Messages.

## Local checks

```bash
npm ci
npm run setup:python
npm run check
npm run test:dry-run
```

The smoke test always starts the sender with `SMS_DRY_RUN=1`. Do not automate live Messages sends in tests or continuous integration.

Changes to the macOS sender should preserve safe pause/stop boundaries, the frontmost-Messages check, clipboard restoration, and privacy-safe result payloads. Test user-interface changes at desktop and narrow viewport widths.
