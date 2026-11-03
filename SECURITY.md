# Security

kyoto runs adb commands against a TV on your local network. It doesn't open ports, run a server or contact anything except your TV.

Things to know:

- **adb over the network is unencrypted, and an authorized computer has full control of the TV.** Each computer must be approved on the TV once. Turn off USB/Wireless debugging when you're done if you share your network. kyoto works again as soon as you turn it back on.
- **`state/` contains device identifiers** (android_id, serial, MAC addresses). It's git-ignored; don't publish it.
- **Release APKs** are built by GitHub Actions from the tagged source. Build from source if you prefer.

To report a vulnerability, for example a way kyoto could be made to touch a lifeline package, please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
