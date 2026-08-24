# RC1 Workstation Agent release qualification

Qualify each Windows architecture independently. Build the executable from the immutable RC commit in the approved release environment, sign it with the organizational Authenticode certificate and trusted timestamp service, verify the certificate chain and timestamp offline, then create and verify the architecture-bound `.nuvpkg`. Record executable and package SHA-256 values and sizes before publication.

Scan the exact `.nuvpkg` digest with the approved malware scanner and current definitions. In an isolated Windows test endpoint, verify clean installation, LocalService identity, restrictive filesystem permissions, one-time enrollment, heartbeat health, inventory, lifecycle command execution, staged upgrade, forced health-check failure with automatic rollback, and clean uninstall. Confirm bootstrap material and operational secrets are removed according to policy and that the endpoint never connects to production.

Copy `deploy/agent-release-evidence.example.json` for each architecture, retain sanitized logs and screenshots in the referenced evidence location, and evaluate it with `node tools/evaluate-agent-release.js <evidence.json> [report.json]`. Evidence older than seven days is rejected. Package verification must match the same version, architecture, SHA-256, and Ed25519 signing-key identity recorded by the release.

Do not export code-signing private keys or release-signing private keys into the repository, agent package, application host, or evidence archive. Publication remains blocked until both the Authenticode and `.nuvpkg` trust chains verify and all install, upgrade, rollback, cleanup, and isolation checks pass.
