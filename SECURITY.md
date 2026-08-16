# Security and privacy

TeamText handles phone numbers and personalized messages immediately before sending. Treat changes to roster parsing, message rendering, API routes, and the macOS sender as security-sensitive.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature if it is enabled for this repository. Otherwise, contact the repository maintainer privately before opening a public issue.

Do not include real names, phone numbers, email addresses, roster files, message bodies, Apple Account details, or screenshots containing conversations. Reproduce the problem with fabricated data such as the files under `examples/`.

## Deployment boundary

TeamText is a local-only utility. Its server binds to `127.0.0.1` and has no login system. Do not expose its ports through a public reverse proxy, router port forwarding, a shared LAN address, or a cloud server.

TeamText does not save roster or message history, but Apple Messages retains the conversations it sends. Keep the Mac, Apple Account, terminal, and repository dependencies updated.
