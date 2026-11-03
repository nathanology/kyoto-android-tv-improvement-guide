# Security

kyoto runs adb commands against a TV on your local network. It doesn't open ports, run a server or contact anything except your TV.

Things to know:

- **adb over the network is unencrypted, and an authorized computer has full control of the TV.** Each computer must be approved on the TV once. Turn off USB/Wireless debugging when you're done if you share your network. kyoto works again as soon as you turn it back on.
- **`state/` contains device identifiers** (android_id, serial, MAC addresses). It's git-ignored; don't publish it.
- **Shared profiles are untrusted input.** Profiles and catalog entries come from contributors, and their package names and setting keys are used in commands on your TV. kyoto only accepts plain identifiers there (checked on load and again before each command), so an entry like `com.app; reboot` is rejected. Still read a profile's `packages.json` before applying it.
- **Test fixtures are redacted.** Captured TV output passes through `cli/redact.ts`, and CI fails if a fixture contains a serial, MAC address, android_id, Netflix ESN or device name.
- **Build supply chain.** The Gradle wrapper jar is checked against Gradle's published checksums in CI, and the Gradle distribution is pinned by SHA-256. CI runs with a read-only token. Release APKs are built by GitHub Actions from the tagged source; build from source if you prefer.

To report a vulnerability, for example a way kyoto could be made to touch a lifeline package, please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
