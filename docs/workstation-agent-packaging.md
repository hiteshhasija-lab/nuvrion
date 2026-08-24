# Workstation Agent release packaging

Build the Windows executable in an isolated release environment, sign it with the organization code-signing certificate, and verify its Authenticode chain before packaging. Place only runtime files in a staging directory; never include enrollment tokens, local configuration, signing private keys, or development artifacts.

Create a platform-bound package with `node tools/package-workstation-agent.js create <staging-directory> <output.nuvpkg> <semantic-version> <x64|arm64>`. The command requires `NUVRION_AGENT_SIGNING_PRIVATE_KEY` and `NUVRION_AGENT_SIGNING_PUBLIC_KEY`. Verification uses the same command with `verify`, the source-directory argument retained for command compatibility, and only the public key present.

The signed manifest fixes the package format, version, Windows target architecture, signing-key identity, allowed paths, file modes, sizes, and SHA-256 digests. Verification rejects target mismatches, path traversal, duplicate paths, modified files, and unsigned extra content. Publish the verified `.nuvpkg` over HTTPS, register its outer SHA-256 and size through the existing upgrade-release API, then use a staged rollout. Keep the signing private key in a release HSM or signing service and distribute the public trust key separately.

For first installation, extract a verified package into the protected installation directory and run `install.ps1` as an administrator. The installer refuses non-HTTPS platform URLs, restricts directory permissions, runs under LocalService, and now requires a valid Authenticode signature before service creation.
