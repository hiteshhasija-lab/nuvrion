# RC1 image supply-chain gate

After the approved pipeline builds and publishes the immutable application image, normalize its evidence using `deploy/supply-chain-evidence.example.json` and run `node tools/evaluate-supply-chain.js <evidence.json> [report.json]`. The command returns a nonzero status until every gate passes.

Evidence must be no older than 24 hours and bind the same immutable image digest and source revision to both an application dependency SBOM and a base-image operating-system SBOM, scanner findings, a verified organizational signature with transparency-log evidence, and verified build provenance. High and critical findings block staging unless each has a documented owner, rationale, approval reference, and unexpired exception. Exceptions for absent findings are rejected.

Scanner adapters should normalize severities to `unknown`, `low`, `medium`, `high`, or `critical` and retain original scanner output alongside the normalized file. An exception is not remediation: use the shortest practical expiry, track the corrective release, and repeat scanning whenever the image, base image, lockfile, advisory database, or scanner policy changes.

Do not place signing credentials in this repository or on application hosts. Signing and verification must occur in the approved release environment. Only the sanitized evidence, SBOMs, scan reports, signature identity, transparency reference, and provenance reference should be retained with RC artifacts.
