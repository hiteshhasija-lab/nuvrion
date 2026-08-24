# RC1 environment decisions

The local release repository is initialized on branch `main`. The selected container registry is GitHub Container Registry. The RC1 staging target is VMware, and the confirmed staging hostname is `nuvrion.lab.sps`. Hitesh Hasija owns secrets and signing and is the named product, documentation, operations, and security approver for this initial lab release.

`deploy/rc1-target.yaml` records these decisions without credentials. The selected GitHub repository is `hiteshhasija-lab/nuvrion`, and the confirmed staging hostname matches the Nuvrion product spelling.

The manual `rc1-container` workflow defaults to build-only. Publishing must be explicitly enabled, and it targets `ghcr.io/<github-owner>/<repository>:0.1.0-rc.1`. It requires an approved Node base image by immutable digest, runs verification and the repository secret scan, creates provenance and the application SBOM, builds as the non-root `node` user, and only then optionally pushes with the short-lived GitHub token. It does not scan, sign, attest, or deploy the resulting image; those external gates remain mandatory.

Create the GitHub repository under the chosen personal account or organization, configure branch protection for `main`, require the `ci` check, restrict workflow and package write permissions, and review repository administrators. Before the first publish, pin every referenced GitHub Action to an approved immutable commit SHA under organizational policy.

For VMware staging, place the endpoint, username, and password in the approved secret manager under the references recorded in `deploy/rc1-target.yaml`. Use a non-production VMware account with the minimum permissions required for inventory and the explicitly approved VM lifecycle operations. Do not paste the account password into source files, GitHub variables, issue text, workflow inputs, or chat.
